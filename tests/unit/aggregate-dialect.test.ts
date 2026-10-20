/**
 * The aggregate queries must not know which engine they run on.
 *
 * `apps/backend/src/utils/date.ts` is the only module allowed to mention a dialect. The five
 * call sites that interpolate date SQL — the stats service and the plan / topup / tunnel /
 * user routers — have to go through its helpers, otherwise a hand-written
 * `datetime('now', …)` (SQLite) or `NOW() - INTERVAL …` (MySQL) reappears and one of the two
 * targets becomes a syntax error again. This suite is the cheap local guard for that; the
 * workflow's HTTP step is the expensive proof.
 *
 * Comments are skipped: documenting both branches is fine, building SQL from one is not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getDateGroupBy,
  localNowMinusDays,
  toLocalTZ,
  utcNowMinusDays,
} from "../../apps/backend/src/utils/date";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CONSUMERS = [
  "apps/backend/src/services/stats.ts",
  "apps/backend/src/routes/admin/plan.ts",
  "apps/backend/src/routes/admin/topup.ts",
  "apps/backend/src/routes/tunnel.ts",
  "apps/backend/src/routes/user.ts",
];

/** Functions / literals that belong to exactly one engine. */
const DIALECT_TOKENS = [
  "strftime",
  "unixepoch",
  "CONVERT_TZ",
  "DATE_FORMAT",
  "UTC_TIMESTAMP",
  "datetime(",
  "NOW(",
];

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/** Drop block-comment bodies and `//` lines so prose may name the dialects. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

describe("aggregate SQL is dialect-neutral at the call sites", () => {
  for (const file of CONSUMERS) {
    it(`${file} delegates every date fragment to utils/date`, () => {
      const code = codeOnly(read(file));
      const hits = DIALECT_TOKENS.filter((token) => code.includes(token));
      expect(hits, `${file} hand-writes ${hits.join(", ")}`).toEqual([]);
      expect(code).toContain("utils/date");
    });
  }

  it("utils/date.ts is the single place that knows both dialects", () => {
    const source = read("apps/backend/src/utils/date.ts");
    expect(source).toContain("unixepoch");
    expect(source).toContain("strftime");
    expect(source).toContain("CONVERT_TZ");
    expect(source).toContain("DATE_FORMAT");
  });
});

describe("MySQL composition", () => {
  it("builds a plan-order dashboard query with no SQLite function in it", () => {
    const local = toLocalTZ("created_at", "mysql");
    const group = getDateGroupBy("created_at", "day", "mysql");
    const sql = `SELECT ${group} as date, SUM(price) as total FROM plan_order WHERE ${local} >= ${localNowMinusDays(
      30,
      "mysql",
    )} GROUP BY ${group} ORDER BY ${group}`;
    expect(sql).not.toMatch(/unixepoch|strftime|datetime\(/i);
    expect(sql).toContain("CONVERT_TZ(created_at, '+00:00', '+08:00')");
    expect(sql).toContain("INTERVAL 30 DAY");
  });

  it("builds the tunnel traffic query with the UTC bound the route has always used", () => {
    const local = toLocalTZ("tunnel_traffic.date", "mysql");
    const group = getDateGroupBy("tunnel_traffic.date", "month", "mysql");
    const sql = `SELECT ${group} AS date, SUM(tunnel_traffic.traffic) AS traffic FROM tunnel_traffic WHERE ${local} > ${utcNowMinusDays(
      365,
      "mysql",
    )} GROUP BY ${group} ORDER BY ${group}`;
    expect(sql).not.toMatch(/unixepoch|strftime|datetime\(/i);
    expect(sql).toContain("DATE_SUB(UTC_TIMESTAMP(), INTERVAL 365 DAY)");
  });
});
