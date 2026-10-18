/**
 * Timestamps in the exact format the Python reference emits:
 *   "%Y-%m-%dT%H:%M:%S.000Z"   (second precision, always `.000` fractional part)
 *
 * `utcnow()` and `isoInDays()` mirror `utcnow()` / `iso_in_days()` in
 * `relayx-analysis/relayx_license_server.py`.
 */

const ISO_SECOND_LENGTH = "YYYY-MM-DDTHH:MM:SS".length;

/** `YYYY-MM-DDTHH:MM:SS.000Z` for the current instant. */
export function utcnow(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, ISO_SECOND_LENGTH)}.000Z`;
}

/** `YYYY-MM-DDTHH:MM:SS.000Z` for `days` days from now (fractional days allowed). */
export function isoInDays(days: number, now: Date = new Date()): string {
  return utcnow(new Date(now.getTime() + days * 86_400_000));
}

/** Unix seconds — the `iat` field of the license payload. */
export function unixSeconds(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}
