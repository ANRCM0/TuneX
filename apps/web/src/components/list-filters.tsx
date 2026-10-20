"use client";
/**
 * Column filters for list pages.
 *
 * Upstream marks 84 columns as filterable and drives them from `meta.variant`
 * (reports/11 §1.2): text / number / select / multiSelect / date / dateRange / boolean.
 * Filters live in the URL (nuqs) so a filtered list is shareable, exactly like page/perPage/sort.
 */
import * as React from "react";
import { useQueryStates, parseAsString, parseAsArrayOf } from "nuqs";
import { Filter, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { t } from "@/lib/i18n";
import { DatePicker, DateRangePicker } from "./date-picker";

export type FilterVariant = "text" | "number" | "select" | "multiSelect" | "date" | "dateRange" | "boolean";

export type FilterDef = {
  key: string;
  label: string;
  variant: FilterVariant;
  options?: { value: string; label: string }[];
  placeholder?: string;
};

/** Build nuqs parsers from the definitions (one hook call, dynamic keys). */
export function useListFilters(defs: FilterDef[]) {
  const parsers = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const d of defs) {
      out[d.key] = d.variant === "multiSelect" ? parseAsArrayOf(parseAsString).withDefault([]) : parseAsString;
    }
    // nuqs accepts a map of parsers; keys are dynamic so the shape is asserted here.
    return out as Parameters<typeof useQueryStates>[0];
  }, [defs]);

  const [values, setValues] = useQueryStates(parsers, { shallow: true });

  const params = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const d of defs) {
      const v = (values as Record<string, unknown>)[d.key];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[d.key] = v;
    }
    // dateRange expands into <key>_start / <key>_end upstream; keep the raw pair here
    return out;
  }, [defs, values]);

  const active = Object.keys(params).length;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger>
          <Button variant="outline" size="sm">
            <Filter className="size-3.5" /> {t("filters.filters")}
            {active > 0 ? <span className="bg-primary text-primary-foreground rounded px-1 text-[10px]">{active}</span> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-3" align="start">
          {defs.map((d) => (
            <div key={d.key} className="grid gap-1.5">
              <Label className="text-xs">{d.label}</Label>
              {d.variant === "select" ? (
                <Select
                  value={String((values as Record<string, unknown>)[d.key] ?? "all")}
                  onValueChange={(v) => setValues({ [d.key]: v === "all" ? null : v } as never)}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder={d.placeholder ?? t("filters.all")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.all")}</SelectItem>
                    {(d.options ?? []).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : d.variant === "multiSelect" ? (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                  {(d.options ?? []).map((o) => {
                    const cur = ((values as Record<string, string[]>)[d.key] ?? []) as string[];
                    const checked = cur.includes(o.value);
                    return (
                      <label key={o.value} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(c) =>
                            setValues({
                              [d.key]: c ? [...cur, o.value] : cur.filter((x) => x !== o.value),
                            } as never)
                          }
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              ) : d.variant === "date" ? (
                <DatePicker
                  value={String((values as Record<string, unknown>)[d.key] ?? "") || undefined}
                  onChange={(v) => setValues({ [d.key]: v } as never)}
                />
              ) : d.variant === "dateRange" ? (
                <DateRangePicker
                  start={String((values as Record<string, unknown>)[`${d.key}_start`] ?? "") || undefined}
                  end={String((values as Record<string, unknown>)[`${d.key}_end`] ?? "") || undefined}
                  onChange={(next) =>
                    setValues({ [`${d.key}_start`]: next.start, [`${d.key}_end`]: next.end } as never)
                  }
                />
              ) : d.variant === "boolean" ? (
                <Select
                  value={String((values as Record<string, unknown>)[d.key] ?? "all")}
                  onValueChange={(v) => setValues({ [d.key]: v === "all" ? null : v } as never)}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.all")}</SelectItem>
                    <SelectItem value="true">{t("filters.yes")}</SelectItem>
                    <SelectItem value="false">{t("filters.no")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-8"
                  inputMode={d.variant === "number" ? "numeric" : undefined}
                  placeholder={d.placeholder}
                  value={String((values as Record<string, unknown>)[d.key] ?? "")}
                  onChange={(e) => setValues({ [d.key]: e.target.value || null } as never)}
                />
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setValues(Object.fromEntries(defs.map((d) => [d.key, null])) as never)}
          >
            <X className="size-3.5" /> {t("filters.clear")}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );

  return { controls, params, active };
}
