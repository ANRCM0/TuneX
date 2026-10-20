#!/usr/bin/env node
/**
 * Apply a key-rename map ({ oldKey: newKey }) to the dictionary modules and to every
 * call site. Used both for the curated semantic names and for future bulk renames.
 *
 *   node tools/i18n-rename.mjs path/to/map.json
 */
import fs from "node:fs";
import path from "node:path";

const mapPath = process.argv[2];
if (!mapPath) {
  console.error("usage: node tools/i18n-rename.mjs <map.json>");
  process.exit(1);
}
const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
const entries = Object.entries(map).filter(([a, b]) => a && b && a !== b);
const byOld = new Map(entries);

const ROOT = path.resolve("src");
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let changedFiles = 0;
let changedRefs = 0;

for (const file of walk(ROOT)) {
  let text = fs.readFileSync(file, "utf8");
  const before = text;
  for (const [oldKey, newKey] of entries) {
    // dictionary entries:  "oldKey": "…"
    text = text.replaceAll(`"${oldKey}":`, `"${newKey}":`);
    // call sites: t("oldKey") / tf("oldKey" / tr("oldKey"
    const re = new RegExp(`\\b(t|tf|tr)\\("${oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
    text = text.replace(re, (m, fn) => `${fn}("${newKey}"`);
  }
  if (text !== before) {
    fs.writeFileSync(file, text);
    changedFiles++;
    for (const [oldKey] of entries) {
      const n = (before.match(new RegExp(`"${oldKey}"`, "g")) || []).length;
      changedRefs += n;
    }
  }
}
console.log(JSON.stringify({ renamed: entries.length, changedFiles, changedRefs }, null, 1));
