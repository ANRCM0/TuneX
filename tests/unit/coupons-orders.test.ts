/**
 * Coupon validation and unpaid-order cancellation.
 *
 * `getCoupon` is the gate the plan purchase runs before pricing, so its five rejections
 * are user-visible and order-dependent: existence, cycle, validity window, total uses
 * and per-user uses. `cancelUnpaidOrder` only touches pending topup orders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { OrderService } from "../../apps/backend/src/services/order";
import type { PlanCouponService } from "../../apps/backend/src/services/plan_coupon";

const temp: TempDatabase = createTempDatabase("coupons-orders");

let db: PrismaClient;
let coupons: PlanCouponService;
let orders: OrderService;

let userA = 0;
let userB = 0;
let planId = 0;
let paymentId = 0;

async function makeCoupon(overrides: Record<string, unknown> = {}) {
  return db.planCoupon.create({
    data: { code: "SAVE", type: "percentage", value: 10, ...overrides } as never,
  });
}

async function makeOrder(
  userId: number,
  couponId: number | null,
  orderId: string,
  status: "pending" | "success" = "pending",
) {
  return db.topupOrder.create({
    data: {
      user_id: userId,
      payment_id: paymentId,
      price: 10,
      pay_url: "u",
      order_id: orderId,
      status,
    },
  });
}

async function makePlanOrder(userId: number, couponId: number) {
  return db.planOrder.create({
    data: { user_id: userId, plan_id: planId, price: 90, balance: 0, coupon_id: couponId },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { PlanCouponService: Coupons } = await import("../../apps/backend/src/services/plan_coupon");
  const { OrderService: Orders } = await import("../../apps/backend/src/services/order");
  coupons = new Coupons();
  orders = new Orders();

  userA = (await db.user.create({ data: { email: "a@example.test" } })).id;
  userB = (await db.user.create({ data: { email: "b@example.test" } })).id;
  planId = (
    await db.plan.create({
      data: {
        name: "p",
        price: 100,
        allow_custom_in_node_group: false,
        allow_custom_out_node_group: false,
        all_in_node_groups: false,
        all_out_node_groups: false,
      },
    })
  ).id;
  paymentId = (
    await db.payment.create({
      data: { name: "pay", url: "https://pay.example.test", config: {}, method: "epay" },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.planOrder.deleteMany();
  await db.topupOrder.deleteMany();
  await db.planCoupon.deleteMany();
});

describe("PlanCouponService.getCoupon", () => {
  it("returns a matching coupon", async () => {
    const coupon = await makeCoupon();
    const found = await coupons.getCoupon("SAVE", "month" as never, userA);
    expect(found.id).toBe(coupon.id);
  });

  it("rejects an unknown code or a coupon for another cycle", async () => {
    await makeCoupon({ valid_cycle: "year" });
    await expect(coupons.getCoupon("NOPE", "month" as never, userA)).rejects.toMatchObject({
      status: 404,
      message: "优惠码不存在",
    });
    await expect(coupons.getCoupon("SAVE", "month" as never, userA)).rejects.toMatchObject({
      status: 404,
    });
    // A null cycle applies to every cycle.
    await db.planCoupon.create({ data: { code: "ANY", type: "fixed", value: 5 } });
    await expect(coupons.getCoupon("ANY", "month" as never, userA)).resolves.toMatchObject({ code: "ANY" });
  });

  it("rejects a coupon outside its validity window", async () => {
    await makeCoupon({ code: "SOON", valid_start: new Date(Date.now() + 3600_000) });
    await expect(coupons.getCoupon("SOON", "month" as never, userA)).rejects.toMatchObject({
      status: 409,
      message: "优惠码不在有效期内",
    });

    await makeCoupon({ code: "OLD", valid_end: new Date(Date.now() - 3600_000) });
    await expect(coupons.getCoupon("OLD", "month" as never, userA)).rejects.toMatchObject({
      status: 409,
      message: "优惠码不在有效期内",
    });
  });

  it("enforces the total use count", async () => {
    const coupon = await makeCoupon({ max_use: 2 });
    await makePlanOrder(userA, coupon.id);
    await expect(coupons.getCoupon("SAVE", "month" as never, userA)).resolves.toBeTruthy();

    await makePlanOrder(userB, coupon.id);
    await expect(coupons.getCoupon("SAVE", "month" as never, userA)).rejects.toMatchObject({
      status: 409,
      message: "优惠码次数已用完",
    });
  });

  it("enforces the per-user use count independently of other users", async () => {
    const coupon = await makeCoupon({ max_use_per_user: 1 });
    await makePlanOrder(userB, coupon.id);
    await expect(coupons.getCoupon("SAVE", "month" as never, userA)).resolves.toBeTruthy();

    await makePlanOrder(userA, coupon.id);
    await expect(coupons.getCoupon("SAVE", "month" as never, userA)).rejects.toMatchObject({
      status: 409,
      message: "优惠码每人只能使用一次",
    });
  });
});

describe("OrderService.cancelUnpaidOrder", () => {
  it("cancels only pending orders", async () => {
    const pending = await makeOrder(userA, null, "O-1");
    const success = await makeOrder(userA, null, "O-2", "success");

    await orders.cancelUnpaidOrder(pending.id);

    expect((await db.topupOrder.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("cancelled");
    expect((await db.topupOrder.findUniqueOrThrow({ where: { id: success.id } })).status).toBe("success");
  });

  it("is a no-op for a missing or already-final order", async () => {
    const success = await makeOrder(userA, null, "O-3", "success");
    await orders.cancelUnpaidOrder(success.id);
    await orders.cancelUnpaidOrder(999999);

    expect((await db.topupOrder.findUniqueOrThrow({ where: { id: success.id } })).status).toBe("success");
  });
});
