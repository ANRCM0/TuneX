import { formatDate } from "@relayx/shared/date";

/**
 * SQL fragments for the raw aggregate queries, in both engines this repository targets.
 *
 * Upstream: src/utils/date.ts interpolates MySQL fragments (`CONVERT_TZ(col,'+00:00','+08:00')`,
 * `DATE_FORMAT(...)`) into the stats SQL. The replica also runs on SQLite out of the box,
 * which has neither function, so every fragment exists twice and the branch is chosen at call
 * time from `DATABASE_URL`.
 *
 * Both branches are deliberately kept behaviourally identical:
 *   - each renders the stored UTC value as an Asia/Shanghai wall clock;
 *   - each returns TEXT in a fixed `YYYY-MM-DD HH:MM:SS` / `YYYY-MM-DD` / `YYYY-MM` / `YYYY`
 *     shape, so bounds interpolated or bound by the routes compare lexicographically, which
 *     for that format is also chronological;
 *   - Prisma therefore hands the bucketed `date` column back as a string on both engines,
 *     which is what `formatStatsDate` expects.
 * SQLite stores `DateTime` as INTEGER unix milliseconds, hence the `/1000` + `'unixepoch'`
 * step; MySQL stores `DATETIME(3)` in UTC, so the value is used as-is.
 *
 * Deviation recorded in docs/DEVIATIONS.md §3 and docs/MYSQL.md.
 */

export type SqlDialect = "sqlite" | "mysql";

/**
 * Engine selection for the raw SQL.
 *
 * Prisma requires the datasource provider to be a string literal, so the target is chosen by
 * which schema generated the client: `prisma/schema.prisma` (SQLite, `file:` URL) or
 * `prisma/mysql/schema.prisma` (MySQL, `mysql://` URL). `DATABASE_URL` is therefore the only
 * signal available at runtime, and it is also what Prisma itself reads.
 */
export const sqlDialect = (url: string | undefined = process.env.DATABASE_URL): SqlDialect =>
  /^\s*mysql/i.test(url ?? "") ? "mysql" : "sqlite";

/** Number of days of history a given aggregation bucket covers. */
export const getDateInterval = (aggregate_by?: string): number => {
  if (aggregate_by === "day" || !aggregate_by) {
    return 30;
  }
  if (aggregate_by === "month") {
    return 365;
  }
  return 365 * 10;
};

export const TZ_OFFSET = "+08:00";
/** Prisma writes `DateTime` to MySQL as UTC; SQLite keeps unix milliseconds (also UTC). */
const UTC_OFFSET = "+00:00";
/** The one text shape both engines render, so string bounds behave the same on both. */
const MYSQL_LOCAL_FORMAT = "%Y-%m-%d %H:%i:%s";

const sqliteLocal = (column: string): string => `datetime(${column} / 1000, 'unixepoch', '+8 hours')`;
const mysqlLocal = (column: string): string => `CONVERT_TZ(${column}, '${UTC_OFFSET}', '${TZ_OFFSET}')`;

/** SQL fragment converting a stored UTC datetime into an Asia/Shanghai wall-clock string. */
export const toLocalTZ = (column: string, dialect: SqlDialect = sqlDialect()): string =>
  dialect === "mysql" ? `DATE_FORMAT(${mysqlLocal(column)}, '${MYSQL_LOCAL_FORMAT}')` : sqliteLocal(column);

/** SQL fragment bucketing a datetime column by day / month / year. */
export const getDateGroupBy = (
  column: string,
  aggregate_by?: string,
  dialect: SqlDialect = sqlDialect(),
): string => {
  if (dialect === "mysql") {
    const format = aggregate_by === "month" ? "%Y-%m" : aggregate_by === "year" ? "%Y" : "%Y-%m-%d";
    return `DATE_FORMAT(${mysqlLocal(column)}, '${format}')`;
  }
  const local = sqliteLocal(column);
  if (aggregate_by === "month") {
    return `strftime('%Y-%m', ${local})`;
  }
  if (aggregate_by === "year") {
    return `strftime('%Y', ${local})`;
  }
  return `date(${local})`;
};

/**
 * Guard for the interval interpolated into the `NOW()`-style bounds below. It always comes
 * from `getDateInterval`, so this only protects the SQL builders from a future caller
 * passing something that is not a plain day count.
 */
const intervalDays = (days: number): number => {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`interval days must be a non-negative integer, got ${String(days)}`);
  }
  return days;
};

/**
 * Lower bound used when a request passes no `start_date`: "now minus n days" in
 * Asia/Shanghai, shaped like `toLocalTZ` so the comparison stays text-to-text on both
 * engines. Upstream interpolated MySQL `NOW() - INTERVAL n DAY`.
 *
 * `NOW()` would be session-timezone dependent, so the MySQL branch derives the local wall
 * clock from `UTC_TIMESTAMP()` instead, exactly like `toLocalTZ` does for stored columns.
 */
export const localNowMinusDays = (days: number, dialect: SqlDialect = sqlDialect()): string => {
  const n = intervalDays(days);
  return dialect === "mysql"
    ? `DATE_FORMAT(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(), '${UTC_OFFSET}', '${TZ_OFFSET}'), INTERVAL ${n} DAY), '${MYSQL_LOCAL_FORMAT}')`
    : `datetime('now', '+8 hours', '-${n} days')`;
};

/**
 * Same bound in UTC. `/tunnel/traffic/stats` has always compared the Asia/Shanghai rendering
 * of `tunnel_traffic.date` against a plain `datetime('now', …)` (upstream: `NOW()`), so the
 * eight-hour skew is preserved rather than silently "fixed" here.
 */
export const utcNowMinusDays = (days: number, dialect: SqlDialect = sqlDialect()): string => {
  const n = intervalDays(days);
  return dialect === "mysql"
    ? `DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${n} DAY), '${MYSQL_LOCAL_FORMAT}')`
    : `datetime('now', '-${n} days')`;
};

export const formatStatsDate = (value: unknown, aggregate_by?: string): string => {
  if (aggregate_by === "month" || aggregate_by === "year") {
    return String(value);
  }
  return formatDate(value as Date);
};
