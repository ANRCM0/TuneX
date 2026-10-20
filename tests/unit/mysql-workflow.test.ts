/**
 * The MySQL workflow and its pieces, checked without a MySQL server.
 *
 * The workflow itself only runs on GitHub Actions (needs a service container), but its
 * contract can be asserted here:
 *
 *   - the YAML is valid and targets a mysql service, not the SQLite default;
 *   - the generator's `--check` is read-only (a CI check step must not repair the file it is
 *     checking, otherwise a stale artifact silently passes);
 *   - the smoke script refuses a non-mysql URL instead of "passing" against SQLite;
 *   - the documented SQLite-only surface still exists, so the docs' known-gap section stays
 *     truthful.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW = join(ROOT, ".github/workflows/mysql.yml");
const GENERATOR = join(ROOT, "apps/backend/scripts/gen-mysql-schema.mjs");
const SMOKE = join(ROOT, "apps/backend/scripts/mysql-smoke.mjs");
const ENDPOINT_SMOKE = join(ROOT, "apps/backend/scripts/mysql-endpoints-smoke.mjs");
const MYSQL_SCHEMA = join(ROOT, "apps/backend/prisma/mysql/schema.prisma");
const DATE_UTILS = join(ROOT, "apps/backend/src/utils/date.ts");

const workflow = readFileSync(WORKFLOW, "utf8");

describe("mysql workflow", () => {
  it("runs against a mysql service container and a mysql URL", () => {
    expect(workflow).toContain("image: mysql:8.0");
    expect(workflow).toContain('DATABASE_URL: "mysql://');
    expect(workflow).toContain("--health-cmd");
  });

  it("applies the baseline, checks drift, generates from the mysql schema, then boots it", () => {
    // Distinctive needles only: the header comment also mentions `prisma migrate diff`.
    const order = [
      "run: pnpm db:mysql:deploy",
      "--from-migrations apps/backend/prisma/mysql/migrations",
      "run: npx prisma generate --schema apps/backend/prisma/mysql/schema.prisma",
      "run: pnpm test:mysql",
      "run: node scripts/mysql-smoke.mjs",
      "run: node scripts/mysql-endpoints-smoke.mjs",
    ].map((needle) => workflow.indexOf(needle));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gives every suite its own MySQL database so files run in parallel", () => {
    expect(workflow).toContain("RELAYX_TEST_DIALECT: mysql");
    expect(workflow).toContain("pnpm test:mysql");
    // Crashed suites leave databases behind; the job sweeps them either way.
    expect(workflow).toContain("node scripts/mysql-test-db.mjs sweep");

    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
      string,
      string
    >;
    expect(scripts["test:mysql"]).toContain("RELAYX_TEST_DIALECT=mysql");
    // Isolation is per database now, so the run must not be serialised.
    expect(scripts["test:mysql"]).not.toContain("--no-file-parallelism");

    const helper = readFileSync(join(ROOT, "tests/helpers/temp-db.ts"), "utf8");
    expect(helper).toContain("RELAYX_TEST_DIALECT");
    expect(helper).toContain("mysql-test-db.mjs");
    expect(helper).toContain("relayx_t_");
    // Slots are claimed with an atomically created lock file, released on exit, and a busy
    // pool degrades to a private database instead of deadlocking the run.
    expect(helper).toContain('openSync(lockPath, "wx"');
    expect(helper).toContain("releaseSlot");
    expect(helper).toContain('process.once("exit"');
    expect(helper).toContain("relayx_t_e${process.pid}");
    // The SQLite branch must keep working: it is the default checkout.
    expect(helper).toContain("mkdtempSync");
    expect(helper).toContain("schema.prisma");
  });

  it("replays the committed baseline DDL into each suite database", async () => {
    // The harness executes the same statements CI applies; if the splitter mis-parses the
    // generated file, every MySQL suite fails with a fragment instead of a statement.
    const { splitStatements, withDatabase } = await import("../../apps/backend/scripts/mysql-test-db.mjs");
    const ddl = readFileSync(
      join(ROOT, "apps/backend/prisma/mysql/migrations/0001_init/migration.sql"),
      "utf8",
    );
    const statements = splitStatements(ddl) as string[];
    expect(statements.length).toBeGreaterThan(30);
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(25);
    expect(
      statements.filter((statement) => !/^(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX)/.test(statement)),
    ).toEqual([]);

    expect(withDatabase("mysql://u:p@127.0.0.1:3306/base?connection_limit=5", "relayx_t_x_1")).toBe(
      "mysql://u:p@127.0.0.1:3306/relayx_t_x_1?connection_limit=5",
    );
  });

  it("fails the job when either dialect branch or the documented gaps disappear", () => {
    expect(workflow).toContain('grep -q "unixepoch" apps/backend/src/utils/date.ts');
    expect(workflow).toContain('grep -q "CONVERT_TZ" apps/backend/src/utils/date.ts');
    expect(workflow).toContain('grep -q "Known gaps" docs/MYSQL.md');
    const dateSource = readFileSync(DATE_UTILS, "utf8");
    expect(dateSource).toContain("unixepoch");
    expect(dateSource).toContain("strftime");
    expect(dateSource).toContain("CONVERT_TZ");
    expect(dateSource).toContain("DATE_FORMAT");
  });

  it("restores the upstream native column types in the generated variant", () => {
    // Running the suite on MySQL caught `P2000: content too long`: without native types the
    // generator would default every String to VARCHAR(191), while upstream uses VARCHAR(255)
    // and TEXT. Both the schema and the baseline DDL must carry them.
    const mysqlSchema = readFileSync(MYSQL_SCHEMA, "utf8");
    expect(mysqlSchema).toContain("@db.Text");
    expect(mysqlSchema).toContain("@db.VarChar(255)");
    const baseline = readFileSync(
      join(ROOT, "apps/backend/prisma/mysql/migrations/0001_init/migration.sql"),
      "utf8",
    );
    expect(baseline).toContain("`content` TEXT NOT NULL");
    expect(baseline).toContain("`pay_url` TEXT NOT NULL");
    expect(baseline).toContain("`name` VARCHAR(255) NOT NULL");
    // SQLite keeps no native types on its fields (its header comment may mention them); the
    // generator only adds them to the MySQL variant.
    const sqliteSchema = readFileSync(join(ROOT, "apps/backend/prisma/schema.prisma"), "utf8");
    const fieldLines = sqliteSchema.split("\n").filter((line) => /^\s+\w+\s+(String|Json)/.test(line));
    expect(fieldLines.length).toBeGreaterThan(0);
    expect(fieldLines.filter((line) => line.includes("@db."))).toEqual([]);
  });

  it("boots the backend on MySQL and hits every dialect-switched aggregate endpoint", () => {
    expect(workflow).toContain("node scripts/mysql-endpoints-smoke.mjs");
    const smoke = readFileSync(ENDPOINT_SMOKE, "utf8");
    for (const path of [
      "/admin/stats",
      "/admin/stats/user",
      "/admin/stats/traffic",
      "/admin/plan/stats",
      "/admin/topup/stats",
      "/tunnel/traffic/stats",
      "/user/referral/stats",
    ]) {
      expect(smoke, `endpoint smoke does not call ${path}`).toContain(path);
    }
    // The undated requests are what exercise `localNowMinusDays` / `utcNowMinusDays`, and
    // the seeded super admin is the bearer identity for them.
    expect(smoke).toContain("super_admin: true");
    expect(smoke).toMatch(/aggregate_by=(day|month|year)/);
  });
});

describe("generator --check is read-only", () => {
  it("does not repair a stale schema, and reports it", () => {
    const original = readFileSync(MYSQL_SCHEMA, "utf8");
    try {
      writeFileSync(MYSQL_SCHEMA, `${original}\n// drift marker\n`);
      let failed = false;
      try {
        execFileSync(process.execPath, [GENERATOR, "--check"], { encoding: "utf8", stdio: "pipe" });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      // The check must not have rewritten the file it just called stale.
      expect(readFileSync(MYSQL_SCHEMA, "utf8")).toContain("// drift marker");
    } finally {
      writeFileSync(MYSQL_SCHEMA, original);
    }
    // Restored input passes again.
    expect(() => execFileSync(process.execPath, [GENERATOR, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("accepts the committed artefacts", () => {
    expect(() => execFileSync(process.execPath, [GENERATOR, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("smoke script guard", () => {
  it("refuses a non-mysql DATABASE_URL instead of testing SQLite", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SMOKE], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: "file:./verify.db" },
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
    }
    expect(status).toBe(2);
  });

  it("refuses a non-mysql DATABASE_URL before it seeds or boots anything", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [ENDPOINT_SMOKE], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: "file:./verify.db" },
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 1;
      stderr = failure.stderr ?? "";
    }
    expect(status).toBe(2);
    expect(stderr).toContain("must be a mysql:// URL");
  });
});
