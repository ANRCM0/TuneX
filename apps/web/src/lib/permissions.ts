/**
 * RBAC helpers for the console.
 *
 * The resource table itself is NOT duplicated here: it comes from `@relayx/shared`
 * (packages/shared/src/permissions.ts), which is the same module the backend guards use.
 * That mirrors upstream, where `apps/web` depends on `@relayx/shared` as a workspace package
 * and imports the identical constants — see relayx-analysis/work/shared/004__...permissions.ts.
 */
import {
  ADMIN_RESOURCES,
  ADMIN_RESOURCE_GROUPS,
  ADMIN_RESOURCE_KEYS,
  STAFF_SHARED_KEY,
  SUPER_ADMIN_KEY,
  resolveAdminRoute,
  resolveResourceByUrl,
  type AdminResource,
  type PermissionLevel,
} from "@relayx/shared/permissions";

export {
  ADMIN_RESOURCES,
  ADMIN_RESOURCE_GROUPS,
  ADMIN_RESOURCE_KEYS,
  STAFF_SHARED_KEY,
  SUPER_ADMIN_KEY,
  resolveAdminRoute,
  resolveResourceByUrl,
};
export type { AdminResource, PermissionLevel };

export type Permission = PermissionLevel;
export type AdminAccess = Record<string, Permission | undefined>;

export type Viewer = {
  super_admin?: boolean;
  admin_access?: AdminAccess;
  admin_roles?: unknown[];
};

export type License = { type?: "personal" | "business" } | null | undefined;

/**
 * Upstream (module 466707):
 *   effective = user.super_admin ? user.admin_access
 *             : (license?.type === "personal" ? {} : user.admin_access)
 * A personal licence blanks the whole admin surface, even when admin_access is populated.
 */
export function effectiveAccess(user: Viewer | undefined, license: License): AdminAccess {
  if (!user) return {};
  if (user.super_admin) return user.admin_access ?? {};
  if (license?.type === "personal") return {};
  return user.admin_access ?? {};
}

export const canRead = (access: AdminAccess, key: string) => access[key] !== undefined;
export const canWrite = (access: AdminAccess, key: string) => access[key] === "write";

export function isStaff(user: Viewer | undefined, license: License): boolean {
  if (!user) return false;
  if (user.super_admin) return true;
  return license?.type !== "personal" && (user.admin_roles?.length ?? 0) > 0;
}
