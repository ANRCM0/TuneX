#!/usr/bin/env node
/** Report dictionary size, area split, semantic-key ratio and en coverage. */
import fs from "node:fs";

const zh = fs.readFileSync("src/lib/i18n/zh-CN.ts", "utf8");
const en = fs.readFileSync("src/lib/i18n/en.ts", "utf8");

const zhKeys = [...zh.matchAll(/^    "([^"]+)":/gm)].map((m) => m[1]);
const enKeys = [...en.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
const areas = [...zh.matchAll(/^  "([^"]+)": \{\n/gm)].map((m) => m[1]);

const isSemantic = (k) => k.includes(".");
const semantic = zhKeys.filter(isSemantic);
const enumKeys = enKeys.filter((k) => k.startsWith("enum."));
const enFlat = enKeys.filter((k) => !k.startsWith("enum."));
const resolved = enFlat.filter((k) => zhKeys.includes(k));

const byArea = {};
for (const area of areas) {
  const start = zh.indexOf(`  "${area}": {`);
  const next = zh.indexOf("\n  },", start);
  const body = zh.slice(start, next);
  byArea[area] = [...body.matchAll(/^    "([^"]+)":/gm)].length;
}

console.log(JSON.stringify({
  keys: zhKeys.length,
  areas: areas.length,
  semanticKeys: semantic.length,
  hashKeys: zhKeys.length - semantic.length,
  semanticPercent: Math.round((semantic.length / zhKeys.length) * 1000) / 10,
  en: { flat: enFlat.length, enum: enumKeys.length, resolved: resolved.length, percent: Math.round((resolved.length / zhKeys.length) * 1000) / 10 },
  topAreas: Object.entries(byArea).sort((a, b) => b[1] - a[1]).slice(0, 8),
}, null, 1));
