/**
 * Migration baseline and the MySQL schema variant.
 *
 * The replica ships `prisma db push` for convenience, but a deployable project needs
 * versioned migrations. Two invariants:
 *
 *   1. `prisma/migrations/0001_init/migration.sql` reproduces `schema.prisma` exactly
 *      (checked by `prisma migrate diff` against a throwaway shadow database);
 *   2. `prisma/mysql/schema.prisma` + its baseline are generated from the same models and
 *      are current (`gen-mysql-schema.mjs --check`), so the MySQL target cannot drift
 *      silently.
 *
 * No database server is required: the SQLite diff uses a temp file and the MySQL check only
 * validates/emits DDL.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRISMA = join(ROOT, "apps/backend/prisma");
const BIN = join(ROOT, "node_modules/.bin/prisma");

function sqliteModels(): string[] {
  const schema = readFileSync(join(PRISMA, "schema.prisma"), "utf8");
  const tables = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]);
  return tables.sort();
}

describe("migration baseline", () => {
  it("exists with a lock file naming the provider", () => {
    expect(existsSync(join(PRISMA, "migrations/0001_init/migration.sql"))).toBe(true);
    expect(readFileSync(join(PRISMA, "migrations/migration_lock.toml"), "utf8")).toContain(
      'provider = "sqlite"',
    );
  });

  it("creates every mapped table", () => {
    const sql = readFileSync(join(PRISMA, "migrations/0001_init/migration.sql"), "utf8");
    const missing = sqliteModels().filter((t) => !sql.includes(`"${t}"`));
    expect(missing).toEqual([]);
  });

  it("matches schema.prisma with no drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "relayx-drift-"));
    const shadow = join(dir, "shadow.db");
    try {
      const out = execFileSync(
        BIN,
        [
          "migrate",
          "diff",
          "--from-migrations",
          join(PRISMA, "migrations"),
          "--to-schema-datamodel",
          join(PRISMA, "schema.prisma"),
          "--shadow-database-url",
          `file:${shadow}`,
          "--script",
        ],
        { env: { ...process.env, DATABASE_URL: "file:./verify.db" }, encoding: "utf8" },
      );
      expect(out).toContain("empty migration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("mysql variant", () => {
  it("is generated and current", () => {
    expect(() =>
      execFileSync(process.execPath, [join(ROOT, "apps/backend/scripts/gen-mysql-schema.mjs"), "--check"], {
        encoding: "utf8",
      }),
    ).not.toThrow();
  });

  it("declares the mysql provider and the same tables", () => {
    const schema = readFileSync(join(PRISMA, "mysql/schema.prisma"), "utf8");
    expect(schema).toContain('provider = "mysql"');
    const missing = sqliteModels().filter((t) => !schema.includes(`@@map("${t}")`));
    expect(missing).toEqual([]);
  });

  it("emits valid MySQL DDL for every table", () => {
    const ddl = readFileSync(join(PRISMA, "mysql/migrations/0001_init/migration.sql"), "utf8");
    expect(ddl).toContain("CREATE TABLE");
    const missing = sqliteModels().filter((t) => !ddl.includes("`" + t + "`"));
    expect(missing).toEqual([]);
  });
});
