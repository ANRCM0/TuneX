"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Range input styled like shadcn's slider (upstream uses radix slider). */
export function Slider({
  value = [0],
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  className,
}: {
  value?: number[];
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (v: number[]) => void;
  className?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value[0] ?? min}
      onChange={(e) => onValueChange?.([Number(e.target.value)])}
      className={cn(
        "accent-primary h-2 w-full cursor-pointer appearance-none rounded-full bg-muted",
        className,
      )}
    />
  );
}
