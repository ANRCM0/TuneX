#!/usr/bin/env node
/**
 * Derive the MySQL schema + baseline migration from the SQLite schema.
 *
 * Prisma requires the datasource provider to be a string literal, so one schema file cannot
 * serve both engines. MySQL therefore gets its own directory (Prisma keeps `migrations/`
 * next to the schema file):
 *
 *   prisma/mysql/schema.prisma                  generated
 *   prisma/mysql/migrations/0001_init/…          generated (once, then owned like any migration)
 *   prisma/mysql/migrations/migration_lock.toml  generated
 *
 * Only the `datasource` block is rewritten; every model, field, default and relation is
 * identical to `prisma/schema.prisma` (which `tests/unit/schema-parity.test.ts` pins to the
 * decompiled upstream). `--check` fails when the generated output is stale.
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
const MYSQL_URL = process.env.MYSQL_URL_FOR_DDL || "mysql://user:pass@127.0.0.1:3306/relayx";

const HEADER = `// RelayX data model — MySQL variant.
//
// GENERATED from ../schema.prisma by scripts/gen-mysql-schema.mjs. Only the datasource
// block differs; the models are identical to the SQLite schema.
`;

const source = readFileSync(schemaPath, "utf8");
const datasource = /datasource db \{[^}]*\}/;
if (!datasource.test(source)) {
  console.error("schema.prisma has no datasource block");
  process.exit(1);
}

const body = source
  .replace(
    datasource,
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

function ddl() {
  return execFileSync(
    join(here, "..", "..", "..", "node_modules", ".bin", "prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", mysqlSchemaPath, "--script"],
    { env: { ...process.env, DATABASE_URL: MYSQL_URL }, encoding: "utf8" },
  );
}

function check() {
  const problems = [];
  if (!existsSync(mysqlSchemaPath) || readFileSync(mysqlSchemaPath, "utf8") !== mysqlSchema) {
    problems.push("prisma/mysql/schema.prisma is missing or stale");
  }
  const baseline = join(mysqlMigrations, BASELINE, "migration.sql");
  if (!existsSync(baseline)) problems.push(`prisma/mysql/migrations/${BASELINE}/migration.sql is missing`);
  const lock = join(mysqlMigrations, "migration_lock.toml");
  if (!existsSync(lock) || !readFileSync(lock, "utf8").includes('provider = "mysql"')) {
    problems.push("prisma/mysql/migrations/migration_lock.toml is missing or not mysql");
  }
  if (problems.length) {
    problems.forEach((p) => console.error(`- ${p}`));
    process.exit(1);
  }
  console.log("mysql schema and baseline migration are up to date");
}

mkdirSync(join(mysqlMigrations, BASELINE), { recursive: true });
writeFileSync(mysqlSchemaPath, mysqlSchema);
writeFileSync(join(mysqlMigrations, "migration_lock.toml"), 'provider = "mysql"\n');
const baselinePath = join(mysqlMigrations, BASELINE, "migration.sql");
if (!existsSync(baselinePath) || process.argv.includes("--force")) {
  writeFileSync(baselinePath, ddl());
  console.log(`wrote ${baselinePath}`);
}
console.log(`wrote ${mysqlSchemaPath}`);

if (process.argv.includes("--check")) check();
