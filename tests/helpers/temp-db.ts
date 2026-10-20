/**
 * Throwaway database for the integration suites, in whichever dialect the run targets.
 *
 * Default (SQLite): a temp directory plus `prisma db push` — a brand new file per suite.
 *
 * MySQL (`RELAYX_TEST_DIALECT=mysql`): a brand new *database* per suite, named
 * `relayx_t_<suite>_<pid>_<counter>`, created against the server in `DATABASE_URL` and filled
 * by replaying the committed baseline DDL (`apps/backend/scripts/mysql-test-db.mjs`). The
 * database in `DATABASE_URL` itself is only a maintenance connection: the suites never write to
 * it, which is what lets vitest keep running files in parallel on MySQL exactly as it does on
 * SQLite.
 *
 * The helper stays synchronous: the suites call it at module scope. Both branches shell out to
 * a child process, which is also how the SQLite branch already worked (`prisma db push`).
 *
 * Callers must set `process.env.DATABASE_URL` before importing `apps/backend/src/db.ts`,
 * because the Prisma client reads it when the module is evaluated.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRISMA_BIN = join(ROOT, "node_modules", ".bin", "prisma");
const SQLITE_SCHEMA = join(ROOT, "apps/backend/prisma/schema.prisma");
const MYSQL_TEST_DB = join(ROOT, "apps/backend/scripts/mysql-test-db.mjs");

export type TestDialect = "sqlite" | "mysql";

export interface TempDatabase {
  url: string;
  /** SQLite only: the database file. Empty in MySQL mode. */
  path: string;
  dialect: TestDialect;
  /** SQLite: removes the temp directory. MySQL: drops the per-suite database. */
  cleanup: () => void;
}

/** `RELAYX_TEST_DIALECT=mysql` selects the MySQL target; anything else is SQLite. */
export function testDialect(): TestDialect {
  return process.env.RELAYX_TEST_DIALECT === "mysql" ? "mysql" : "sqlite";
}

const isMySQLUrl = (url: string | undefined): boolean => /^\s*mysql/i.test(url ?? "");

/** Swap the database of a MySQL URL, keeping credentials, host and query options. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let sequence = 0;

/**
 * Deterministic-but-unique name: the suite, the process (one per vitest worker) and a counter.
 * `mysql-test-db.mjs` refuses anything that does not match `relayx_t_…`, so a name can never
 * reach SQL unchecked.
 */
function databaseName(suite: string): string {
  const slug = suite.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40) || "suite";
  sequence += 1;
  return `relayx_t_${slug}_${process.pid}_${sequence}`;
}

export function createTempDatabase(name: string): TempDatabase {
  if (testDialect() === "mysql") {
    const maintenanceUrl = process.env.DATABASE_URL;
    if (!isMySQLUrl(maintenanceUrl)) {
      throw new Error(
        "RELAYX_TEST_DIALECT=mysql needs a mysql:// DATABASE_URL; it is the maintenance " +
          "connection used to create the per-suite database",
      );
    }
    const database = databaseName(name);
    const env = { ...process.env, DATABASE_URL: maintenanceUrl };
    execFileSync(process.execPath, [MYSQL_TEST_DB, "create", database], { env, stdio: "inherit" });
    return {
      url: withDatabase(maintenanceUrl, database),
      path: "",
      dialect: "mysql",
      cleanup: () => {
        execFileSync(process.execPath, [MYSQL_TEST_DB, "drop", database], { env, stdio: "inherit" });
      },
    };
  }

  const dir = mkdtempSync(join(tmpdir(), `relayx-${name}-`));
  const path = join(dir, "test.db");
  const url = `file:${path}`;
  execFileSync(PRISMA_BIN, ["db", "push", "--skip-generate", `--schema=${SQLITE_SCHEMA}`], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return {
    url,
    path,
    dialect: "sqlite",
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
