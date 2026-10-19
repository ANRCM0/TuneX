/**
 * Behaviour of the admin/licence guards (`apps/backend/src/middlewares/auth.ts`,
 * `license.ts`) with a stubbed licence service and a hand-built session.
 *
 * These guards are the whole authorisation surface of the panel: `authRequired`
 * only proves identity, so a wrong branch here hands an admin console to any
 * logged-in user. The cases below pin the recovered semantics from
 * `relayx-analysis/work/modules/062__src__middlewares__auth.ts:71-110`:
 *
 *   - `adminRequired`: super admin passes; otherwise requires at least one admin
 *     role, a business licence, and a non-empty effective permission map.
 *   - `adminPermissionGuard`: super admin passes; an unmapped admin path is a 403;
 *     `$super` (the `/admin/role` prefix) is a 403 for non-super-admins; `$staff`
 *     (the node-group summary) is open to any admin-role holder; everything else
 *     needs the resource at `read` for GET/HEAD and `write` otherwise, and a
 *     business licence.
 *   - `businessLicenseRequired`: only an explicitly fetched non-business licence
 *     is rejected; `null` (licence server unreachable) passes.
 *
 * No database, Redis or HTTP server is involved.
 */
import { describe, expect, it } from "vitest";
import { register, TOKENS } from "../../apps/backend/src/container";
import {
  adminPermissionGuard,
  adminRequired,
  getEffectiveAccess,
  superAdminRequired,
} from "../../apps/backend/src/middlewares/auth";
import { businessLicenseRequired } from "../../apps/backend/src/middlewares/license";
import { ADMIN_RESOURCE_KEYS } from "../../packages/shared/src/permissions";
import type { AppEnv, SessionUser } from "../../apps/backend/src/types";

type Licence = { type: "personal" | "business" } | null;
type PermissionMap = Record<string, unknown>;

let licence: Licence = { type: "business" };

/** Stub the licence service the guards resolve from the container. */
function stubLicence(value: Licence): void {
  licence = value;
  register(TOKENS.License, () => ({ getLicense: async () => licence }));
}

let userId = 0;

function makeUser(options: {
  superAdmin?: boolean;
  permissions?: PermissionMap[];
  status?: "active" | "inactive";
} = {}): SessionUser {
  const roles = (options.permissions ?? []).map((permissions, i) => ({
    id: i + 1,
    name: `role-${i + 1}`,
    description: null,
    permissions,
    created_at: new Date(0),
    updated_at: new Date(0),
  }));
  return {
    id: ++userId,
    super_admin: options.superAdmin ?? false,
    email: `user${userId}@example.test`,
    balance: 0,
    commission_balance: 0,
    tg_id: null,
    uid: null,
    note: null,
    parent_id: null,
    referral_commission_rate: null,
    referral_first_only: null,
    auto_renew: false,
    api_key: `key-${userId}`,
    subscription_key: `sub-${userId}`,
    notify_subscriptions: null,
    admin_notify_subscriptions: null,
    status: options.status ?? "active",
    created_at: new Date(0),
    updated_at: new Date(0),
    admin_roles: roles,
  } as unknown as SessionUser;
}

/** Run one guard against a fabricated session context. */
async function run(
  guard: (c: never, next: () => Promise<void>) => Promise<void>,
  user: SessionUser,
  path: string,
  method = "GET",
): Promise<{ status: number; message?: string; passed: boolean }> {
  let passed = false;
  const context = {
    get: (key: string) => (key === "user" ? user : undefined),
    req: { path, method, header: () => undefined },
  };
  try {
    await guard(context as never, async () => {
      passed = true;
    });
    return { status: 200, passed };
  } catch (err) {
    // HTTPException from hono/http-exception; duck-typed so the test does not
    // need the backend's unresolvable-from-root `hono` import.
    const thrown = err as { status?: number; message?: string };
    return { status: thrown.status ?? 500, message: thrown.message, passed };
  }
}

describe("getEffectiveAccess", () => {
  it("grants every resource at write to a super admin", () => {
    const access = getEffectiveAccess(makeUser({ superAdmin: true }));
    expect([...access.keys()].sort()).toEqual([...ADMIN_RESOURCE_KEYS].sort());
    expect([...access.values()].every((level) => level === "write")).toBe(true);
  });

  it("merges roles and lets write win over read", () => {
    const access = getEffectiveAccess(
      makeUser({ permissions: [{ users: "read", nodes: "read" }, { users: "write" }] }),
    );
    expect(access.get("users")).toBe("write");
    expect(access.get("nodes")).toBe("read");
  });

  it("ignores unknown keys, unknown values and non-object permissions", () => {
    const access = getEffectiveAccess(
      makeUser({
        permissions: [
          { not_a_resource: "write", users: "admin", nodes: 3, plans: "read" } as PermissionMap,
          {} as PermissionMap,
        ],
      }),
    );
    expect([...access.entries()]).toEqual([["plans", "read"]]);
  });

  it("treats a role with a non-object permissions column as empty", () => {
    const user = makeUser({ permissions: [{}] });
    (user.admin_roles[0] as unknown as { permissions: unknown }).permissions = null;
    user.admin_roles.push({
      id: 99,
      name: "broken",
      description: null,
      permissions: ["users"] as unknown as never,
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    expect(getEffectiveAccess(user).size).toBe(0);
  });
});

describe("adminRequired", () => {
  const cases: {
    name: string;
    user: () => SessionUser;
    licence: Licence;
    status: number;
    message?: string;
  }[] = [
    {
      name: "super admin passes without roles or a business licence",
      user: () => makeUser({ superAdmin: true }),
      licence: { type: "personal" },
      status: 200,
    },
    {
      name: "plain user is rejected",
      user: () => makeUser(),
      licence: { type: "business" },
      status: 403,
      message: "Forbidden",
    },
    {
      name: "role holder with a permission and a business licence passes",
      user: () => makeUser({ permissions: [{ users: "read" }] }),
      licence: { type: "business" },
      status: 200,
    },
    {
      name: "role holder without a business licence is rejected",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "personal" },
      status: 403,
      message: "Forbidden",
    },
    {
      name: "role holder with no licence server configured passes",
      user: () => makeUser({ permissions: [{ users: "read" }] }),
      licence: null,
      status: 200,
    },
    {
      name: "role holder with an empty permission map is rejected",
      user: () => makeUser({ permissions: [{}] }),
      licence: { type: "business" },
      status: 403,
      message: "Forbidden",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      stubLicence(testCase.licence);
      const res = await run(adminRequired, testCase.user(), "/admin/node");
      expect(res.status).toBe(testCase.status);
      if (testCase.message) expect(res.message).toBe(testCase.message);
    });
  }
});

