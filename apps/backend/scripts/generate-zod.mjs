#!/usr/bin/env node
/**
 * Regenerates `src/generated/zod/index.ts` from `prisma/schema.prisma`.
 *
 * Upstream's file came out of a zod generator (17,534 lines, every model plus every
 * Prisma input/aggregate/relation type). The replica only needs the model schemas the
 * route layer derives its request/response schemas from, so this small script emits
 * exactly those, with the same export names.
 *
 * Usage: pnpm --filter @relayx/backend zod:generate
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "prisma", "schema.prisma");
const outPath = join(here, "..", "src", "generated", "zod", "index.ts");

const PRIMITIVES = {
  Int: "z.number().int()",
  Float: "z.number()",
  String: "z.string()",
  Boolean: "z.boolean()",
  DateTime: "z.date()",
  Json: "jsonSchema",
};

const source = readFileSync(schemaPath, "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

const enums = [...source.matchAll(/^enum (\w+)/gm)].map((m) => m[1]);
const models = [...source.matchAll(/^model (\w+)/gm)].map((m) => m[1]);
const modelSet = new Set(models);

/** @param {string} type @param {boolean} optional */
function toZod(type, optional) {
  const base = PRIMITIVES[type] ?? `z.nativeEnum(${type})`;
  return optional ? `${base}.nullable()` : base;
}

const lines = [
  "/**",
  " * Zod schemas mirroring the Prisma models.",
  " *",
  " * GENERATED FILE — do not edit by hand. Run `pnpm --filter @relayx/backend zod:generate`",
  " * (scripts/generate-zod.mjs) after changing prisma/schema.prisma.",
  " *",
  " * Upstream ships `src/generated/prisma/zod/index.ts` — a 17,534-line file emitted by a",
  " * zod generator. The replica keeps the same export names (`TunnelSchema`, `UserSchema`,",
  " * …) but models scalar columns only: the upstream file additionally emitted every",
  " * relation and every Prisma input/aggregate type, none of which the replica's route",
  " * layer consumes (see docs/DEVIATIONS.md §4).",
  " */",
  'import { z } from "zod";',
  "import {",
  ...enums.map((e) => `  ${e},`),
  '} from "@prisma/client";',
  "",
  "/** The `Json` column type: any JSON value. */",
  "export const jsonSchema: z.ZodType<unknown> = z.any();",
  "",
];

for (const name of models) {
  const body = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(source)?.[1] ?? "";
  const fields = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("@@")) continue;
    const [field, rawType] = line.split(/\s+/);
    const type = rawType.replace(/[?[\]]/g, "");
    if (modelSet.has(type)) continue;
    fields.push(`  ${field}: ${toZod(type, rawType.includes("?"))},`);
  }
  lines.push(`export const ${name}Schema = z.object({`, ...fields, "});", "");
  lines.push(`export type ${name} = z.infer<typeof ${name}Schema>;`, "");
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"));
console.log(`generated ${outPath} (${lines.length} lines)`);
