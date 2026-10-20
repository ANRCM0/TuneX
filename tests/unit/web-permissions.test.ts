/**
 * Console RBAC helpers (`apps/web/src/lib/permissions.ts`).
 *
 * The resource table comes from `@relayx/shared/permissions` — the same module the
 * backend guards use — so these cases pin the *client* derivation only:
 *
 *   - a personal licence blanks the entire admin surface, even for a user whose
 *     `admin_access` is populated (module 466707 in the decompile);
 *   - `super_admin` always keeps its own map;
 *   - `isStaff` requires super-admin or (non-personal licence + at least one role).
 *
 * Evidence: relayx-analysis reports/04 §5, reports/08 §6.3.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_RESOURCES,
  ADMIN_RESOURCE_KEYS,
  canRead,
  canWrite,
  effectiveAccess,
  isStaff,
  resolveResourceByUrl,
} from "../../apps/web/src/lib/permissions";

const access = { tunnels: "write" as const, users: "read" as const };

describe("effectiveAccess", () => {
  it("returns the user map for a business licence", () => {
    expect(effectiveAccess({ admin_access: access }, { type: "business" })).toEqual(access);
  });

  it("blanks the surface under a personal licence", () => {
    expect(effectiveAccess({ admin_access: access }, { type: "personal" })).toEqual({});
  });

  it("keeps the map when no licence is known yet", () => {
    expect(effectiveAccess({ admin_access: access }, null)).toEqual(access);
  });

  it("lets a super admin through even on a personal licence", () => {
    expect(effectiveAccess({ super_admin: true, admin_access: access }, { type: "personal" })).toEqual(access);
  });

  it("returns an empty map for an absent user", () => {
    expect(effectiveAccess(undefined, { type: "business" })).toEqual({});
  });
});

describe("canRead / canWrite", () => {
  it("treats presence as read and the exact write level as write", () => {
    expect(canRead(access, "users")).toBe(true);
    expect(canWrite(access, "users")).toBe(false);
    expect(canWrite(access, "tunnels")).toBe(true);
    expect(canRead(access, "roles")).toBe(false);
  });
});

describe("isStaff", () => {
  it("is true for a super admin", () => {
    expect(isStaff({ super_admin: true }, { type: "personal" })).toBe(true);
  });

  it("requires a non-personal licence and at least one admin role", () => {
    expect(isStaff({ admin_roles: [{ id: 1 }] }, { type: "business" })).toBe(true);
    expect(isStaff({ admin_roles: [{ id: 1 }] }, { type: "personal" })).toBe(false);
    expect(isStaff({ admin_roles: [] }, { type: "business" })).toBe(false);
  });
});

describe("resource table", () => {
  it("has 19 resources, matching the backend's key set", () => {
    expect(ADMIN_RESOURCES).toHaveLength(19);
    expect(new Set(ADMIN_RESOURCE_KEYS).size).toBe(19);
  });

  it("resolves by URL with longest-prefix wins", () => {
    expect(resolveResourceByUrl("/admin/tunnels/stats")?.key).toBe("tunnel_stats");
    expect(resolveResourceByUrl("/admin/tunnels")?.key).toBe("tunnels");
    expect(resolveResourceByUrl("/tunnels")).toBeUndefined();
  });
});
