/**
 * Throwaway database for the integration suites, in whichever dialect the run targets.
 *
 * Default (SQLite): a temp directory plus `prisma db push` — a brand new file per suite.
 *
 * MySQL (`RELAYX_TEST_DIALECT=mysql`): a small **pool** of `relayx_t_*` databases shared by the
 * run. The suites assume an empty schema, and creating a database plus replaying the baseline
 * DDL for every file is the dominant cost of the job, so instead:
 *
 *   - each test process claims one slot with an atomically created lock file (`open` + `wx`);
 *   - `mysql-test-db.mjs acquire <db>` builds the database the first time a slot is ever used
 *     and otherwise just empties it (`DELETE` per table, foreign-key order);
 *   - the lock is removed when the process exits; the database stays for the next file.
 *
 * A slot whose owning pid is gone is taken over, and if every slot is busy the file falls back
 * to a private database it drops itself, so a run can never deadlock. If a process dies without
 * its exit hook, the next claimer notices the dead pid; `mysql-test-db.mjs sweep` drops every
 * `relayx_t_*` as a last resort.
 *
 * The pool is keyed on the server URL **and a digest of the baseline DDL**, so a checkout that
 * changes the schema gets fresh databases instead of reusing ones built from the old DDL.
 *
 * The database in `DATABASE_URL` is only a maintenance connection: suites never write to it,
 * which is what makes the parallelism safe.
 *
 * The helper stays synchronous: the suites call it at module scope. Both branches shell out to
 * a child process, which is also how the SQLite branch already worked (`prisma db push`).
 *
 * Callers must set `process.env.DATABASE_URL` before importing `apps/backend/src/db.ts`,
 * because the Prisma client reads it when the module is evaluated.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRISMA_BIN = join(ROOT, "node_modules", ".bin", "prisma");
const SQLITE_SCHEMA = join(ROOT, "apps/backend/prisma/schema.prisma");
const MYSQL_TEST_DB = join(ROOT, "apps/backend/scripts/mysql-test-db.mjs");
const MYSQL_BASELINE = join(ROOT, "apps/backend/prisma/mysql/migrations/0001_init/migration.sql");

/** A lock without a readable pid is only treated as stale after this long. */
const LOCK_WRITE_GRACE_MS = 5_000;

export type TestDialect = "sqlite" | "mysql";

export interface TempDatabase {
  url: string;
  /** SQLite only: the database file. Empty in MySQL mode. */
  path: string;
  dialect: TestDialect;
  /**
   * SQLite: removes the temp directory. MySQL: no-op — the pooled database is emptied by the
   * next file that claims the slot and dropped by `sweep`.
   */
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

/**
 * How many databases the run keeps around: enough for every concurrent vitest worker, bounded so
 * a large machine does not leave dozens of schemas behind.
 */
export function poolSize(): number {
  return Math.max(4, Math.min(cpus().length * 2, 16));
}

/** Identity of the schema a pooled database was built from. */
export function schemaDigest(): string {
  return createHash("sha256").update(readFileSync(MYSQL_BASELINE)).digest("hex").slice(0, 10);
}

/**
 * Pool directory for one (server, schema) pair: two checkouts pointing at different servers, or
 * at the same server with different DDL, must not hand each other databases.
 */
export function poolRoot(maintenanceUrl: string): string {
  const digest = createHash("sha256")
    .update(`${maintenanceUrl}\0${schemaDigest()}`)
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `relayx-mysql-pool-${digest}`);
}

/** `relayx_t_` is the prefix `sweep` matches; the script validates the full shape. */
export function poolDatabaseName(slot: number, maintenanceUrl: string): string {
  const digest = createHash("sha256").update(maintenanceUrl).digest("hex").slice(0, 8);
  return `relayx_t_s${slot}_${digest}`;
}

export interface Slot {
  /** Absolute path of the lock file that makes this slot ours. */
  lockPath: string;
  database: string;
  acquiredAt: number;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the owner pid out of a lock file; `null` when it is gone or unreadable. */
function lockOwner(lockPath: string): number | null {
  try {
    const [pid] = readFileSync(lockPath, "utf8").split(/\s+/);
    const parsed = Number.parseInt(pid, 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claim a slot for this process, or return `null` when every slot is held by a live process.
 *
 * The lock file is created with `open(…, "wx")`, which is atomic, then written and closed. A
 * concurrent claimer can observe the file before its content is readable; that window is why an
 * owner-less lock is only treated as stale once it is older than `LOCK_WRITE_GRACE_MS`.
 */
export function claimSlot(root: string, maintenanceUrl: string): Slot | null {
  const size = poolSize();
  mkdirSync(root, { recursive: true });
  for (let slot = 0; slot < size; slot += 1) {
    const lockPath = join(root, `slot-${slot}.lock`);
    let created = false;
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
        created = true;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      return {
        lockPath,
        database: poolDatabaseName(slot, maintenanceUrl),
        acquiredAt: Date.now(),
      };
    }

    // Someone owns it. Take it over only if that process is gone.
    const pid = lockOwner(lockPath);
    if (pid !== null && isAlive(pid)) continue;
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      continue; // vanished between the open and the stat: try the next slot
    }
    if (pid === null && ageMs < LOCK_WRITE_GRACE_MS) continue;
    rmSync(lockPath, { force: true });
    slot -= 1; // retry this slot from the top of the loop
  }
  return null;
}

/** Remove the lock that marks a slot as ours. */
export function releaseSlot(slot: Slot): void {
  rmSync(slot.lockPath, { force: true });
}

/** One claim per process: later files it runs reuse the same database, emptied by `acquire`. */
let held: { slot: Slot | null; database: string; url: string; env: NodeJS.ProcessEnv } | null = null;

function runHarness(mode: "acquire" | "drop", database: string, env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [MYSQL_TEST_DB, mode, database], {
    env,
    stdio: mode === "acquire" ? "inherit" : "ignore",
  });
}

export function createTempDatabase(name: string): TempDatabase {
  if (testDialect() === "mysql") {
    const maintenanceUrl = process.env.DATABASE_URL;
    if (!isMySQLUrl(maintenanceUrl)) {
      throw new Error(
        "RELAYX_TEST_DIALECT=mysql needs a mysql:// DATABASE_URL; it is the maintenance " +
          "connection used to create the pooled databases",
      );
    }
    if (!held) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      const slot = claimSlot(poolRoot(maintenanceUrl), maintenanceUrl);
      const database = slot?.database ?? `relayx_t_e${process.pid}`;
      runHarness("acquire", database, env);
      const acquiredAt = Date.now();
      held = { slot, database, url: withDatabase(maintenanceUrl, database), env };
      process.once("exit", () => {
        try {
          if (slot) {
            releaseSlot(slot);
          } else {
            runHarness("drop", database, env);
          }
        } catch {
          // Best effort: `sweep` removes anything left behind.
        }
        if (process.env.RELAYX_TEST_VERBOSE) {
          console.error(
            `[temp-db] ${database} (${slot ? "pooled" : "unpooled"}) held for ` +
              `${Math.round((Date.now() - acquiredAt) / 1000)}s`,
          );
        }
      });
    } else {
      // Same process, next file: empty the database instead of creating another one.
      runHarness("acquire", held.database, held.env);
    }
    void name;
    return {
      url: held.url,
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
