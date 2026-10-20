import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDateGroupBy,
  getDateInterval,
  localNowMinusDays,
  sqlDialect,
  toLocalTZ,
  utcNowMinusDays,
} from "../../apps/backend/src/utils/date";

describe("date helpers", () => {
  it("emits SQLite fragments that divide unix-ms by 1000 and add 8 hours", () => {
    expect(toLocalTZ("created_at", "sqlite")).toBe("datetime(created_at / 1000, 'unixepoch', '+8 hours')");
    expect(getDateGroupBy("created_at", undefined, "sqlite")).toBe(
      "date(datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateGroupBy("created_at", "day", "sqlite")).toBe(
      "date(datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateGroupBy("created_at", "month", "sqlite")).toBe(
      "strftime('%Y-%m', datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateGroupBy("created_at", "year", "sqlite")).toBe(
      "strftime('%Y', datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateInterval("day")).toBe(30);
    expect(getDateInterval("month")).toBe(365);
    expect(getDateInterval("year")).toBe(3650);
  });

  it("buckets a month rollover and a year rollover in Asia/Shanghai", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (created_at INTEGER)");
    const insert = db.prepare("INSERT INTO t (created_at) VALUES (?)");
    // 2024-12-31 15:59:59Z is still 2024-12-31 23:59:59 in +8.
    // 2024-12-31 16:00:00Z is 2025-01-01 00:00:00 in +8 (year and month both roll).
    const before = Date.UTC(2024, 11, 31, 15, 59, 59);
    const after = Date.UTC(2024, 11, 31, 16, 0, 0);
    insert.run(before);
    insert.run(after);

    const day = getDateGroupBy("created_at", "day", "sqlite");
    const month = getDateGroupBy("created_at", "month", "sqlite");
    const year = getDateGroupBy("created_at", "year", "sqlite");
    const rows = db
      .prepare(
        `SELECT created_at, ${day} AS day, ${month} AS month, ${year} AS year FROM t ORDER BY created_at`,
      )
      .all() as { day: string; month: string; year: string }[];

    expect(rows[0]).toMatchObject({ day: "2024-12-31", month: "2024-12", year: "2024" });
    expect(rows[1]).toMatchObject({ day: "2025-01-01", month: "2025-01", year: "2025" });
    db.close();
  });

  it("executes the SQLite NOW()-style bounds and keeps them ~n days apart", () => {
    const db = new DatabaseSync(":memory:");
    const row = db
      .prepare(
        `SELECT ${localNowMinusDays(30, "sqlite")} AS local30,
                ${utcNowMinusDays(30, "sqlite")} AS utc30`,
      )
      .get() as { local30: string; utc30: string };
    db.close();
    expect(row.local30).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.utc30).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const skew = Date.parse(`${row.local30}Z`) - Date.parse(`${row.utc30}Z`);
    expect(Math.abs(skew - 8 * 60 * 60 * 1000)).toBeLessThan(2000);
  });
});

describe("dialect switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects MySQL from a mysql:// DATABASE_URL and SQLite otherwise", () => {
    expect(sqlDialect("mysql://root:pass@127.0.0.1:3306/relayx")).toBe("mysql");
    expect(sqlDialect("  MySQL://root@127.0.0.1/relayx")).toBe("mysql");
    expect(sqlDialect("file:./dev.db")).toBe("sqlite");
    expect(sqlDialect("postgresql://nope")).toBe("sqlite");
    expect(sqlDialect(undefined)).toBe("sqlite");
  });

  it("reads DATABASE_URL at call time, so the generated client and the SQL agree", () => {
    vi.stubEnv("DATABASE_URL", "mysql://root@127.0.0.1:3306/relayx");
    expect(toLocalTZ("created_at")).toContain("CONVERT_TZ");
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
    expect(toLocalTZ("created_at")).toContain("unixepoch");
  });

  it("emits MySQL fragments that render Shanghai wall-clock text without the /1000 step", () => {
    expect(toLocalTZ("created_at", "mysql")).toBe(
      "DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m-%d %H:%i:%s')",
    );
    expect(getDateGroupBy("created_at", undefined, "mysql")).toBe(
      "DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m-%d')",
    );
    expect(getDateGroupBy("created_at", "month", "mysql")).toBe(
      "DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m')",
    );
    expect(getDateGroupBy("created_at", "year", "mysql")).toBe(
      "DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y')",
    );
    expect(localNowMinusDays(30, "mysql")).toBe(
      "DATE_FORMAT(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00'), INTERVAL 30 DAY), '%Y-%m-%d %H:%i:%s')",
    );
    expect(utcNowMinusDays(30, "mysql")).toBe(
      "DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY), '%Y-%m-%d %H:%i:%s')",
    );
  });

  it("never mixes SQLite-only functions into a MySQL fragment", () => {
    const mysqlFragments = [
      toLocalTZ("created_at", "mysql"),
      getDateGroupBy("created_at", "day", "mysql"),
      getDateGroupBy("created_at", "month", "mysql"),
      getDateGroupBy("created_at", "year", "mysql"),
      localNowMinusDays(365, "mysql"),
      utcNowMinusDays(3650, "mysql"),
    ];
    for (const fragment of mysqlFragments) {
      expect(fragment).not.toMatch(/strftime|unixepoch|datetime\(/i);
      // DATE_FORMAT is the only bucket function, and only for the formats above.
      expect(fragment).toMatch(/^DATE_FORMAT\(/);
    }
  });

  it("refuses a non-integer interval instead of interpolating it", () => {
    expect(() => localNowMinusDays(1.5, "mysql")).toThrow(/non-negative integer/);
    expect(() => utcNowMinusDays(-1, "sqlite")).toThrow(/non-negative integer/);
  });
});
