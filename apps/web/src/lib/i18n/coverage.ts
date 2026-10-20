/** Dictionary coverage helpers (used by the report and by smoke checks). */
import { messages, type Area } from "./zh-CN";
import { localeCoverage, type Locale } from "./index";

export function areaSizes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(messages) as Area[]) out[k] = Object.keys(messages[k]).length;
  return out;
}

export function coverageSummary() {
  const sizes = areaSizes();
  const areas = Object.keys(sizes).sort((a, b) => sizes[b] - sizes[a]);
  return {
    totalKeys: Object.values(sizes).reduce((a, b) => a + b, 0),
    areas: areas.length,
    largest: areas.slice(0, 8).map((a) => ({ area: a, keys: sizes[a] })),
  };
}

export function locales(): ReturnType<typeof localeCoverage>[] {
  return (["zh-CN", "en"] as Locale[]).map((l) => localeCoverage(l));
}
