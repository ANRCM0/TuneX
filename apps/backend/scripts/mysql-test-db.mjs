#!/usr/bin/env node
/**
 * Create or drop a per-suite MySQL database for the test harness.
 *
 * `tests/helpers/temp-db.ts` spawns this so each vitest file gets its own database: the suites
 * assume a fresh schema (that is what a new SQLite file gives them), and a shared database
 * forces the whole run to be serial. Creating a database and replaying the baseline DDL is
 * fast (~55 statements), so parallel suites each get isolation instead.
 *
 * The DDL is the committed MySQL baseline — the same file `mysql.yml` applies and
 * `prisma migrate diff` checks for drift — so the tests run on the schema CI deploys.
 *
 * Usage:
 *   DATABASE_URL="mysql://…/relayx_ci" node mysql-test-db.mjs create relayx_t_stats_123
 *   DATABASE_URL="mysql://…/relayx_ci" node mysql-test-db.mjs drop   relayx_t_stats_123
 *   DATABASE_URL="mysql://…/relayx_ci" node mysql-test-db.mjs sweep   # all relayx_t_* left behind
 *
 * The maintenance database in `DATABASE_URL` must already exist and allow CREATE/DROP DATABASE;
 * the harness only ever touches databases named `relayx_t_*`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const BASELINE = new URL("../prisma/mysql/migrations/0001_init/migration.sql", import.meta.url);

/**
 * Split the Prisma-generated baseline into individual statements.
 *
 * The file is machine-generated: `--` comment lines separate blocks and every statement ends
 * with `;` at the end of a line, with no semicolons inside literals. Splitting is therefore
 * safe — and `tests/unit/mysql-workflow.test.ts` pins that assumption by running this splitter
 * over the committed DDL.
 */
export function splitStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Swap the database of a MySQL URL, keeping credentials, host and query options. */
export function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function create(maintenanceUrl, database) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  let target;
  try {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    const statements = splitStatements(readFileSync(BASELINE, "utf8"));
    if (statements.length === 0) {
      throw new Error("the MySQL baseline migration produced no statements");
    }
    target = new PrismaClient({ datasourceUrl: withDatabase(maintenanceUrl, database) });
    for (const statement of statements) {
      await target.$executeRawUnsafe(statement);
    }
    return statements.length;
  } catch (error) {
    // A half-created database would poison the next suite that reuses the name.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {});
    throw error;
  } finally {
    await target?.$disconnect();
    await admin.$disconnect();
  }
}

/** Drop every `relayx_t_*` database — a crashed suite never reaches its `afterAll`. */
async function sweep(maintenanceUrl) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  try {
    // `\\_` escapes the underscore so the LIKE pattern stays anchored on the prefix.
    const rows = await admin.$queryRawUnsafe(
      "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE 'relayx\\_t\\_%'",
    );
    for (const row of rows) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${row.name}\``);
    }
    console.error(`mysql-test-db: dropped ${rows.length} leftover test database(s)`);
  } finally {
    await admin.$disconnect();
  }
}

async function drop(maintenanceUrl, database) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``);
  } finally {
    await admin.$disconnect();
  }
}

async function main() {
  const [mode, database] = process.argv.slice(2);
  const url = process.env.DATABASE_URL ?? "";
  if (!/^\s*mysql/i.test(url)) {
    console.error("mysql-test-db: DATABASE_URL must be a mysql:// URL");
    process.exit(2);
  }
  if (mode === "sweep") {
    try {
      await sweep(url);
    } catch (error) {
      console.error(`mysql-test-db sweep failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!/^relayx_t_[A-Za-z0-9_]+$/.test(database ?? "")) {
    console.error(`mysql-test-db: refusing an unexpected database name: ${database}`);
    process.exit(2);
  }
  try {
    if (mode === "create") {
      const count = await create(url, database);
      if (process.env.RELAYX_TEST_VERBOSE) {
        console.error(`mysql-test-db: created ${database} (${count} statements)`);
      }
    } else if (mode === "drop") {
      await drop(url, database);
    } else {
      console.error("usage: mysql-test-db.mjs create|drop <database>");
      process.exit(2);
    }
  } catch (error) {
    console.error(`mysql-test-db ${mode} ${database} failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
