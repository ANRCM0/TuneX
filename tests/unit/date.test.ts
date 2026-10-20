import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getDateGroupBy, getDateInterval, toLocalTZ } from "../../apps/backend/src/utils/date";

describe("date helpers", () => {
  it("emits SQLite fragments that divide unix-ms by 1000 and add 8 hours", () => {
    expect(toLocalTZ("created_at")).toBe("datetime(created_at / 1000, 'unixepoch', '+8 hours')");
    expect(getDateGroupBy("created_at")).toBe("date(datetime(created_at / 1000, 'unixepoch', '+8 hours'))");
    expect(getDateGroupBy("created_at", "day")).toBe(
      "date(datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateGroupBy("created_at", "month")).toBe(
      "strftime('%Y-%m', datetime(created_at / 1000, 'unixepoch', '+8 hours'))",
    );
    expect(getDateGroupBy("created_at", "year")).toBe(
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

    const day = getDateGroupBy("created_at", "day");
    const month = getDateGroupBy("created_at", "month");
    const year = getDateGroupBy("created_at", "year");
    const rows = db
      .prepare(
        `SELECT created_at, ${day} AS day, ${month} AS month, ${year} AS year FROM t ORDER BY created_at`,
      )
      .all() as { day: string; month: string; year: string }[];

    expect(rows[0]).toMatchObject({ day: "2024-12-31", month: "2024-12", year: "2024" });
    expect(rows[1]).toMatchObject({ day: "2025-01-01", month: "2025-01", year: "2025" });
    db.close();
  });
});
