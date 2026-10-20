"use client";
/**
 * Thin generic layer over the Hono-style client: every page needs "fetch a list /
 * mutate and revalidate", and upstream repeats that pattern 150 times by hand.
 * Endpoints and their request shapes come from relayx-web/artifacts/endpoints.json.
 */
import useSWR, { type SWRResponse, mutate as globalMutate } from "swr";
import type { RpcProxy } from "./client";

export type Page<T = Record<string, unknown>> = { data: T[]; total: number };

/** Call a lazily-resolved RPC node, e.g. pick(c => c.admin.user).$get({query}) */
export function pick(resolve: (c: RpcProxy) => unknown): RpcProxy {
  return resolve({} as RpcProxy) as RpcProxy;
}

export function rpcQuery(
  node: unknown,
  opts: { query?: Record<string, unknown>; param?: Record<string, string | number> } = {},
): Promise<Page> {
  const fn = node as unknown as (args: { query?: Record<string, unknown>; param?: Record<string, string | number> }) => Promise<Response>;
  return fn(opts).then((r) => r.json() as Promise<Page>);
}

export type ListParams = {
  page?: number;
  perPage?: number;
  sort?: unknown;
  [key: string]: unknown;
};

/** Build the query object the same way upstream does (undefined dropped, arrays repeated). */
export function tableQuery(params: ListParams): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (params.page !== undefined) q.page = String(params.page);
  if (params.perPage !== undefined) q.perPage = String(params.perPage);
  if (params.sort) q.sort = typeof params.sort === "string" ? params.sort : JSON.stringify(params.sort);
  for (const [k, v] of Object.entries(params)) {
    if (k === "page" || k === "perPage" || k === "sort") continue;
    if (v === undefined || v === null || v === "") continue;
    q[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return q;
}

/**
 * Generic list hook. `key` must be stable and unique per parameter set; callers use the
 * exported key builders from hooks.ts / admin-hooks.ts so a schema change cannot silently
 * break revalidation (upstream hand-writes the arrays — see reports/08 D3).
 */
export function useRpcList<T = Record<string, unknown>>(
  key: readonly unknown[] | null,
  node: () => unknown,
  params: ListParams = {},
): SWRResponse<Page<T>> {
  return useSWR(
    key,
    async () => {
      const fn = node() as unknown as (args: { query: Record<string, unknown> }) => Promise<Response>;
      const res = await fn({ query: tableQuery(params) });
      return (await res.json()) as Page<T>;
    },
    { keepPreviousData: true },
  );
}

/** Revalidate every list key that starts with the given prefix after a mutation. */
export function revalidatePrefix(prefix: string) {
  return globalMutate((key) => Array.isArray(key) && String(key[0]).startsWith(prefix), undefined, {
    revalidate: true,
  });
}
