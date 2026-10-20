"use client";
/**
 * Month calendar (react-day-picker v8, same major as the shipped bundle).
 * Upstream wraps it in a Popover for date / date-range filters; see date-picker.tsx.
 */
import * as React from "react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "date-fns/locale";
import { cn } from "@/lib/utils";
import "react-day-picker/dist/style.css";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, ...props }: CalendarProps) {
  return (
    <DayPicker
      locale={zhCN}
      showOutsideDays
      className={cn("p-2", className)}
      classNames={{
        months: "flex flex-col gap-2",
        month: "space-y-2",
        caption: "flex items-center justify-between px-1",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        nav_button: "border rounded-md size-7 inline-flex items-center justify-center hover:bg-accent",
        table: "w-full border-collapse",
        head_row: "flex",
        head_cell: "text-muted-foreground w-8 text-[11px] font-normal",
        row: "flex w-full mt-1",
        cell: "size-8 text-center text-sm p-0",
        day: "size-8 rounded-md hover:bg-accent",
        day_selected: "bg-primary text-primary-foreground hover:bg-primary",
        day_today: "border border-ring",
        day_outside: "text-muted-foreground/50",
        day_disabled: "text-muted-foreground/30",
      }}
      {...props}
    />
  );
}
