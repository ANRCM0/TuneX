"use client";
/**
 * User-side SWR hooks (35 in upstream, module 412322). SWR key = ["/<mnemonic>", ...args];
 * the first element intentionally does NOT have to equal the real URL
 * (upstream: "/in-node-group-dns" vs "/api/in_node_group_dns").
 *
 * DEVIATION: every key is built by an exported key*() helper. Upstream hand-writes the
 * key arrays at call sites, which silently breaks when a hook gains a parameter.
 */
import useSWR, { type SWRResponse } from "swr";
import { client } from "./client";

async function json(res: Response) {
  return res.json();
}

export type Page<T> = { data: T[]; total: number };

export type User = {
  id: number;
  email: string;
  status: string;
  super_admin?: boolean;
  admin_access?: Record<string, "read" | "write">;
  admin_roles?: { id: number; name: string }[];
  user_plan?: {
    plan: { name: string; allow_custom_in_node_group?: boolean; allow_custom_out_node_group?: boolean };
  };
};

export type License = { type?: "personal" | "business"; expired_at?: string; site_url?: string };

export const keyUser = () => ["/user/info"] as const;
export const keyLicense = () => ["/license"] as const;
export const keySiteConfig = () => ["/system/config/site"] as const;
export const keySystemConfig = (names: string[]) => ["/system/config", names.join(",")] as const;
export const keyPlans = (page: number, perPage: number) => ["/plan", page, perPage] as const;
export const keyTunnels = (page: number, perPage: number, sort?: unknown) =>
  ["/tunnel", page, perPage, sort] as const;
export const keyNodeGroups = () => ["/node/group"] as const;
export const keyTickets = (page: number, perPage: number, status?: string) =>
  ["/ticket", page, perPage, status] as const;

export function useUser(enabled = true): SWRResponse<User> {
  return useSWR(keyUser(), async () => json(await client.user.info.$get()), {
    suspense: false,
    isPaused: () => !enabled,
  });
}

export function useLicense(): SWRResponse<License> {
  return useSWR(keyLicense(), async () => json(await client.license.$get({ query: { force: "false" } })), {
    suspense: false,
  });
}

export function useSiteConfig(): SWRResponse<Record<string, string>> {
  return useSWR(keySiteConfig(), async () => json(await client.system.config.site.$get()), {
    suspense: false,
  });
}

export function useSystemConfig(names: string[]): SWRResponse<Record<string, unknown>> {
  return useSWR(
    keySystemConfig(names),
    async () => json(await client.system.config.$get({ query: { name: names.join(",") } })),
    { suspense: false },
  );
}

export function usePlans(page = 1, perPage = 10): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyPlans(page, perPage), async () =>
    json(await client.plan.$get({ query: { page: String(page), perPage: String(perPage) } })),
  );
}

export function useTunnels(
  page = 1,
  perPage = 10,
  sort?: unknown,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyTunnels(page, perPage, sort), async () =>
    json(
      await client.tunnel.$get({
        query: {
          page: String(page),
          perPage: String(perPage),
          sort: sort ? JSON.stringify(sort) : undefined,
        },
      }),
    ),
  );
}

export function useNodeGroups(): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyNodeGroups(), async () => json(await client.node.group.$get({ query: {} })));
}

export function useTickets(
  page = 1,
  perPage = 10,
  status?: string,
): SWRResponse<Page<Record<string, unknown>>> {
  return useSWR(keyTickets(page, perPage, status), async () =>
    json(
      await client.ticket.$get({
        query: { page: String(page), perPage: String(perPage), status: status ?? undefined },
      }),
    ),
  );
}
