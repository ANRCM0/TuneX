/**
 * i18n runtime.
 *
 * `t()` resolves a key against the active locale, falling back to zh-CN, then to the key
 * itself. The default locale is zh-CN (the only language the shipped build has); English
 * is a curated subset (see en.ts) that covers navigation, statuses, enum tables and the
 * common actions — untranslated keys intentionally fall back to Chinese rather than
 * showing a placeholder.
 */
import { messages as zhCN, enumTables, tEnum as tEnumZh, type Area } from "./zh-CN";
import { messages as en } from "./en";

export type Locale = "zh-CN" | "en";

const LOCALES: Record<Locale, Record<string, string>> = {
  "zh-CN": Object.assign({}, ...Object.values(zhCN)) as Record<string, string>,
  en: Object.assign({}, ...Object.values(en)) as Record<string, string>,
};

let current: Locale = "zh-CN";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    try {
      window.localStorage.setItem("relayx_locale", next);
    } catch {
      /* private mode */
    }
  }
  listeners.forEach((l) => l());
}

/** Restore a previously chosen locale (call once on the client). */
export function initLocale(): void {
  if (typeof window === "undefined") return;
  try {
    const saved = window.localStorage.getItem("relayx_locale");
    if (saved === "en" || saved === "zh-CN") current = saved;
  } catch {
    /* ignore */
  }
}

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Translate a key. Falls back to zh-CN, then to `fallback`, then to the key. */
export function t(key: string, fallback?: string): string {
  return LOCALES[current][key] ?? LOCALES["zh-CN"][key] ?? fallback ?? key;
}

/** Placeholder-aware translation: `{name}` tokens are substituted from `params`. */
export function tf(key: string, params: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

/** Enum lookup (locale aware once en.ts gains enum translations). */
export function tEnum(table: Parameters<typeof tEnumZh>[0], value: unknown): string {
  const k = String(value ?? "");
  if (current === "en") {
    const enTable = (en as Record<string, string>)[`enum.${table}.${k}`];
    if (typeof enTable === "string") return enTable;
  }
  return tEnumZh(table, value);
}

export { enumTables };
export type { Area };

/** How many keys of a locale resolve (used by the coverage report). */
export function localeCoverage(locale: Locale) {
  const dict = LOCALES[locale];
  const total = Object.keys(LOCALES["zh-CN"]).length;
  const translated = Object.keys(dict).filter((k) => k in LOCALES["zh-CN"]).length;
  return { locale, translated, total, percent: total ? Math.round((translated / total) * 1000) / 10 : 0 };
}
