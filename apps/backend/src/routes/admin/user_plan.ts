import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@prisma/client";
import { describeRoute, resolver, zValidator } from "../../openapi";
import {
  BatchIdSchema,
  BatchUserPlanRequestSchema,
  IdSchema,
  TableRequestSchema,
} from "../../schemas/request";
import {
  UserPlanRequestSchema,
  UserPlanResponseSchema,
  UserPlanUpdateRequestSchema,
} from "../../schemas/response";
import { db } from "../../db";
import type { AppEnv } from "../../types";

const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取所有用户计划",
    tags: ["管理员用户计划"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": { schema: resolver(UserPlanResponseSchema) },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      email: z.string().optional(),
      plan_id: z.coerce.number().optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, plan_id, email } = c.req.valid("query");
    const where = {
      plan_id: plan_id ? plan_id : undefined,
      user: email
        ? {
            email: { contains: email },
          }
        : undefined,
    };
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const [data, total] = await db.$transaction([
      db.userPlan.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        where,
        orderBy: orderBy || [{ id: "desc" }],
        include: {
          user: {
            select: {
              id: true,
              email: true,
            },
          },
          plan: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      db.userPlan.count({
        where,
      }),
    ]);
    return c.json({
      data,
      total,
    });
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建新用户计划",
    tags: ["管理员用户计划"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", UserPlanRequestSchema),
  async (c) => {
    const { user_id, plan_id, expired_at, traffic, max_tunnels } = c.req.valid("json");
    const user = await db.user.findUnique({
      where: { id: user_id },
      select: { id: true },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    const existingUserPlan = await db.userPlan.findUnique({
      where: { user_id },
    });
    if (existingUserPlan) {
      throw new HTTPException(409, { message: "用户套餐已存在" });
    }
    await db.userPlan.create({
      data: {
        user_id,
        plan_id,
        traffic_used: 0,
        expired_at,
        traffic,
        max_tunnels,
      },
    });
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "通过 ID 更新用户计划",
    tags: ["管理员用户计划"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", UserPlanUpdateRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { plan_id, traffic_used, expired_at, traffic, max_tunnels } = c.req.valid("json");
    const userPlan = await db.userPlan.findUnique({
      where: { id },
    });
    if (!userPlan) {
      throw new HTTPException(404, { message: "用户计划不存在" });
    }
    await db.userPlan.update({
      where: { id },
      data: {
        plan_id,
        traffic_used,
        expired_at,
        traffic,
        max_tunnels,
      },
    });
    return c.body(null, 204);
  },
);

router.delete(
  "",
  describeRoute({
    summary: "批量删除用户计划",
    tags: ["管理员用户计划"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await db.userPlan.deleteMany({ where: { id: { in: ids } } });
    return c.body(null, 204);
  },
);

router.patch(
  "/",
  describeRoute({
    summary: "批量更新用户套餐",
    tags: ["管理员用户计划"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", BatchUserPlanRequestSchema),
  async (c) => {
    const { ids, add_days, add_traffic } = c.req.valid("json");
    await db.$transaction(async (tx) => {
      for (const id of ids) {
        const userPlan = await tx.userPlan.findUnique({
          where: { id },
        });
        if (!userPlan) continue;
        const updateData: Prisma.UserPlanUpdateInput = {};
        if (add_days !== undefined && add_days > 0 && userPlan.expired_at !== null) {
          const baseDate = userPlan.expired_at > new Date() ? userPlan.expired_at : new Date();
          updateData.expired_at = new Date(baseDate.getTime() + add_days * 24 * 60 * 60 * 1000);
        }
        if (add_traffic !== undefined && add_traffic > 0 && userPlan.traffic !== null) {
          updateData.traffic = userPlan.traffic + add_traffic;
        }
        if (Object.keys(updateData).length > 0) {
          await tx.userPlan.update({
            where: { id },
            data: updateData,
          });
        }
      }
    });
    return c.body(null, 204);
  },
);

export default router;
