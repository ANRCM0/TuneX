import { BillingCycle, PlanCoupon } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { service, TOKENS } from "../container";

/**
 * Upstream: src/services/plan_coupon.ts (54 lines) — ported 1:1.
 */
export class PlanCouponService {
  async getCoupon(code: string, cycle: BillingCycle, user_id: number): Promise<PlanCoupon> {
    const coupon = await db.planCoupon.findFirst({
      where: {
        AND: [{ code }, { OR: [{ valid_cycle: null }, { valid_cycle: cycle }] }],
      },
    });
    if (!coupon) {
      throw new HTTPException(404, { message: "优惠码不存在" });
    }
    if (coupon.valid_start && coupon.valid_start > new Date()) {
      throw new HTTPException(409, { message: "优惠码不在有效期内" });
    }
    if (coupon.valid_end && coupon.valid_end < new Date()) {
      throw new HTTPException(409, { message: "优惠码不在有效期内" });
    }
    if (coupon.max_use) {
      const count = await db.planOrder.count({
        where: {
          coupon_id: coupon.id,
        },
      });
      if (count >= coupon.max_use) {
        throw new HTTPException(409, { message: "优惠码次数已用完" });
      }
    }
    if (coupon.max_use_per_user) {
      const count = await db.planOrder.count({
        where: {
          coupon_id: coupon.id,
          user_id,
        },
      });
      if (count >= coupon.max_use_per_user) {
        throw new HTTPException(409, { message: "优惠码每人只能使用一次" });
      }
    }
    return coupon;
  }
}

/** Self-registration. */
export const planCouponService = service<PlanCouponService>(TOKENS.Coupon, () => new PlanCouponService());
