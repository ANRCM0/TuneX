#!/usr/bin/env node
/**
 * MySQL database plumbing for the test harness.
 *
 * `tests/helpers/temp-db.ts` spawns this. The suites assume a fresh schema — that is what a new
 * SQLite file gives them — and the cheapest way to give each vitest worker the same guarantee
 * on MySQL is one database per worker, created once and emptied between files:
 *
 *   create  <db>  CREATE DATABASE + replay the committed baseline DDL (~55 statements)
 *   reset   <db>  delete every row, children first (one statement per table)
 *   acquire <db>  create if missing, otherwise reset — what a pooled slot needs
 *   drop    <db>  DROP DATABASE
 *   sweep         drop every `relayx_t_*` (pool slots included)
 *
 * The DDL is `prisma/mysql/migrations/0001_init/migration.sql` — the file `mysql.yml` applies
 * and `prisma migrate diff` checks for drift — so the suite runs on the schema CI deploys.
 *
 * Resetting with DELETE rather than CREATE/DROP keeps the per-file cost at one round trip per
 * table instead of a database creation plus the whole DDL, and it leaves AUTO_INCREMENT alone:
 * ids stay monotonic inside a worker's database, which no suite depends on (they compare ids to
 * each other, never to a literal). If that ever changes, reset can also issue
 * `ALTER TABLE … AUTO_INCREMENT = 1`.
 *
 * The maintenance database in `DATABASE_URL` must exist and allow CREATE/DROP DATABASE; this
 * script only ever touches databases named `relayx_t_*`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const BASELINE = new URL("../prisma/mysql/migrations/0001_init/migration.sql", import.meta.url);
const PREFIX = "relayx_t_";

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

/**
 * Tables in deletion order (children before the rows they point at).
 *
 * MySQL enforces foreign keys on DELETE, and the schema has 20+ relations that keep growing, so
 * the order is read from `information_schema` instead of being maintained by hand. Self
 * references cannot be ordered away; their nullable columns are cleared first (`user.parent_id`
 * is the only one in this schema).
 */
export async function deletionOrder(client) {
  const tables = (
    await client.$queryRawUnsafe(
      `SELECT TABLE_NAME FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
    )
  ).map((row) => row.TABLE_NAME);
  const edges = await client.$queryRawUnsafe(
    `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );

  const parents = new Map();
  const selfReferences = [];
  for (const edge of edges) {
    if (edge.TABLE_NAME === edge.REFERENCED_TABLE_NAME) {
      selfReferences.push({ table: edge.TABLE_NAME, column: edge.COLUMN_NAME });
      continue;
    }
    if (!parents.has(edge.TABLE_NAME)) parents.set(edge.TABLE_NAME, new Set());
    parents.get(edge.TABLE_NAME).add(edge.REFERENCED_TABLE_NAME);
  }

  const order = [];
  const seen = new Set();
  const visit = (table) => {
    if (seen.has(table)) return;
    seen.add(table);
    for (const parent of parents.get(table) ?? []) visit(parent);
    order.push(table);
  };
  for (const table of tables) visit(table);

  // Parents were emitted first by the post-order walk; deletion needs the reverse.
  return { tables, selfReferences, order: order.reverse() };
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
    // A half-created database would poison the next worker that reuses the name.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {});
    throw error;
  } finally {
    await target?.$disconnect();
    await admin.$disconnect();
  }
}

async function reset(maintenanceUrl, database) {
  const client = new PrismaClient({ datasourceUrl: withDatabase(maintenanceUrl, database) });
  try {
    const { tables, selfReferences, order } = await deletionOrder(client);
    if (tables.length === 0) {
      throw new Error(`${database} has no tables; was it created by this harness?`);
    }
    for (const { table, column } of selfReferences) {
      await client.$executeRawUnsafe(`UPDATE \`${table}\` SET \`${column}\` = NULL`);
    }
    for (const table of order) {
      await client.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    }
    return order.length;
  } finally {
    await client.$disconnect();
  }
}

/** Create the database if it is missing, otherwise empty it. One call per pooled slot claim. */
async function acquire(maintenanceUrl, database) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  let exists = false;
  try {
    const rows = await admin.$queryRawUnsafe(
      "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name = ?",
      database,
    );
    exists = rows.length > 0;
  } finally {
    await admin.$disconnect();
  }
  if (exists) {
    try {
      return await reset(maintenanceUrl, database);
    } catch {
      // A database left half-created by a crash has no tables; start it over.
      await drop(maintenanceUrl, database);
    }
  }
  return create(maintenanceUrl, database);
}

async function drop(maintenanceUrl, database) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``);
  } finally {
    await admin.$disconnect();
  }
}

/** Drop every `relayx_t_*` database — a worker killed before its exit hook never cleans up. */
async function sweep(maintenanceUrl) {
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl });
  try {
    // `\_` escapes the underscore so the LIKE pattern stays anchored on the prefix.
    const rows = await admin.$queryRawUnsafe(
      `SELECT schema_name AS name FROM information_schema.schemata
        WHERE schema_name LIKE '${PREFIX.replace(/_/g, "\\_")}%'`,
    );
    for (const row of rows) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${row.name}\``);
    }
    return rows.length;
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
      const dropped = await sweep(url);
      console.error(`mysql-test-db: dropped ${dropped} leftover test database(s)`);
    } catch (error) {
      console.error(`mysql-test-db sweep failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!new RegExp(`^${PREFIX}[A-Za-z0-9_]+$`).test(database ?? "")) {
    console.error(`mysql-test-db: refusing an unexpected database name: ${database}`);
    process.exit(2);
  }
  try {
    if (mode === "create") {
      const count = await create(url, database);
      if (process.env.RELAYX_TEST_VERBOSE) {
        console.error(`mysql-test-db: created ${database} (${count} statements)`);
      }
    } else if (mode === "reset") {
      const count = await reset(url, database);
      if (process.env.RELAYX_TEST_VERBOSE) {
        console.error(`mysql-test-db: reset ${database} (${count} tables)`);
      }
    } else if (mode === "acquire") {
      const count = await acquire(url, database);
      if (process.env.RELAYX_TEST_VERBOSE) {
        console.error(`mysql-test-db: acquired ${database} (${count})`);
      }
    } else if (mode === "drop") {
      await drop(url, database);
    } else {
      console.error("usage: mysql-test-db.mjs create|reset|acquire|drop <database> | sweep");
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
