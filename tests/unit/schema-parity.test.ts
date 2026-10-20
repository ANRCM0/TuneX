/**
 * Schema parity and generator drift.
 *
 * `docs/PARITY.md` listed "Zod nullability was not diffed for every schema" as an
 * open caveat. This suite closes it, and does so against the stronger source: the
 * decompiled upstream schema (`relayx-analysis/work/prisma_schema.prisma`).
 *
 * 1. Every model, enum, enum value and field of the replica's `schema.prisma` must
 *    equal the upstream schema — name, base type, nullability, list-ness, `@id`,
 *    `@unique` and `@default`.
 * 2. `src/generated/zod/index.ts` must cover every scalar column of every model,
 *    with `.nullable()` exactly on the columns the schema marks `?`, and the
 *    documented Prisma→Zod type mapping; relation columns are intentionally absent
 *    (see docs/DEVIATIONS.md §4).
 *
 * Both files are parsed as text, so the suite needs no Prisma client and no
 * database. It skips the upstream half when the analysis tree is not a sibling of
 * the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ANALYSIS = fileURLToPath(new URL("../../../relayx-analysis/", import.meta.url));

const REPLICA_SCHEMA = `${REPO}apps/backend/prisma/schema.prisma`;
const UPSTREAM_SCHEMA = `${ANALYSIS}work/prisma_schema.prisma`;
const ZOD = `${REPO}apps/backend/src/generated/zod/index.ts`;

interface Field {
  name: string;
  type: string;
  nullable: boolean;
  list: boolean;
  id: boolean;
  unique: boolean;
  default: string | null;
}

interface Schema {
  models: Map<string, Field[]>;
  enums: Map<string, string[]>;
  /** Block attributes (`@@unique`, `@@index`, `@@map`) per model, normalised. */
  blocks: Map<string, string[]>;
}

function parsePrisma(source: string): Schema {
  const models = new Map<string, Field[]>();
  const enums = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  let kind: "model" | "enum" | null = null;

  for (const raw of source.split("\n")) {
    const line = raw.split("//")[0].trimEnd();
    const open = /^(model|enum)\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = open[2];
      kind = open[1] as "model" | "enum";
      if (kind === "model") models.set(current, []);
      else enums.set(current, []);
      continue;
    }
    if (line.trim() === "}") {
      current = null;
      kind = null;
      continue;
    }
    if (!current || !line.trim()) continue;
    if (kind === "enum") {
      if (!line.trim().startsWith("@@")) enums.get(current)!.push(line.trim());
      continue;
    }
    if (line.trim().startsWith("@@")) {
      blocks.set(current, [...(blocks.get(current) ?? []), line.trim().replace(/\s+/g, " ")]);
      continue;
    }
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const [name, rawType] = tokens;
    const attrs = tokens.slice(2).join(" ");
    const defaultMatch = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(attrs);
    models.get(current)!.push({
      name,
      type: rawType.replace(/[?[\]]/g, ""),
      nullable: rawType.endsWith("?"),
      list: rawType.endsWith("[]"),
      id: attrs.includes("@id"),
      unique: attrs.includes("@unique"),
      default: defaultMatch ? defaultMatch[1] : null,
    });
  }
  return { models, enums, blocks };
}

const replicaSchema = parsePrisma(readFileSync(REPLICA_SCHEMA, "utf8"));
const modelNames = new Set(replicaSchema.models.keys());
const isRelation = (field: Field) => modelNames.has(field.type);

/** Prisma scalar/enum type → the Zod expression the generator must emit. */
function zodType(field: Field): string {
  const primitives: Record<string, string> = {
    Int: "z.number().int()",
    Float: "z.number()",
    String: "z.string()",
    Boolean: "z.boolean()",
    DateTime: "z.date()",
    Json: "jsonSchema",
  };
  const base = primitives[field.type] ?? `z.nativeEnum(${field.type})`;
  return field.nullable ? `${base}.nullable()` : base;
}

function parseZod(source: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const match of source.matchAll(/export const (\w+)Schema = z\.object\(\{([\s\S]*?)\n\}\);/g)) {
    const fields = new Map<string, string>();
    for (const line of match[2].split("\n")) {
      const field = /^\s*(\w+):\s*(.+?),\s*$/.exec(line);
      if (field) fields.set(field[1], field[2]);
    }
    out.set(match[1], fields);
  }
  return out;
}

const zod = parseZod(readFileSync(ZOD, "utf8"));

describe("replica schema structural invariants", () => {
  it("has the expected model, enum and column counts", () => {
    // 23 upstream models + `LocalCredential` (replica-local auth, docs/DEVIATIONS.md §30).
    expect([...replicaSchema.models.keys()].sort()).toHaveLength(24);
    expect([...replicaSchema.enums.keys()].sort()).toHaveLength(18);
    const all = [...replicaSchema.models.values()].flat();
    // +5 LocalCredential scalars (user_id, password_hash, email_verified, created_at,
    // updated_at) and +1 User.credential relation.
    expect(all).toHaveLength(304);
    expect(all.filter((f) => !isRelation(f))).toHaveLength(246);
    expect(all.filter(isRelation)).toHaveLength(58);
    expect(all.filter((f) => f.nullable && !isRelation(f))).toHaveLength(56);
  });
});

