"use client";
/**
 * Minimal react-hook-form bindings. Upstream uses the full shadcn Form set
 * (Form/FormField/FormItem/FormLabel/FormControl/FormMessage/FormDescription);
 * only the parts the shipped pages actually use are reproduced here.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

export function FormItem({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-2", className)} {...props} />;
}

export function FormLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label className={cn("data-[error=true]:text-destructive", className)} {...props} />;
}

export function FormControl({ children }: { children: React.ReactElement }) {
  return children;
}

export function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-muted-foreground text-xs", className)} {...props} />;
}

export function FormMessage({ children, className }: { children?: React.ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={cn("text-destructive text-xs", className)}>{children}</p>;
}
