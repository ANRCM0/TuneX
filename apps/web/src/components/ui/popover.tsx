"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight popover (no radix dependency): click-outside + Escape to close.
 * Upstream uses @radix-ui/react-popover; behaviour for a filter panel is equivalent.
 */
export function Popover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref} data-open={open}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(
              child as React.ReactElement<{ onOpenChange?: (v: boolean) => void; forceOpen?: boolean }>,
              {
                onOpenChange: setOpen,
                forceOpen: open,
              },
            )
          : child,
      )}
    </div>
  );
}

export function PopoverTrigger({
  children,
  onOpenChange,
}: {
  children: React.ReactNode;
  onOpenChange?: (v: boolean) => void;
}) {
  return (
    <span onClick={() => onOpenChange?.(true)} className="inline-flex">
      {children}
    </span>
  );
}

export function PopoverContent({
  children,
  className,
  align = "start",
  forceOpen,
}: {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end";
  forceOpen?: boolean;
}) {
  if (!forceOpen) return null;
  return (
    <div
      className={cn(
        "bg-popover text-popover-foreground absolute z-50 mt-2 min-w-[16rem] rounded-md border p-3 shadow-md",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