describe.skipIf(!existsSync(UPSTREAM_SCHEMA))("replica schema vs decompiled upstream", () => {
  // The describe body still runs when skipped (Vitest only skips the cases), so the
  // read must not assume the evidence tree exists.
  const upstream = existsSync(UPSTREAM_SCHEMA)
    ? parsePrisma(readFileSync(UPSTREAM_SCHEMA, "utf8"))
    : { models: new Map<string, Field[]>(), enums: new Map<string, string[]>(), blocks: new Map<string, string[]>() };

  // `LocalCredential` is the replica's own auth table (docs/DEVIATIONS.md §30); it is the
  // only model allowed to exist on top of the decompiled schema.
  const REPLICA_ONLY_MODELS = new Set(["LocalCredential"]);

  it("declares the same models and enums", () => {
    const replicaModels = [...replicaSchema.models.keys()].filter((m) => !REPLICA_ONLY_MODELS.has(m)).sort();
    expect(replicaModels).toEqual([...upstream.models.keys()].sort());
    expect([...replicaSchema.enums.keys()].sort()).toEqual([...upstream.enums.keys()].sort());
    for (const [name, values] of upstream.enums) {
      expect(replicaSchema.enums.get(name), `enum ${name}`).toEqual(values);
    }
  });

  it("matches every field of every model", () => {
    const differences: string[] = [];
    for (const model of upstream.models.keys()) {
      const theirs = upstream.models.get(model)!;
      const ours = replicaSchema.models.get(model)!;
      const byName = (fields: Field[]) => new Map(fields.map((f) => [f.name, f]));
      const theirMap = byName(theirs);
      const ourMap = byName(ours);

      const missing = [...theirMap.keys()].filter((name) => !ourMap.has(name));
      // The only tolerated extra field: the local-credential relation on User.
      const ALLOWED_EXTRA: Record<string, string[]> = { User: ["credential"] };
      const extra = [...ourMap.keys()].filter(
        (name) => !theirMap.has(name) && !(ALLOWED_EXTRA[model] ?? []).includes(name),
      );
      if (missing.length) differences.push(`${model}: missing ${missing.join(", ")}`);
      if (extra.length) differences.push(`${model}: extra ${extra.join(", ")}`);

      for (const [name, field] of theirMap) {
        const mine = ourMap.get(name);
        if (!mine) continue;
        for (const key of ["type", "nullable", "list", "id", "unique", "default"] as const) {
          if (field[key] !== mine[key]) {
            differences.push(`${model}.${name}.${key}: upstream=${JSON.stringify(field[key])} replica=${JSON.stringify(mine[key])}`);
          }
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it("matches block attributes (unique, index, map)", () => {
    const differences: string[] = [];
    for (const model of upstream.models.keys()) {
      const theirs = [...(upstream.blocks.get(model) ?? [])].sort();
      const ours = [...(replicaSchema.blocks.get(model) ?? [])].sort();
      if (JSON.stringify(theirs) !== JSON.stringify(ours)) {
        differences.push(`${model}: upstream=${JSON.stringify(theirs)} replica=${JSON.stringify(ours)}`);
      }
    }
    expect(differences).toEqual([]);
  });
});

describe("generated zod schemas", () => {
  it("covers every model", () => {
    const models = [...replicaSchema.models.keys()].sort();
    expect([...zod.keys()].sort()).toEqual(models);
  });

  it("emits every scalar column with the schema's nullability", () => {
    const problems: string[] = [];
    for (const [model, fields] of replicaSchema.models) {
      const generated = zod.get(model)!;
      const expected = fields.filter((f) => !isRelation(f));
      const expectedNames = expected.map((f) => f.name);
      const generatedNames = [...generated.keys()];

      const missing = expectedNames.filter((name) => !generated.has(name));
      const extra = generatedNames.filter((name) => !expectedNames.includes(name));
      if (missing.length) problems.push(`${model}: missing ${missing.join(", ")}`);
      if (extra.length) problems.push(`${model}: unexpected ${extra.join(", ")}`);

      for (const field of expected) {
        const expression = generated.get(field.name);
        if (expression === undefined) continue;
        if (expression !== zodType(field)) {
          problems.push(`${model}.${field.name}: expected ${zodType(field)}, got ${expression}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("marks exactly the nullable scalar columns with .nullable()", () => {
    const nullableColumns = [...replicaSchema.models.values()]
      .flat()
      .filter((f) => !isRelation(f) && f.nullable);
    const generatedNullable = [...zod.entries()].flatMap(([model, fields]) =>
      [...fields.entries()]
        .filter(([, expression]) => expression.includes(".nullable()"))
        .map(([name]) => `${model}.${name}`),
    );
    expect(generatedNullable.sort()).toEqual(
      nullableColumns.map((f) => `${[...replicaSchema.models.entries()].find(([, fields]) => fields.includes(f))![0]}.${f.name}`).sort(),
    );
  });

  it("never emits a relation column", () => {
    for (const [model, fields] of zod) {
      for (const name of fields.keys()) {
        expect(isRelation(replicaSchema.models.get(model)!.find((f) => f.name === name)!), `${model}.${name}`).toBe(
          false,
        );
      }
    }
  });
});
