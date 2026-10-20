/**
 * Dictionary integrity for the rebuilt console (`apps/web/src/lib/i18n`).
 *
 * Three invariants:
 *   1. every key used through `t()` / `tf()` in the source exists in zh-CN (a missing key
 *      would render the raw id in the UI);
 *   2. keys are unique per area and the en dictionary only contains keys that zh-CN has
 *      (so `t()` can fall back deterministically);
 *   3. no Chinese literal survives outside the dictionary, comments and the five
 *      regexes that match backend error messages (reports/10 U1 — the backend sends
 *      Chinese error strings, so those patterns must stay literal).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { messages } from "../../apps/web/src/lib/i18n/zh-CN";
import { messages as en } from "../../apps/web/src/lib/i18n/en";

const SRC = join(process.cwd(), "apps/web/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const sources = files.map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

describe("dictionary", () => {
  it("holds the recovered message set plus the reconstruction additions", () => {
    const count = Object.values(messages).reduce((n, table) => n + Object.keys(table).length, 0);
    expect(count).toBeGreaterThan(2000);
  });

  it("has no duplicate keys across areas", () => {
    const seen = new Map<string, string>();
    for (const [area, table] of Object.entries(messages)) {
      for (const key of Object.keys(table)) {
        const previous = seen.get(key);
        expect(previous, `${key} in both ${previous} and ${area}`).toBeUndefined();
        seen.set(key, area);
      }
    }
  });

  it("resolves every key used through t()/tf() in the source", () => {
    const missing: string[] = [];
    for (const { file, text } of sources) {
      if (file.includes("/lib/i18n/")) continue;
      for (const m of text.matchAll(/\b(?:t|tf|tr)\("([A-Za-z0-9_.{}-]+)"/g)) {
        const key = m[1];
        if (key.startsWith("enum.")) continue;
        const inAnyArea = Object.values(messages).some((table) => key in (table as Record<string, string>));
        if (!inAnyArea) missing.push(`${relative(process.cwd(), file)} → ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("only translates keys that zh-CN defines", () => {
    const zh = new Set(Object.values(messages).flatMap((t) => Object.keys(t)));
    const orphans = Object.keys(en).filter((k) => !k.startsWith("enum.") && !zh.has(k));
    expect(orphans).toEqual([]);
  });
});

describe("no hard-coded Chinese in code", () => {
  const CJK = /[\u4e00-\u9fff]/;
  it("leaves only comments and the backend-error regexes", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      if (file.includes("/lib/i18n/")) continue;
      text.split("\n").forEach((line, i) => {
        if (!CJK.test(line)) return;
        const trimmed = line.trim();
        const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
        const isRegex = /\/[^/]*[\u4e00-\u9fff][^/]*\/[gimsuy]*/.test(trimmed);
        if (!isComment && !isRegex) offenders.push(`${relative(process.cwd(), file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
