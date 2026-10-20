"use client";
/** Upstream keeps the current page title in a zustand store; a tiny external store is enough here. */
import { useSyncExternalStore } from "react";

let title = "";
const listeners = new Set<() => void>();

export function setPageTitle(next: string) {
  title = next;
  listeners.forEach((l) => l());
}

export function usePageTitle(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => title,
    () => "",
  );
}
