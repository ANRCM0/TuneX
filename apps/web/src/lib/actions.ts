"use client";
import { t, tf } from "@/lib/i18n";
/** Row/bulk actions shared by the generated list pages (from artifacts/columns.json). */
import { toast } from "sonner";
import type { RpcProxy } from "./client";

type Node = (...args: never[]) => Promise<Response>;

export type DeleteStyle = { kind: "query.ids" } | { kind: "param.id" };

export function makeDelete(node: unknown, style: DeleteStyle, onDone: () => Promise<unknown> | void) {
  return async (ids: number[]) => {
    const fn = node as unknown as (args: Record<string, unknown>) => Promise<Response>;
    const res =
      style.kind === "query.ids"
        ? await fn({ query: { ids: ids.join(",") } })
        : await fn({ param: { id: ids.join(",") } });
    if (res.ok) {
      toast.success(ids.length > 1 ? tf("n_4c1147", { n: ids.length }) : t("zh_86e8d1"));
      await onDone();
    }
    return res.ok;
  };
}

export function makePatch(node: unknown, onDone: () => Promise<unknown> | void, okMsg = t("zh_3c5be5")) {
  return async (args: { param?: Record<string, string | number>; json?: unknown }) => {
    const fn = node as unknown as (a: typeof args) => Promise<Response>;
    const res = await fn(args);
    if (res.ok) {
      toast.success(okMsg);
      await onDone();
    }
    return res.ok;
  };
}

/** Generic "call a mutation node, toast, revalidate" helper. */
export function makePatcher(onDone: () => Promise<unknown> | void) {
  return async (node: unknown, args: Record<string, unknown> = {}, okMsg = t("zh_3c5be5")) => {
    const fn = node as unknown as (a: Record<string, unknown>) => Promise<Response>;
    const res = await fn(args);
    if (res.ok) {
      toast.success(okMsg);
      await onDone();
    }
    return res.ok;
  };
}
