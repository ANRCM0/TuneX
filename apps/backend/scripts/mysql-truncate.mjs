#!/usr/bin/env node
/**
 * Empty every table of the test database, children first.
 *
 * Spawned by `tests/helpers/temp-db.ts` when `RELAYX_TEST_DIALECT=mysql`, once per suite, so
 * a MySQL run gives each suite the same clean slate a fresh SQLite file gives it.
 *
 * MySQL enforces foreign keys on DELETE, so the order is derived from `information_schema`
 * rather than hard-coded: the schema has 20+ relations and grows. Self-references cannot be
 * ordered away, so their columns are nulled first (in this schema that is `user.parent_id`,
 * which is nullable by design). Auto-increment counters are reset afterwards so ids start at 1
 * again, like a fresh SQLite file.
 *
 * Usage: DATABASE_URL="mysql://…" node tests/helpers/mysql-truncate.mjs
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/^\s*mysql/i.test(url)) {
  console.error("mysql-truncate: DATABASE_URL must be a mysql:// URL");
  process.exit(2);
}

const client = new PrismaClient({ datasourceUrl: url });

try {
  const tables = (
    await client.$queryRawUnsafe(
      `SELECT TABLE_NAME FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
    )
  ).map((row) => row.TABLE_NAME);

  if (tables.length === 0) {
    console.error("mysql-truncate: the database has no tables; was the schema pushed?");
    process.exitCode = 1;
  } else {
    const edges = await client.$queryRawUnsafe(
      `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );

    const parents = new Map();
    const selfRefs = new Map();
    for (const edge of edges) {
      if (edge.TABLE_NAME === edge.REFERENCED_TABLE_NAME) {
        if (!selfRefs.has(edge.TABLE_NAME)) selfRefs.set(edge.TABLE_NAME, []);
        selfRefs.get(edge.TABLE_NAME).push(edge.COLUMN_NAME);
        continue;
      }
      if (!parents.has(edge.TABLE_NAME)) parents.set(edge.TABLE_NAME, new Set());
      parents.get(edge.TABLE_NAME).add(edge.REFERENCED_TABLE_NAME);
    }

    for (const [table, columns] of selfRefs) {
      for (const column of columns) {
        try {
          await client.$executeRawUnsafe(`UPDATE \`${table}\` SET \`${column}\` = NULL`);
        } catch {
          // NOT NULL self-reference: nothing to break, the delete below will say so.
        }
      }
    }

    // Parents-first post-order, reversed: children are deleted before the rows they point at.
    const order = [];
    const state = new Map();
    const visit = (table) => {
      if (state.has(table)) return;
      state.set(table, "visiting");
      for (const parent of parents.get(table) ?? []) visit(parent);
      state.set(table, "done");
      order.push(table);
    };
    for (const table of tables) visit(table);

    for (const table of order.reverse()) {
      await client.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    }

    // A fresh SQLite file starts its ids at 1; a deleted MySQL table keeps its counter, which
    // would make ids grow across suites and break "first row is id 1"-style expectations.
    const autoIncrement = await client.$queryRawUnsafe(
      `SELECT TABLE_NAME FROM information_schema.columns
        WHERE table_schema = DATABASE() AND extra LIKE '%auto_increment%'`,
    );
    for (const row of autoIncrement) {
      await client.$executeRawUnsafe(`ALTER TABLE \`${row.TABLE_NAME}\` AUTO_INCREMENT = 1`);
    }
  }
} catch (error) {
  console.error(`mysql-truncate: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
