import { Badge } from "./badge";
import { cn } from "@/lib/utils";
import { enumTables, t } from "@/lib/i18n";

/**
 * Status -> colour mapping recovered verbatim from module 510914
 * (work/all_modules/0-2840ef9wv98__510914.js).
 * Labels come from the four upstream maps merged in the same module, plus in/out.
 */
const STATUS_CLASS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  primary: "bg-green-100 text-green-800",
  success: "bg-green-100 text-green-800",
  approved: "bg-green-100 text-green-800",
  open: "bg-blue-100 text-blue-800",
  in: "bg-blue-100 text-blue-800",
  inactive: "bg-red-100 text-red-800",
  backup: "bg-red-100 text-red-800",
  rejected: "bg-red-100 text-red-800",
  pending: "bg-yellow-100 text-yellow-800",
  cancelled: "bg-gray-100 text-gray-800",
  closed: "bg-gray-100 text-gray-800",
  out: "bg-purple-100 text-purple-800",
};

/** Labels now come from the extracted dictionary (i18n/zh-CN) instead of local literals. */
export const STATUS_MAP = enumTables.STATUS_MAP;
export const BACKUP_STATUS_MAP = enumTables.BACKUP_STATUS_MAP;
export const TOPUP_ORDER_STATUS_MAP = enumTables.TOPUP_ORDER_STATUS_MAP;
export const WITHDRAW_STATUS_MAP = enumTables.WITHDRAW_STATUS_MAP;

const LABEL: Record<string, string> = {
  ...STATUS_MAP,
  ...BACKUP_STATUS_MAP,
  ...TOPUP_ORDER_STATUS_MAP,
  ...WITHDRAW_STATUS_MAP,
  in: t("zh_38e9cd"),
  out: t("zh_dd877e"),
  open: t("zh_65fc81"),
  closed: t("zh_f62876"),
};

export function BadgeStatus({ status, className }: { status: string; className?: string }) {
  return (
    <Badge className={cn(STATUS_CLASS[status], className)}>{LABEL[status] ?? status}</Badge>
  );
}
