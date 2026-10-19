/**
 * `PlanService.subscribePlan` against a throwaway SQLite database.
 *
 * This is the purchase half of the money path (upstream
 * `038__src__services__plan.ts`): price the plan, check the balance, write the order and
 * balance log, extend the user plan, bump stock, and pay the referral on the
 * pre-setup-fee amount when `REFERRAL_MODE` is "plan". The pure pricing rule is covered
 * separately in `plan-pricing.test.ts`; here the database effects are asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { LicenseService } from "../../apps/backend/src/services/license";
import type { PlanCouponService } from "../../apps/backend/src/services/plan_coupon";
import type { PlanService } from "../../apps/backend/src/services/plan";
import type { SystemConfigService } from "../../apps/backend/src/services/system_config";
import type { SessionUser } from "../../apps/backend/src/types";

const temp: TempDatabase = createTempDatabase("plan-purchase");

let db: PrismaClient;
let service: PlanService;

const configValues: Record<string, unknown> = {};
const notifications: { kind: string; args: unknown[] }[] = [];
let coupon: { id: number; type: "percentage" | "fixed"; value: number } | null = null;
let couponCodeSeen: string | null = null;

let planSeq = 0;
let userSeq = 0;

async function makePlan(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  planSeq += 1;
  return db.plan.create({
    data: {
      name: `plan-${planSeq}`,
      price: 100,
      allow_custom_in_node_group: false,
      allow_custom_out_node_group: false,
      all_in_node_groups: false,
      all_out_node_groups: false,
      ...overrides,
    } as never,
  });
}

async function makeUser(balance: number, parentId?: number): Promise<SessionUser> {
  userSeq += 1;
  const user = await db.user.create({
    data: { email: `plan-user-${userSeq}@example.test`, balance, parent_id: parentId ?? null },
  });
  return { ...user, admin_roles: [] } as SessionUser;
}

const balance = async (userId: number) =>
  (await db.user.findUniqueOrThrow({ where: { id: userId } })).balance;

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { PlanService: Service } = await import("../../apps/backend/src/services/plan");
  const { TopupService } = await import("../../apps/backend/src/services/topup");

  const topup = new TopupService(
    { getLicense: async () => ({ type: "business" }) } as unknown as LicenseService,
    { getConfig: async (name: string) => configValues[name] } as unknown as SystemConfigService,
  );
  const redis = { lockUserSubscribe: async (_id: number, fn: () => Promise<void>) => fn() };
  const notify = {
    notifyRenewPlanFailed: async (...args: unknown[]) => {
      notifications.push({ kind: "renew-failed", args });
    },
    notifySubscribePlan: async (...args: unknown[]) => {
      notifications.push({ kind: "subscribed", args });
    },
  };
  const coupons = {
    getCoupon: async (code: string) => {
      couponCodeSeen = code;
      return coupon;
    },
  };

  service = new Service(
    coupons as unknown as PlanCouponService,
    redis as never,
    notify as never,
    { getConfig: async (name: string) => configValues[name] } as unknown as SystemConfigService,
    topup,
  );
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

describe("subscribePlan", () => {
  it("debits the balance, writes the order, log and user plan, and bumps stock", async () => {
    notifications.length = 0;
    const plan = await makePlan({ price: 100, stock: 3 });
    const user = await makeUser(150);

    await service.subscribePlan(user, plan.id);

    expect(await balance(user.id)).toBe(50);
    const orders = await db.planOrder.findMany({ where: { user_id: user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ plan_id: plan.id, price: 100, balance: 50, coupon_id: null });

    const logs = await db.balanceLog.findMany({ where: { user_id: user.id, type: "plan" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ amount: -100, balance: 50 });

    const userPlan = await db.userPlan.findUniqueOrThrow({ where: { user_id: user.id } });
    expect(userPlan.plan_id).toBe(plan.id);
    expect(userPlan.expired_at).not.toBeNull();
    expect((await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).stock).toBe(2);

    expect(notifications.map((n) => n.kind)).toEqual(["subscribed"]);
    expect(notifications[0].args[2]).toBe(100);
    expect(notifications[0].args[3]).toBe(50);
  });

  it("applies a percentage coupon and records it on the order", async () => {
    const plan = await makePlan({ price: 100 });
    const user = await makeUser(150);
    const row = await db.planCoupon.create({
      data: { code: "SAVE10", type: "percentage", value: 10 },
    });
    coupon = { id: row.id, type: "percentage", value: 10 };

    await service.subscribePlan(user, plan.id, false, "SAVE10");

    expect(couponCodeSeen).toBe("SAVE10");
    expect(await balance(user.id)).toBe(60);
    const order = await db.planOrder.findFirstOrThrow({ where: { user_id: user.id } });
    expect(order.price).toBe(90);
    expect(order.coupon_id).toBe(row.id);
    coupon = null;
  });

  it("adds the setup fee for a new plan but waives it on the same plan", async () => {
    const plan = await makePlan({ price: 100, setup_fee: 20 });

    const first = await makeUser(200);
    await service.subscribePlan(first, plan.id);
    expect(await balance(first.id)).toBe(80);
    expect((await db.planOrder.findFirstOrThrow({ where: { user_id: first.id } })).price).toBe(120);

    await db.user.update({ where: { id: first.id }, data: { balance: 200 } });
    await service.subscribePlan(first, plan.id);
    expect(await balance(first.id)).toBe(100);
    const orders = await db.planOrder.findMany({ where: { user_id: first.id }, orderBy: { id: "asc" } });
    expect(orders.map((o) => o.price)).toEqual([120, 100]);
  });

  it("refuses the purchase when the balance is short", async () => {
    notifications.length = 0;
    const plan = await makePlan({ price: 100 });
    const user = await makeUser(50);

    await expect(service.subscribePlan(user, plan.id)).rejects.toMatchObject({ status: 409 });
    expect(await balance(user.id)).toBe(50);
    expect(await db.planOrder.count({ where: { user_id: user.id } })).toBe(0);
    expect(notifications).toHaveLength(0);
  });

  it("notifies about a failed renewal before refusing an auto-renew", async () => {
    notifications.length = 0;
    const plan = await makePlan({ price: 100 });
    const user = await makeUser(10);

    await expect(service.subscribePlan({ ...user, admin_roles: [] } as SessionUser, plan.id, true)).rejects.toMatchObject({
      status: 409,
    });
    expect(notifications.map((n) => n.kind)).toEqual(["renew-failed"]);
    expect(await balance(user.id)).toBe(10);
  });

  it("refuses an out-of-stock plan unless it is an auto-renew", async () => {
    const plan = await makePlan({ price: 10, stock: 0 });
    const user = await makeUser(50);
    await expect(service.subscribePlan(user, plan.id)).rejects.toMatchObject({ status: 409 });

    // Auto-renew skips the stock gate.
    await service.subscribePlan(user, plan.id, true);
    expect(await balance(user.id)).toBe(40);
  });

  it("refuses an inactive plan for a new subscription but allows a renewal", async () => {
    const plan = await makePlan({ price: 10, status: "inactive" });
    const user = await makeUser(50);
    await expect(service.subscribePlan(user, plan.id)).rejects.toMatchObject({ status: 409 });

    // Give the user the plan first, then renew it.
    await db.plan.update({ where: { id: plan.id }, data: { status: "active" } });
    await service.subscribePlan(user, plan.id);
    await db.plan.update({ where: { id: plan.id }, data: { status: "inactive" } });
    await service.subscribePlan(user, plan.id);
    expect(await balance(user.id)).toBe(30);
  });

  it("refuses to renew a non-renewable plan", async () => {
    const plan = await makePlan({ price: 10, renewable: false });
    const user = await makeUser(50);
    await service.subscribePlan(user, plan.id);
    await expect(service.subscribePlan(user, plan.id)).rejects.toMatchObject({ status: 409 });
  });

  it("pays the referral on the pre-setup-fee amount in plan mode", async () => {
    configValues.REFERRAL_MODE = "plan";
    configValues.REFERRAL_COMMISSION_RATE = 10;
    const parent = await makeUser(0);
    const child = await makeUser(150, parent.id);
    const plan = await makePlan({ price: 100, setup_fee: 20 });

    await service.subscribePlan(child, plan.id);

    // 10% of 100 (the fee is excluded), not of 120.
    const parentAfter = await db.user.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentAfter.commission_balance).toBe(10);
    delete configValues.REFERRAL_MODE;
    delete configValues.REFERRAL_COMMISSION_RATE;
  });

  it("none of that pays a referral in topup mode", async () => {
    configValues.REFERRAL_MODE = "topup";
    configValues.REFERRAL_COMMISSION_RATE = 10;
    const parent = await makeUser(0);
    const child = await makeUser(150, parent.id);
    const plan = await makePlan({ price: 100 });

    await service.subscribePlan(child, plan.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(0);
    delete configValues.REFERRAL_MODE;
    delete configValues.REFERRAL_COMMISSION_RATE;
  });

  it("accumulates traffic for a lifetime plan and leaves the expiry empty", async () => {
    const plan = await makePlan({ price: 10, billing_cycle: "lifetime", traffic: 100 });
    const user = await makeUser(100);

    await service.subscribePlan(user, plan.id);
    let userPlan = await db.userPlan.findUniqueOrThrow({ where: { user_id: user.id } });
    expect(userPlan.expired_at).toBeNull();
    expect(userPlan.traffic).toBe(100);

    await db.userPlan.update({ where: { user_id: user.id }, data: { traffic_used: 30 } });
    await service.subscribePlan(user, plan.id);
    userPlan = await db.userPlan.findUniqueOrThrow({ where: { user_id: user.id } });
    expect(userPlan.traffic).toBe(200);
    expect(userPlan.traffic_used).toBe(30);
  });

  it("extends a recurring plan from its current expiry", async () => {
    const plan = await makePlan({ price: 10, billing_cycle: "month" });
    const user = await makeUser(100);

    await service.subscribePlan(user, plan.id);
    const first = await db.userPlan.findUniqueOrThrow({ where: { user_id: user.id } });
    await service.subscribePlan(user, plan.id);
    const second = await db.userPlan.findUniqueOrThrow({ where: { user_id: user.id } });

    const added = second.expired_at!.getTime() - first.expired_at!.getTime();
    expect(added).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(added).toBeLessThan(31 * 24 * 3600 * 1000);
  });
});
