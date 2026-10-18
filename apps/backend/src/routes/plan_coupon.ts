import { BillingCycle } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../openapi";
import { PlanCouponSchema } from "../generated/zod";
import { planCouponService } from "../services/plan_coupon";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/plan_coupon.ts (34 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "",
  describeRoute({
    summary: "获取优惠券",
    tags: ["优惠券"],
    responses: {
      200: {
        description: "优惠券获取成功",
        content: {
          "application/json": {
            schema: resolver(PlanCouponSchema.pick({ type: true, value: true })),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    z.object({
      code: z.string().min(1),
      cycle: z.nativeEnum(BillingCycle),
    }),
  ),
  async (c) => {
    const { code, cycle } = c.req.valid("query");
    const user_id = c.get("user").id;
    const coupon = await planCouponService.getCoupon(code, cycle, user_id);
    return c.json({ type: coupon.type, value: coupon.value });
  },
);

export default router;
