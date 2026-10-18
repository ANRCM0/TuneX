import { Status } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { describeRoute, resolver, zValidator } from "../openapi";
import { IdSchema, TableRequestSchema } from "../schemas/request";
import { PlanSummaryResponseSchema } from "../schemas/response";
import { PlanOrderSchema, PlanSchema } from "../generated/zod";
import { planService } from "../services/plan";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/plan.ts (125 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取所有套餐",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功获取所有套餐",
        content: {
          "application/json": {
            schema: resolver(PlanSchema.omit({ created_at: true, updated_at: true, status: true }).array()),
          },
        },
      },
    },
  }),
  async (c) => {
    const plans = await db.plan.findMany({
      where: {
        status: Status.active,
      },
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
    });
    return c.json(plans);
  },
);

router.get(
  "/:id/detail",
  describeRoute({
    summary: "获取套餐",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功获取套餐",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const plan = await db.plan.findUnique({
      where: { id },
    });
    return c.json(plan);
  },
);

router.post(
  "/:id/subscribe",
  describeRoute({
    summary: "订阅套餐",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功订阅套餐",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("query", z.object({ code: z.string().optional() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const { code } = c.req.valid("query");
    await planService.subscribePlan(user, id, false, code);
    return c.body(null, 201);
  },
);

router.post(
  "/renew",
  describeRoute({
    summary: "续费套餐",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功续费套餐",
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    await planService.renewUserPlan(user);
    return c.body(null, 201);
  },
);

router.get(
  "/orders",
  describeRoute({
    summary: "获取所有套餐订单",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功获取所有套餐订单",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: PlanOrderSchema.extend({
                  coupon: z.object({ value: z.number(), type: z.string() }),
                  plan: z.object({ name: z.string(), price: z.number() }),
                }).array(),
                total: z.number(),
              }),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", TableRequestSchema.extend({ plan_id: z.coerce.number().int().optional() })),
  async (c) => {
    const { page, perPage, sort, plan_id } = c.req.valid("query");
    const user = c.get("user");
    const { data, total } = await planService.getPlanOrders(page, perPage, user.id, sort, plan_id);
    return c.json({ data, total });
  },
);

router.get(
  "/summary",
  describeRoute({
    summary: "获取套餐摘要",
    tags: ["套餐"],
    responses: {
      200: {
        description: "成功获取套餐摘要",
        content: {
          "application/json": {
            schema: resolver(PlanSummaryResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const plans = await planService.getPlanSummary();
    return c.json(plans);
  },
);

export default router;
