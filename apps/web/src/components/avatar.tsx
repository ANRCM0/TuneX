"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Avatar({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("bg-muted relative flex size-8 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}
export function AvatarImage({ className, src, alt }: { className?: string; src?: string; alt?: string }) {
  if (!src) return null;
  return <img className={cn("aspect-square size-full object-cover", className)} src={src} alt={alt ?? ""} />;
}
export function AvatarFallback({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "bg-muted flex size-full items-center justify-center rounded-full text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}