describe("adminPermissionGuard", () => {
  const cases: {
    name: string;
    path: string;
    method?: string;
    user: () => SessionUser;
    licence: Licence;
    status: number;
    message?: string;
  }[] = [
    {
      name: "super admin bypasses an unmapped admin path",
      path: "/admin/unknown",
      user: () => makeUser({ superAdmin: true }),
      licence: { type: "personal" },
      status: 200,
    },
    {
      name: "unmapped admin path is rejected for a role holder",
      path: "/admin/unknown",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "business" },
      status: 403,
      message: "无权访问该功能",
    },
    {
      name: "$super prefix is rejected for a role holder even with admin write",
      path: "/admin/role",
      method: "POST",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "business" },
      status: 403,
      message: "无权访问该功能",
    },
    {
      name: "$staff summary is open to any admin-role holder",
      path: "/admin/node/group/summary",
      user: () => makeUser({ permissions: [{ users: "read" }] }),
      licence: { type: "business" },
      status: 200,
    },
    {
      name: "read grants GET",
      path: "/admin/user",
      user: () => makeUser({ permissions: [{ users: "read" }] }),
      licence: { type: "business" },
      status: 200,
    },
    {
      name: "read does not grant POST",
      path: "/admin/user",
      method: "POST",
      user: () => makeUser({ permissions: [{ users: "read" }] }),
      licence: { type: "business" },
      status: 403,
      message: "无权访问该功能",
    },
    {
      name: "write grants POST",
      path: "/admin/user",
      method: "POST",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "business" },
      status: 200,
    },
    {
      name: "write also grants GET",
      path: "/admin/user",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "business" },
      status: 200,
    },
    {
      name: "non-business licence is rejected before the resource check",
      path: "/admin/user",
      user: () => makeUser({ permissions: [{ users: "write" }] }),
      licence: { type: "personal" },
      status: 403,
      message: "请购买商业授权",
    },
    {
      name: "longest prefix wins: coupon route needs plan_coupons, not plans",
      path: "/admin/plan/coupon/1",
      method: "PATCH",
      user: () => makeUser({ permissions: [{ plans: "write" }] }),
      licence: { type: "business" },
      status: 403,
      message: "无权访问该功能",
    },
    {
      name: "longest prefix wins: activity route needs topup_activities, not topups",
      path: "/admin/topup/activity/1",
      method: "PATCH",
      user: () => makeUser({ permissions: [{ topups: "write" }] }),
      licence: { type: "business" },
      status: 403,
      message: "无权访问该功能",
    },
    {
      name: "user_plan prefix is not shadowed by user",
      path: "/admin/user_plan",
      user: () => makeUser({ permissions: [{ user_plans: "read" }] }),
      licence: { type: "business" },
      status: 200,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      stubLicence(testCase.licence);
      const res = await run(adminPermissionGuard, testCase.user(), testCase.path, testCase.method);
      expect(res.status).toBe(testCase.status);
      if (testCase.message) expect(res.message).toBe(testCase.message);
    });
  }
});

describe("superAdminRequired", () => {
  it("rejects a role holder", async () => {
    stubLicence({ type: "business" });
    const res = await run(superAdminRequired, makeUser({ permissions: [{ users: "write" }] }), "/admin/role");
    expect(res.status).toBe(403);
    expect(res.message).toBe("Forbidden");
  });

  it("passes a super admin", async () => {
    stubLicence({ type: "personal" });
    const res = await run(superAdminRequired, makeUser({ superAdmin: true }), "/admin/role");
    expect(res.status).toBe(200);
  });
});

describe("businessLicenseRequired", () => {
  const cases: { name: string; licence: Licence; status: number; message?: string }[] = [
    { name: "personal licence is rejected", licence: { type: "personal" }, status: 403, message: "请购买商业授权" },
    { name: "business licence passes", licence: { type: "business" }, status: 200 },
    {
      name: "missing licence passes (recovered upstream semantics)",
      licence: null,
      status: 200,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      stubLicence(testCase.licence);
      const res = await run(businessLicenseRequired, makeUser(), "/pay", "POST");
      expect(res.status).toBe(testCase.status);
      if (testCase.message) expect(res.message).toBe(testCase.message);
    });
  }
});
