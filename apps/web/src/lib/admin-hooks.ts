"use client";
/**
 * Admin-side hooks (26 in upstream, module 256706).
 * NOTE (upstream trap): useUser/usePlan/useNode/useNodeGroup/usePayment/useSystemConfig
 * exist on BOTH sides with different meanings. Here they are renamed useAdmin* so a
 * rebuild cannot wire the wrong one.
 */
import useSWR, { type SWRResponse } from "swr";
import { adminClient, client } from "./client";

const json = async (res: Response) => res.json();

export type Page<T> = { data: T[]; total: number };

export const keyAdminUsers = (page: number, perPage: number, sort?: unknown, email?: string) =>
  ["/admin/user", page, perPage, sort, email] as const;
export const keyAdminTunnels = (page: number, perPage: number, sort?: unknown) =>
  ["/admin/tunnel", page, perPage, sort] as const;
export const keyAdminTickets = (page: number, perPage: number, status?: string) =>
  ["/admin/ticket", page, perPage, status] as const;
export const keyAdminWithdraw = (page: number, perPage: number, status?: string) =>
  ["/admin/withdraw", page, perPage, status] as const;

export function useAdminUsers(
  page = 1,
  perPage = 10,
  sort?: unknown,
  email?: string,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyAdminUsers(page, perPage, sort, email), async () =>
    json(
      await adminClient.user.$get({
        query: {
          page: String(page),
          perPage: String(perPage),
          sort: sort ? JSON.stringify(sort) : undefined,
          email: email ?? undefined,
        },
      }),
    ),
  );
}

export function useAdminTunnels(
  page = 1,
  perPage = 10,
  sort?: unknown,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyAdminTunnels(page, perPage, sort), async () =>
    json(
      await adminClient.tunnel.$get({
        query: {
          page: String(page),
          perPage: String(perPage),
          sort: sort ? JSON.stringify(sort) : undefined,
        },
      }),
    ),
  );
}

export function useAdminTickets(
  page = 1,
  perPage = 10,
  status?: string,
  enabled = true,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(enabled ? keyAdminTickets(page, perPage, status) : null, async () =>
    json(
      await adminClient.ticket.$get({
        query: { page: String(page), perPage: String(perPage), status: status ?? undefined },
      }),
    ),
  );
}

export function useAdminWithdraw(
  page = 1,
  perPage = 10,
  status?: string,
  enabled = true,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(enabled ? keyAdminWithdraw(page, perPage, status) : null, async () =>
    json(
      await adminClient.withdraw.$get({
        query: { page: String(page), perPage: String(perPage), status: status ?? undefined },
      }),
    ),
  );
}

export function useAdminLicense(): SWRResponse<Record<string, unknown>> {
  return useSWR("/admin/license", async () => json(await client.license.$get({ query: { force: "true" } })));
}
