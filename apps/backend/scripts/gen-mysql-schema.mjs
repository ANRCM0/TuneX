#!/usr/bin/env node
/**
 * Derive the MySQL schema + baseline migration from the SQLite schema.
 *
 * Prisma requires the datasource provider to be a string literal, so one schema file cannot
 * serve both engines. MySQL therefore gets its own directory (Prisma keeps `migrations/`
 * next to the schema file):
 *
 *   prisma/mysql/schema.prisma                   generated
 *   prisma/mysql/migrations/0001_init/…           generated once, then owned like any migration
 *   prisma/mysql/migrations/migration_lock.toml   generated
 *
 * Only the `datasource` block is rewritten; every model, field, default and relation is
 * identical to `prisma/schema.prisma` (which `tests/unit/schema-parity.test.ts` pins to the
 * decompiled upstream).
 *
 *   node scripts/gen-mysql-schema.mjs            # write schema + regenerate the baseline
 *   node scripts/gen-mysql-schema.mjs --check    # read-only: exit 1 when anything is stale
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "prisma");
const schemaPath = join(prismaDir, "schema.prisma");
const mysqlDir = join(prismaDir, "mysql");
const mysqlSchemaPath = join(mysqlDir, "schema.prisma");
const mysqlMigrations = join(mysqlDir, "migrations");
const BASELINE = "0001_init";
const LOCK_PATH = join(mysqlMigrations, "migration_lock.toml");
const BASELINE_PATH = join(mysqlMigrations, BASELINE, "migration.sql");
const MYSQL_URL = process.env.MYSQL_URL_FOR_DDL || "mysql://user:pass@127.0.0.1:3306/relayx";
const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const HEADER = `// RelayX data model — MySQL variant.
//
// GENERATED from ../schema.prisma by scripts/gen-mysql-schema.mjs. Only the datasource
// block differs; the models are identical to the SQLite schema.
`;

const source = readFileSync(schemaPath, "utf8");
if (!/datasource db \{[^}]*\}/.test(source)) {
  console.error("schema.prisma has no datasource block");
  process.exit(1);
}

const body = source
  .replace(
    /datasource db \{[^}]*\}/,
    `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}`,
  )
  .replace(/generator client \{[\s\S]*?\n\}\n\n/, "");

const mysqlSchema = `${HEADER}
generator client {
  provider = "prisma-client-js"
}

${body}`;

const LOCK = 'provider = "mysql"\n';

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

if (CHECK) {
  const problems = [];
  if (read(mysqlSchemaPath) !== mysqlSchema) {
    problems.push("prisma/mysql/schema.prisma is missing or stale (run pnpm db:mysql:generate)");
  }
  if (read(LOCK_PATH) !== LOCK) {
    problems.push("prisma/mysql/migrations/migration_lock.toml is missing or not mysql");
  }
  if (read(BASELINE_PATH) === null) {
    problems.push(`prisma/mysql/migrations/${BASELINE}/migration.sql is missing`);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("mysql schema and baseline migration are up to date");
  process.exit(0);
}

mkdirSync(join(mysqlMigrations, BASELINE), { recursive: true });
writeFileSync(mysqlSchemaPath, mysqlSchema);
writeFileSync(LOCK_PATH, LOCK);
console.log(`wrote ${mysqlSchemaPath}`);

// The baseline is generated once; after that it is a normal migration that may be edited.
if (!existsSync(BASELINE_PATH) || FORCE) {
  const ddl = execFileSync(
    join(here, "..", "..", "..", "node_modules", ".bin", "prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", mysqlSchemaPath, "--script"],
    { env: { ...process.env, DATABASE_URL: MYSQL_URL }, encoding: "utf8" },
  );
  writeFileSync(BASELINE_PATH, ddl);
  console.log(`wrote ${BASELINE_PATH}`);
} else {
  console.log(`kept ${BASELINE_PATH} (use --force to regenerate)`);
}
