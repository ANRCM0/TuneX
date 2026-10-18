/**
 * packages/shared/src/permissions.ts
 *
 * Evidence: relayx-analysis/work/shared/004__packages__shared__src__permissions.ts:1-81
 *
 * Permission model for the admin console. A resource is a logical console section;
 * it maps to one or more API prefixes and to a URL. `requiredLevel` derives the
 * needed level from the HTTP method (GET/HEAD = read, everything else = write).
 *
 * Preserved semantics:
 *   - `$staff` is the shared-key used by STAFF_SHARED_PREFIXES (currently only
 *     `/admin/node/group/summary`), allowed to every admin-role holder.
 *   - `/admin/role` resolves to `$super`, which `adminPermissionGuard` always rejects
 *     for non-super-admins (see apps/backend/src/middlewares/auth.ts).
 *   - the route table is sorted by descending prefix length so the longest prefix wins.
 */

export type PermissionLevel = "read" | "write";

export interface AdminResource {
  key: string;
  label: string;
  group: string;
  url: string;
  business: boolean;
  apiPrefixes: string[];
}

export const ADMIN_RESOURCES: AdminResource[] = [
  { key: "dashboard", label: "首页", group: "概览", url: "/admin", business: false, apiPrefixes: ["/admin/stats", "/admin/plan/stats", "/admin/topup/stats"] },
  { key: "node_groups", label: "节点组配置", group: "基础", url: "/admin/node-groups", business: false, apiPrefixes: ["/admin/node/group"] },
  { key: "nodes", label: "节点配置", group: "基础", url: "/admin/nodes", business: false, apiPrefixes: ["/admin/node"] },
  { key: "plans", label: "套餐配置", group: "基础", url: "/admin/plans", business: false, apiPrefixes: ["/admin/plan"] },
  { key: "plan_coupons", label: "优惠券配置", group: "财务", url: "/admin/plan_coupons", business: true, apiPrefixes: ["/admin/plan/coupon"] },
  { key: "payments", label: "支付配置", group: "财务", url: "/admin/payments", business: true, apiPrefixes: ["/admin/pay"] },
  { key: "topups", label: "充值记录", group: "财务", url: "/admin/topups", business: true, apiPrefixes: ["/admin/topup"] },
  { key: "topup_activities", label: "充值活动", group: "财务", url: "/admin/topup_activities", business: true, apiPrefixes: ["/admin/topup/activity"] },
  { key: "orders", label: "购买记录", group: "财务", url: "/admin/orders", business: false, apiPrefixes: ["/admin/plan/orders"] },
  { key: "balance_logs", label: "余额记录", group: "财务", url: "/admin/balance-logs", business: false, apiPrefixes: ["/admin/user/balance/log"] },
  { key: "commission_logs", label: "佣金记录", group: "推广", url: "/admin/commission-logs", business: true, apiPrefixes: ["/admin/user/commission/log"] },
  { key: "withdraw", label: "提现管理", group: "推广", url: "/admin/withdraw", business: true, apiPrefixes: ["/admin/withdraw"] },
  { key: "users", label: "用户管理", group: "用户", url: "/admin/users", business: false, apiPrefixes: ["/admin/user"] },
  { key: "user_plans", label: "用户套餐", group: "用户", url: "/admin/user_plans", business: false, apiPrefixes: ["/admin/user_plan"] },
  { key: "tunnels", label: "用户隧道", group: "用户", url: "/admin/tunnels", business: false, apiPrefixes: ["/admin/tunnel"] },
  { key: "tunnel_stats", label: "隧道统计", group: "用户", url: "/admin/tunnels/stats", business: false, apiPrefixes: ["/admin/tunnel/stats"] },
  { key: "tickets", label: "工单管理", group: "用户", url: "/admin/tickets", business: true, apiPrefixes: ["/admin/ticket"] },
  { key: "settings", label: "系统设置", group: "系统", url: "/admin/settings", business: false, apiPrefixes: ["/admin/system/config"] },
  { key: "license", label: "License 管理", group: "系统", url: "/admin/license", business: false, apiPrefixes: ["/admin/license"] }
];

export const ADMIN_RESOURCE_KEYS: string[] = ADMIN_RESOURCES.map((r) => r.key);

export const ADMIN_RESOURCE_GROUPS: string[] = [...new Set(ADMIN_RESOURCES.map((r) => r.group))];

export const STAFF_SHARED_PREFIXES: string[] = ["/admin/node/group/summary"];

export const STAFF_SHARED_KEY = "$staff";

export const SUPER_ADMIN_KEY = "$super";

export interface AdminRouteEntry {
  prefix: string;
  key: string;
}

function buildAdminRouteTable(): AdminRouteEntry[] {
  const table: AdminRouteEntry[] = [];
  for (const resource of ADMIN_RESOURCES) {
    for (const prefix of resource.apiPrefixes) table.push({ prefix, key: resource.key });
  }
  for (const prefix of STAFF_SHARED_PREFIXES) table.push({ prefix, key: STAFF_SHARED_KEY });
  table.push({ prefix: "/admin/role", key: SUPER_ADMIN_KEY });
  return table.sort((a, b) => b.prefix.length - a.prefix.length);
}

export const ADMIN_ROUTE_TABLE: AdminRouteEntry[] = buildAdminRouteTable();

export function isAdminResourceKey(key: string): boolean {
  return ADMIN_RESOURCE_KEYS.includes(key);
}

export function requiredLevel(method: string): PermissionLevel {
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

export function levelSatisfies(granted: PermissionLevel, required: PermissionLevel): boolean {
  return granted === "write" || granted === required;
}

function prefixMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function resolveAdminRoute(path: string): AdminRouteEntry | undefined {
  return ADMIN_ROUTE_TABLE.find((e) => prefixMatches(path, e.prefix));
}

export function resolveResourceByUrl(pathname: string): AdminResource | undefined {
  let matched: AdminResource | undefined;
  for (const resource of ADMIN_RESOURCES) {
    if (prefixMatches(pathname, resource.url)) {
      if (!matched || resource.url.length > matched.url.length) matched = resource;
    }
  }
  return matched;
}
