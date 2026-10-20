/**
 * Throwaway database for the integration suites, in whichever dialect the run targets.
 *
 * Default (SQLite): a temp directory plus `prisma db push`, so every suite gets a brand new
 * file and therefore full isolation.
 *
 * MySQL (`RELAYX_TEST_DIALECT=mysql`): the database named by `DATABASE_URL` is reused, the
 * schema is pushed once per process from `apps/backend/prisma/mysql/schema.prisma`, and each
 * `createTempDatabase()` call empties every table before returning — see
 * `apps/backend/scripts/mysql-truncate.mjs`. Emptying is what keeps the suites' "fresh database"
 * assumption true on a server where creating a database per suite would cost seconds each.
 *
 * The helper stays synchronous: the suites call it at module scope. Both branches shell out
 * to a child process, which is also how the SQLite branch already worked (`prisma db push`).
 *
 * Callers must set `process.env.DATABASE_URL` before importing `apps/backend/src/db.ts`,
 * because the Prisma client reads it when the module is evaluated.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRISMA_BIN = join(ROOT, "node_modules", ".bin", "prisma");
const SQLITE_SCHEMA = join(ROOT, "apps/backend/prisma/schema.prisma");
const MYSQL_SCHEMA = join(ROOT, "apps/backend/prisma/mysql/schema.prisma");
const TRUNCATE_SCRIPT = join(ROOT, "apps/backend/scripts/mysql-truncate.mjs");

export type TestDialect = "sqlite" | "mysql";

export interface TempDatabase {
  url: string;
  /** SQLite only: the database file. Empty in MySQL mode. */
  path: string;
  dialect: TestDialect;
  /** SQLite: removes the temp directory. MySQL: no-op (the next suite empties the tables). */
  cleanup: () => void;
}

/** `RELAYX_TEST_DIALECT=mysql` selects the MySQL target; anything else is SQLite. */
export function testDialect(): TestDialect {
  return process.env.RELAYX_TEST_DIALECT === "mysql" ? "mysql" : "sqlite";
}

const isMySQLUrl = (url: string | undefined): boolean => /^\s*mysql/i.test(url ?? "");

/**
 * Marker recording that this database already has the schema, so only the first suite of a
 * run pays for `db push`. Keyed on URL + host + the generated schema's size/mtime, so editing
 * `prisma/mysql/schema.prisma` invalidates it instead of silently testing a stale server.
 */
function schemaMarker(url: string): string {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return join(tmpdir(), `relayx-mysql-schema-${digest}.stamp`);
}

function schemaStamp(): string {
  const stats = statSync(MYSQL_SCHEMA);
  return `${stats.size}:${stats.mtimeMs}`;
}

function pushMySQLSchema(url: string): void {
  const marker = schemaMarker(url);
  const stamp = schemaStamp();
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === stamp) return;
  execFileSync(
    PRISMA_BIN,
    // `--accept-data-loss` keeps a throwaway test database non-interactive: without a TTY a
    // pending confirmation would otherwise fail the run instead of just resetting the schema.
    ["db", "push", "--skip-generate", "--accept-data-loss", `--schema=${MYSQL_SCHEMA}`],
    { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
  );
  writeFileSync(marker, stamp);
}

export function createTempDatabase(name: string): TempDatabase {
  if (testDialect() === "mysql") {
    const url = process.env.DATABASE_URL;
    if (!isMySQLUrl(url)) {
      throw new Error(
        "RELAYX_TEST_DIALECT=mysql needs a mysql:// DATABASE_URL; createTempDatabase reuses it",
      );
    }
    pushMySQLSchema(url);
    execFileSync(process.execPath, [TRUNCATE_SCRIPT], {
      env: { ...process.env, DATABASE_URL: url, RELAYX_TEST_SUITE: name },
      stdio: "inherit",
    });
    return {
      url,
      path: "",
      dialect: "mysql",
      cleanup: () => {},
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
