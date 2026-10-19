/**
 * Throwaway SQLite database for integration tests.
 *
 * Creates a temp directory, runs `prisma db push --skip-generate` against it and
 * returns the `file:` URL plus a cleanup function. Callers must set
 * `process.env.DATABASE_URL` before importing `apps/backend/src/db.ts`, because the
 * Prisma client reads it when the module is evaluated.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface TempDatabase {
  url: string;
  path: string;
  cleanup: () => void;
}

export function createTempDatabase(name: string): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), `relayx-${name}-`));
  const path = join(dir, "test.db");
  const url = `file:${path}`;
  execFileSync(
    join(ROOT, "node_modules", ".bin", "prisma"),
    ["db", "push", "--skip-generate", `--schema=${join(ROOT, "apps/backend/prisma/schema.prisma")}`],
    { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
  );
  return {
    url,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
