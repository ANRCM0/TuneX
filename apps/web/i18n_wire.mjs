/**
 * Replace hard-coded Chinese literals with t(<key>) using the extracted dictionary.
 * Uses the TypeScript AST so only real string/JSX-text nodes are touched.
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/workspace/111/relayx/apps/web/src";
const DICT = JSON.parse(fs.readFileSync("/workspace/111/relayx-web/artifacts/i18n-zh-CN.json", "utf8"));
const CJK = /[\u4e00-\u9fff]/;

// text -> key
const byText = new Map();
for (const e of DICT.strings) byText.set(e.zh, e.key);
// also map trimmed variants
for (const e of DICT.strings) {
  const t = e.zh.trim();
  if (!byText.has(t)) byText.set(t, e.key);
}

function walkFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let stats = { files: 0, replaced: 0, skippedTemplate: 0, missingImport: 0, filesChanged: 0 };

for (const file of walkFiles(ROOT)) {
  if (file.includes("/lib/i18n/")) continue;              // the dictionary itself
  const text = fs.readFileSync(file, "utf8");
  if (!CJK.test(text)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const edits = [];   // {start, end, replacement}

  const isJsxAttrValue = (node) =>
    node.parent && node.parent.kind === ts.SyntaxKind.JsxAttribute && node.parent.initializer === node;

  const record = (node, raw) => {
    const trimmed = raw.trim();
    if (!byText.has(trimmed) || trimmed.length < 2) return false;
    const key = byText.get(trimmed);
    const repl = isJsxAttrValue(node) ? `{t("${key}")}` : `t("${key}")`;
    edits.push({ start: node.getStart(sf), end: node.getEnd(), replacement: repl });
    return true;
  };

  const visit = (node) => {
    // skip imports/exports and property names
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isPropertyAssignment(node) && node.name === node.name && ts.isStringLiteral(node.name)) {
      // property key like { "中文": 1 } — leave alone
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isPropName = node.parent && (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node;
      const isTypePos = node.parent && (ts.isLiteralTypeNode(node.parent) || ts.isTypeReferenceNode(node.parent));
      if (!isPropName && !isTypePos) {
        if (record(node, node.text)) stats.replaced++;
      }
      return;
    }
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const trimmed = raw.trim();
      if (trimmed && byText.has(trimmed)) {
        const leading = raw.match(/^\s*/)[0];
        const trailing = raw.match(/\s*$/)[0];
        edits.push({ start: node.getStart(sf), end: node.getEnd(), replacement: `${leading}{t("${byText.get(trimmed)}")}${trailing}` });
        stats.replaced++;
      }
      return;
    }
    if (ts.isTemplateExpression(node)) { stats.skippedTemplate++; return; }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length === 0) continue;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);

  // ensure import
  if (!out.includes('from "@/lib/i18n/zh-CN"')) {
    const importLine = 'import { t } from "@/lib/i18n/zh-CN";\n';
    const m = out.match(/^(?:"use client";\n|'use client';\n)?/);
    const idx = m ? m[0].length : 0;
    out = out.slice(0, idx) + importLine + out.slice(idx);
    stats.missingImport++;
  }
  fs.writeFileSync(file, out);
  stats.filesChanged++;
  stats.files++;
}

console.log(JSON.stringify(stats, null, 1));
