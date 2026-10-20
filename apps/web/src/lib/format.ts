import { t } from "@/lib/i18n";
import { enumTables, tEnum, type EnumTable } from "./i18n/zh-CN";

/** Display helpers. Upstream mixes GB/GiB and 2-decimal money; keep both explicit. */
export const CYCLE_LABEL: Record<string, string> = {
  month: t("zh_ccf97f"),
  quarter: t("zh_51e67e"),
  half_year: t("zh_89b172"),
  year: t("zh_1017de"),
  lifetime: t("zh_409752"),
};

export const TUNNEL_TYPE_LABEL: Record<string, string> = {
  tcp: "TCP",
  mtcp: t("tcp_8e534e"),
  udp: "UDP",
  relayx: "RelayX",
  wss: t("ws_3f1dad"),
  mwss: t("ws_b43b64"),
  tls: t("tls_9421c0"),
  mtls: t("tls_8f5622"),
  quic: "QUIC",
};

export const IP_TYPE_LABEL: Record<string, string> = { auto: t("zh_4afad8"), ipv4: "IPv4", ipv6: "IPv6" };

export const LOAD_BALANCE_LABEL: Record<string, string> = {
  round: t("zh_65a48f"),
  rand: t("zh_834fd6"),
  fifo: t("zh_0ed683"),
  hash: t("zh_f2b0b1"),
  ll: t("zh_ed9de3"),
  lc: t("zh_21715b"),
};

export function money(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `¥${n.toFixed(2)}` : "—";
}

export function signedMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

/** Bytes-ish traffic column. Upstream shows GB with 4 decimals in some places. */
export function trafficGiB(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(4)} GB`;
}

export function num(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "—";
}

const ENUM_TABLES: Record<string, string>[] = [
  TUNNEL_TYPE_LABEL,
  IP_TYPE_LABEL,
  LOAD_BALANCE_LABEL,
  CYCLE_LABEL,
  { active: t("zh_d4e9ca"), inactive: t("zh_be70be"), primary: t("zh_fc90df"), backup: t("zh_bfd15a") },
  { pending: t("zh_3840a0"), success: t("zh_2a3603"), cancelled: t("zh_a5ffdc") },
  { pending: t("zh_59a9eb"), approved: t("zh_4b3c96"), rejected: t("zh_4c7c52") },
  { percentage: t("zh_4ce634"), fixed: t("zh_b209f7") },
  { alipay: t("zh_66f117"), wechat: t("zh_68406d"), bank: t("zh_0be83e"), usdt: "USDT" },
  {
    round: t("zh_65a48f"),
    rand: t("zh_834fd6"),
    fifo: t("zh_0ed683"),
    hash: t("zh_f2b0b1"),
    ll: t("zh_ed9de3"),
    lc: t("zh_21715b"),
  },
  { cloudflare: "Cloudflare", huawei: t("zh_c1c6f8") },
  { port_forward: t("zh_d62b07"), remote_port_forward: t("zh_699a14") },
  {
    topup: t("account.topUp"),
    plan: t("zh_963fc5"),
    commission_transfer: t("lib.transferCommission"),
    admin_adjust: t("zh_5b4476"),
  },
  {
    referral: t("zh_e6e685"),
    transfer: t("lib.transferCommission"),
    withdraw: t("zh_5b301d"),
    admin_adjust: t("zh_5b4476"),
  },
];

/** Resolve an enum key to its Chinese label using the 19 recovered dictionaries (i18n/zh-CN). */
export function labelEnum(value: unknown): string {
  const key = String(value ?? "");
  for (const table of Object.keys(enumTables) as EnumTable[]) {
    const hit = tEnum(table, key);
    if (hit !== key) return hit;
  }
  return key || "—";
}
