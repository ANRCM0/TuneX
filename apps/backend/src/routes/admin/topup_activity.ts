import { Prisma, TopupActivityType } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { BatchIdSchema, IdSchema, TableRequestSchema } from "../../schemas/request";
import { TopupActivitySchema } from "../../generated/zod";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/topup_activity.ts (100 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.post(
  "/",
  describeRoute({
    summary: "创建充值活动",
    tags: ["充值活动管理"],
    responses: {
      200: {
        description: "充值活动创建成功",
        content: {
          "application/json": {
            schema: resolver(TopupActivitySchema),
          },
        },
      },
    },
  }),
  zValidator("json", TopupActivitySchema.omit({ id: true, created_at: true, updated_at: true })),
  async (c) => {
    const data = c.req.valid("json");
    const activity = await db.topupActivity.create({
      data,
    });
    return c.json(activity, 201);
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取所有充值活动",
    tags: ["充值活动管理"],
    responses: {
      200: {
        description: "成功获取所有充值活动",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                data: TopupActivitySchema.array(),
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
      type: z.nativeEnum(TopupActivityType).optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, type } = c.req.valid("query");
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({ [sort2.id]: sort2.desc ? "desc" : "asc" }));
    const where = {
      type,
    };
    const { activities, total } = await db.$transaction(async (tx) => {
      const activities2 = await tx.topupActivity.findMany({
        where,
        orderBy: (orderBy as Prisma.TopupActivityOrderByWithRelationInput[] | undefined) || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
      });
      const total2 = await tx.topupActivity.count({ where });
      return { activities: activities2, total: total2 };
    });
    return c.json({ data: activities, total });
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新充值活动",
    tags: ["充值活动管理"],
    responses: {
      200: {
        description: "充值活动更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", TopupActivitySchema.omit({ id: true, created_at: true, updated_at: true }).partial()),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await db.topupActivity.update({
      where: { id },
      data,
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除充值活动",
    tags: ["充值活动管理"],
    responses: {
      200: {
        description: "充值活动删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await db.topupActivity.deleteMany({
      where: {
        id: { in: ids },
      },
    });
    return c.body(null, 204);
  },
);

export default router;
