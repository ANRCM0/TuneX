import { formatDate } from "@relayx/shared/date";

/**
 * Upstream: src/utils/date.ts. The original builds MySQL fragments
 * (`CONVERT_TZ(col,'+00:00','+08:00')`, `DATE_FORMAT(...)`) for the raw aggregate
 * queries in the stats endpoints. SQLite has neither function, so the fragments are
 * rewritten against `strftime`/`datetime`. Prisma stores `DateTime` on SQLite as an
 * INTEGER holding unix milliseconds, hence the `/1000` + `'unixepoch'` step.
 *
 * Deviation recorded in docs/DEVIATIONS.md §3.
 */

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

/** SQL fragment converting a stored UTC datetime into Asia/Shanghai local time. */
export const toLocalTZ = (column: string): string => `datetime(${column} / 1000, 'unixepoch', '+8 hours')`;

/** SQL fragment bucketing a datetime column by day / month / year. */
export const getDateGroupBy = (column: string, aggregate_by?: string): string => {
  const local = toLocalTZ(column);
  if (aggregate_by === "month") {
    return `strftime('%Y-%m', ${local})`;
  }
  if (aggregate_by === "year") {
    return `strftime('%Y', ${local})`;
  }
  return `date(${local})`;
};

export const formatStatsDate = (value: unknown, aggregate_by?: string): string => {
  if (aggregate_by === "month" || aggregate_by === "year") {
    return String(value);
  }
  return formatDate(value as Date);
};
