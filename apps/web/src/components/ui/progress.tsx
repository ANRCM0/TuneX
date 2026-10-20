"use client";
import { cn } from "@/lib/utils";

/** Progress bar (upstream: @radix-ui/react-progress). */
export function Progress({
  value = 0,
  className,
  barClassName,
}: {
  value?: number;
  className?: string;
  barClassName?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
    >
      <div className={cn("bg-primary h-full transition-all", barClassName)} style={{ width: `${pct}%` }} />
    </div>
  );
}
