/**
 * packages/shared/src/date.ts
 *
 * Evidence: relayx-analysis/work/shared/001__packages__shared__src__date.ts:1-21
 * The panel formats every user-visible date in the Asia/Shanghai zone regardless of
 * the server zone; TZ is exported so callers can reuse it.
 */
import { format } from "date-fns";
import { tz } from "@date-fns/tz";

export const TZ = "Asia/Shanghai";

export const formatDate = (date: Date | number | string, timezone: string = TZ): string => {
  return format(date, "yyyy-MM-dd", { in: tz(timezone) });
};

export const formatDateTime = (date: Date | number | string, timezone: string = TZ): string => {
  return format(date, "yyyy-MM-dd HH:mm:ss", { in: tz(timezone) });
};
