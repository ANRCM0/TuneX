import { BillingCycle, CouponType, Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { BatchIdSchema, IdSchema, TableRequestSchema } from "../../schemas/request";
import { PlanCouponSchema } from "../../generated/zod";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/plan_coupon.ts (101 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.post(
  "/",
  describeRoute({
    summary: "创建优惠券",
    tags: ["优惠券管理"],
    responses: {
      201: {
        description: "优惠券创建成功"
      },
    },
  }),
  zValidator("json", PlanCouponSchema.omit({ id: true, created_at: true, updated_at: true })),
  async (c) => {
    const data = c.req.valid("json");
    const coupon = await db.planCoupon.create({
      data,
    });
    return c.json(coupon, 201);
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取所有优惠券",
    tags: ["优惠券管理"],
    responses: {
      200: {
        description: "优惠券获取成功",
        content: {
          "application/json": {
            schema: resolver(PlanCouponSchema.array()),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      code: z.string().optional(),
      type: z.nativeEnum(CouponType).optional(),
      valid_cycle: z.nativeEnum(BillingCycle).optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, code, type, valid_cycle } = c.req.valid("query");
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({ [sort2.id]: sort2.desc ? "desc" : "asc" }));
    const where = {
      code: code ? { contains: code } : undefined,
      type: type ? type : undefined,
      valid_cycle: valid_cycle ? valid_cycle : undefined,
    };
    const { coupons, total } = await db.$transaction(async (tx) => {
      const coupons2 = await tx.planCoupon.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        where,
        orderBy: (orderBy as Prisma.PlanCouponOrderByWithRelationInput[] | undefined) || [{ id: "desc" }],
      });
      const total2 = await tx.planCoupon.count({ where });
      return { coupons: coupons2, total: total2 };
    });
    return c.json({ data: coupons, total });
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新优惠券",
    tags: ["优惠券管理"],
    responses: {
      204: {
        description: "优惠券更新成功",
      },
      404: {
        description: "优惠券未找到",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", PlanCouponSchema.omit({ id: true, created_at: true, updated_at: true }).partial()),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await db.planCoupon.update({
      where: { id },
      data,
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除优惠券",
    tags: ["优惠券管理"],
    responses: {
      204: {
        description: "优惠券删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await db.planCoupon.deleteMany({
      where: {
        id: { in: ids },
      },
    });
    return c.body(null, 204);
  },
);

export default router;
