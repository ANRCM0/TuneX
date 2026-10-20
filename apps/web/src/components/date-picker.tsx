"use client";
/**
 * Date / date-range picker for list filters.
 *
 * Upstream ships a DateTimePicker (react-day-picker in a Popover) and the filter panel
 * exposes `date` and `dateRange` variants. Values are emitted in the format the backend
 * queries expect (`YYYY-MM-DD` for list filters, ISO for absolute timestamps).
 */
import * as React from "react";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const fmt = (d?: Date) =>
  d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : "";

export function DatePicker({
  value,
  onChange,
  placeholder,
  className,
}: {
  value?: string;
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  const [open, setOpen] = React.useState(false);
  return (
    <Popover>
      <PopoverTrigger>
        <span className="inline-flex w-full">
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full justify-start gap-2 font-normal", className)}
            onClick={() => setOpen(true)}
          >
            <CalendarIcon className="size-3.5" />
            <span className={cn(!value && "text-muted-foreground")}>
              {value || placeholder || t("filters.pickDate")}
            </span>
            {value ? (
              <X
                className="ml-auto size-3.5 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            ) : null}
          </Button>
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" forceOpen={open}>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            onChange(fmt(d));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function DateRangePicker({
  start,
  end,
  onChange,
  className,
}: {
  start?: string;
  end?: string;
  onChange: (next: { start: string | null; end: string | null }) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const range: DateRange | undefined =
    start || end
      ? {
          from: start ? new Date(`${start}T00:00:00`) : undefined,
          to: end ? new Date(`${end}T00:00:00`) : undefined,
        }
      : undefined;

  return (
    <Popover>
      <PopoverTrigger>
        <span className="inline-flex w-full">
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full justify-start gap-2 font-normal", className)}
            onClick={() => setOpen(true)}
          >
            <CalendarIcon className="size-3.5" />
            <span className={cn(!start && !end && "text-muted-foreground")}>
              {start || end ? `${start || "…"} → ${end || "…"}` : t("filters.pickRange")}
            </span>
            {start || end ? (
              <X
                className="ml-auto size-3.5 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({ start: null, end: null });
                }}
              />
            ) : null}
          </Button>
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" forceOpen={open}>
        <Calendar
          mode="range"
          selected={range}
          numberOfMonths={2}
          onSelect={(r) => {
            onChange({ start: fmt(r?.from), end: fmt(r?.to) });
            if (r?.from && r?.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
