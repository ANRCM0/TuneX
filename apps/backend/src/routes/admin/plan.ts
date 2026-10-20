import { BillingCycle, Prisma, Status } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { getDateGroupBy, getDateInterval, formatStatsDate, toLocalTZ } from "../../utils/date";
import { BatchIdSchema, IdSchema, TableRequestSchema } from "../../schemas/request";
import { OrderStatsResponseSchema } from "../../schemas/response";
import { PlanOrderSchema, PlanSchema } from "../../generated/zod";
import { planService } from "../../services/plan";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/plan.ts (228 lines) — ported 1:1.
 *
 * SQLite adaptation (see docs/DEVIATIONS.md): the stats query uses SQLite's
 * `datetime('now', '+8 hours', '-N days')` window instead of MySQL's
 * `NOW() - INTERVAL N DAY`; the TZ offset comes from `TZ_OFFSET` via the date helpers.
 */
const router = new Hono<AppEnv>();

router.post(
  "/",
  describeRoute({
    summary: "创建套餐",
    tags: ["套餐管理"],
    responses: {
      201: {
        description: "套餐创建成功",
      },
    },
  }),
  zValidator(
    "json",
    PlanSchema.omit({ id: true, created_at: true, updated_at: true, order_by: true }).extend({
      node_group_ids: z.array(z.number()),
    }),
  ),
  async (c) => {
    const { node_group_ids, ...data } = c.req.valid("json");
    const plan = await db.plan.create({
      data: {
        ...data,
        order_by: (await db.plan.count()) * 1000,
        node_groups: {
          create: node_group_ids.map((id) => ({
            node_group: { connect: { id } },
          })),
        },
      },
    });
    return c.json(plan, 201);
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取所有套餐",
    tags: ["套餐管理"],
    responses: {
      200: {
        description: "套餐获取成功",
        content: {
          "application/json": {
            schema: resolver(PlanSchema.extend({ node_group_ids: z.array(z.number()) }).array()),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      name: z.string().optional(),
      status: z.nativeEnum(Status).optional(),
      billing_cycle: z.nativeEnum(BillingCycle).optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, name, status, billing_cycle } = c.req.valid("query");
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({
      [sort2.id]: sort2.desc ? "desc" : "asc",
    }));
    const plans = await db.plan.findMany({
      skip: (page - 1) * perPage,
      take: perPage,
      where: {
        name: name ? { contains: name } : undefined,
        status: status ? status : undefined,
        billing_cycle: billing_cycle ? billing_cycle : undefined,
      },
      orderBy: (orderBy as Prisma.PlanOrderByWithRelationInput[] | undefined) || [
        { order_by: "desc" },
        { id: "desc" },
      ],
      include: {
        node_groups: {
          select: {
            node_group_id: true,
          },
        },
      },
    });
    return c.json(
      plans.map((plan) => ({
        ...plan,
        node_group_ids: plan.node_groups.map((ng) => ng.node_group_id),
      })),
      200,
    );
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "通过 ID 更新套餐顺序",
    tags: ["套餐管理"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", z.object({ order_by: z.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { order_by } = c.req.valid("json");
    await planService.updatePlanOrder(id, order_by);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新套餐",
    tags: ["套餐管理"],
    responses: {
      204: {
        description: "套餐更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator(
    "json",
    PlanSchema.omit({ id: true, order_by: true, created_at: true, updated_at: true }).extend({
      node_group_ids: z.array(z.number()),
    }),
  ),
  async (c) => {
    const { id } = c.req.valid("param");
    const { node_group_ids, ...data } = c.req.valid("json");
    await db.$transaction(async (tx) => {
      await tx.plan.update({
        where: { id },
        data: {
          node_groups: {
            deleteMany: {},
          },
        },
      });
      await tx.plan.update({
        where: { id },
        data: {
          ...data,
          node_groups: {
            create: node_group_ids.map((node_group_id) => ({
              node_group: { connect: { id: node_group_id } },
            })),
          },
        },
      });
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除套餐",
    tags: ["套餐管理"],
    responses: {
      204: {
        description: "套餐删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await planService.deletePlans(ids);
    return c.body(null, 204);
  },
);

router.get(
  "/orders",
  describeRoute({
    summary: "获取套餐订单",
    tags: ["套餐管理"],
    responses: {
      200: {
        description: "套餐订单获取成功",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: PlanOrderSchema.extend({
                  coupon: z.object({ value: z.number(), type: z.string() }),
                  plan: z.object({ name: z.string(), price: z.number() }),
                  user: z.object({ email: z.string() }),
                }).array(),
                total: z.number(),
              }),
            ),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      plan_id: z.coerce.number().int().optional(),
      email: z.string().optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, plan_id, email } = c.req.valid("query");
    const { data, total } = await planService.getPlanOrders(page, perPage, undefined, sort, plan_id, email);
    return c.json({ data, total });
  },
);

router.get(
  "/stats",
  describeRoute({
    summary: "获取订阅统计数据",
    tags: ["套餐管理"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(OrderStatsResponseSchema),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    z.object({
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      aggregate_by: z.enum(["day", "month", "year"]).optional(),
    }),
  ),
  async (c) => {
    const { start_date, end_date, aggregate_by } = c.req.valid("query");
    const interval = getDateInterval(aggregate_by);
    const localCreatedAt = toLocalTZ("created_at");
    const conds: string[] = [];
    if (start_date) {
      conds.push(`${localCreatedAt} >= '${start_date}'`);
    } else {
      conds.push(`${localCreatedAt} >= datetime('now', '+8 hours', '-${interval} days')`);
    }
    if (end_date) {
      conds.push(`${localCreatedAt} <= '${end_date}'`);
    }
    const dateGroupBy = getDateGroupBy("created_at", aggregate_by);
    const sql = `SELECT ${dateGroupBy} as date, SUM(price) as total FROM plan_order WHERE ${conds.join(
      " AND ",
    )} GROUP BY ${dateGroupBy} ORDER BY ${dateGroupBy}`;
    const rows = await db.$queryRawUnsafe<{ date: string; total: number }[]>(sql);
    return c.json(
      rows.map((item) => ({
        date: formatStatsDate(item.date, aggregate_by),
        total: item.total,
      })),
    );
  },
);

export default router;
