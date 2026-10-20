"use client";
/** Language switcher (zh-CN ⇄ en). Persists to localStorage and re-renders through useSyncExternalStore. */
import * as React from "react";
import { useSyncExternalStore } from "react";
import { Button } from "./ui/button";
import { getLocale, initLocale, setLocale, subscribeLocale, t, type Locale } from "@/lib/i18n";

export function LocaleSwitch() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => "zh-CN" as Locale);
  React.useEffect(() => initLocale(), []);
  const next: Locale = locale === "zh-CN" ? "en" : "zh-CN";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t("switch_language_a2292f")}
      onClick={() => {
        setLocale(next);
        // Re-render server-rendered text too: a reload keeps the choice (localStorage).
        if (typeof window !== "undefined") window.location.reload();
      }}
    >
      {locale === "zh-CN" ? "EN" : t("zh_7be2d2")}
    </Button>
  );
}
