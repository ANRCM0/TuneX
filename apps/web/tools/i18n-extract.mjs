#!/usr/bin/env node
/**
 * Extract Chinese literals that are not yet in the dictionary, append them as
 * `app-authored` keys, then rewrite the source through the i18n runtime.
 *
 * Safe by construction:
 *   - only StringLiteral / NoSubstitutionTemplateLiteral / JsxText nodes are touched;
 *   - comments, regex literals, imports and type positions are skipped;
 *   - template literals with ${} are left alone (use tf() manually);
 *   - a file that already binds a local `t` imports the runtime as `tr` instead.
 *
 * Usage: node tools/i18n-extract.mjs [--dry]
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve("src");
const DICT_PATH = path.resolve("src/lib/i18n/zh-CN.ts");
const CJK = /[\u4e00-\u9fff]/;
const dry = process.argv.includes("--dry");

const keyFor = (text) =>
  `${(text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 24) || "zh")}_${crypto
    .createHash("sha1")
    .update(text)
    .digest("hex")
    .slice(0, 6)}`;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes(`${path.sep}lib${path.sep}i18n${path.sep}`));

// 1) collect every Chinese literal still present
const found = new Map(); // text -> [files]
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (!CJK.test(text)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text.trim();
      if (CJK.test(v) && v.length > 1) {
        const isName =
          node.parent &&
          (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
          node.parent.name === node;
        if (!isName) {
          if (!found.has(v)) found.set(v, []);
          found.get(v).push(file);
        }
      }
      return;
    }
    if (ts.isJsxText(node)) {
      const v = node.getText(sf).trim();
      if (CJK.test(v) && v.length > 1) {
        if (!found.has(v)) found.set(v, []);
        found.get(v).push(file);
      }
      return;
    }
    if (ts.isTemplateExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 2) which of them are already dictionary values?
let dict = fs.readFileSync(DICT_PATH, "utf8");
const existingByText = new Map();
for (const m of dict.matchAll(/^    "([^"]+)": "((?:[^"\\]|\\.)*)",$/gm)) {
  existingByText.set(JSON.parse(`"${m[2]}"`), m[1]);
}

const additions = new Map(); // text -> key
for (const [text] of found) {
  if (existingByText.has(text)) continue;
  additions.set(text, keyFor(text));
}

console.log(JSON.stringify({ literals: found.size, newKeys: additions.size }, null, 1));
if (dry) process.exit(0);

// 3) append new keys to the dictionary (app area)
if (additions.size) {
  const lines = [...additions.entries()].map(([text, key]) => `    "${key}": ${JSON.stringify(text)},`).join("\n");
  const idx = dict.indexOf('"app": {');
  if (idx < 0) {
    dict = dict.replace("export const messages = {", `export const messages = {\n  "app": {\n${lines}\n  },`);
  } else {
    const insertAt = dict.indexOf("{", idx) + 2;
    dict = dict.slice(0, insertAt) + lines + "\n" + dict.slice(insertAt);
  }
  fs.writeFileSync(DICT_PATH, dict);
  for (const [text, key] of additions) existingByText.set(text, key);
}

// 4) rewrite call sites
let changed = 0;
let replaced = 0;
for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  if (!CJK.test(original)) continue;
  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const shadowsT = /(?:const|let|var)\s+t\s*=/.test(original);
  const fn = shadowsT ? "tr" : "t";
  const edits = [];

  const record = (node, raw) => {
    const trimmed = raw.trim();
    if (!existingByText.has(trimmed) || trimmed.length < 2) return false;
    const key = existingByText.get(trimmed);
    const isAttr =
      node.parent && ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
    edits.push({
      start: node.getStart(sf),
      end: node.getEnd(),
      replacement: isAttr ? `{${fn}("${key}")}` : `${fn}("${key}")`,
    });
    return true;
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isName =
        node.parent &&
        (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
        node.parent.name === node;
      const isType = node.parent && (ts.isLiteralTypeNode(node.parent) || ts.isTypeReferenceNode(node.parent));
      if (!isName && !isType && record(node, node.text)) replaced++;
      return;
    }
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const trimmed = raw.trim();
      if (trimmed && existingByText.has(trimmed)) {
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          replacement: `${lead}{${fn}("${existingByText.get(trimmed)}")}${trail}`,
        });
        replaced++;
      }
      return;
    }
    if (ts.isTemplateExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) continue;
  edits.sort((a, b) => b.start - a.start);
  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);

  const importSpec = shadowsT ? 'import { t as tr } from "@/lib/i18n";' : 'import { t } from "@/lib/i18n";';
  if (!out.includes('from "@/lib/i18n"')) {
    const m = out.match(/^(?:"use client";\n|'use client';\n)?/);
    const at = m ? m[0].length : 0;
    out = out.slice(0, at) + importSpec + "\n" + out.slice(at);
  } else if (shadowsT && !out.includes("t as tr")) {
    out = out.replace(/import \{ ([^}]+) \} from "@\/lib\/i18n";/, (m, names) =>
      `import { ${names.split(",").map((s) => s.trim()).filter((s) => s && s !== "t").concat("t as tr").join(", ")} } from "@/lib/i18n";`,
    );
  }

  fs.writeFileSync(file, out);
  changed++;
}
console.log(JSON.stringify({ filesChanged: changed, replacements: replaced }, null, 1));
