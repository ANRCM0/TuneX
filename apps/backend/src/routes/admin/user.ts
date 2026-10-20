import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { BalanceLogType, CommissionLogType, Status } from "@prisma/client";
import { describeRoute, resolver, zValidator } from "../../openapi";
import {
  BalanceAdjustSchema,
  BalanceLogQuerySchema,
  BatchIdSchema,
  CommissionLogQuerySchema,
  IdSchema,
  TableRequestSchema,
  UserRequestSchema,
} from "../../schemas/request";
import {
  BalanceLogResponseSchema,
  CommissionLogResponseSchema,
  UserResponseSchema,
} from "../../schemas/response";
import { UserSchema } from "../../generated/zod";
import { db } from "../../db";
import { redisService } from "../../services/redis";
import { userService } from "../../services/user";
import type { AppEnv } from "../../types";

const router = new Hono<AppEnv>();

const IMPERSONATION_TTL_SECONDS = 2 * 60 * 60;

router.get(
  "/",
  describeRoute({
    summary: "获取所有用户",
    tags: ["管理员用户"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": { schema: resolver(UserResponseSchema) },
        },
      },
    },
  }),
  zValidator(
    "query",
    TableRequestSchema.extend({
      email: z.string().optional(),
      status: z.nativeEnum(Status).optional(),
      super_admin: z
        .string()
        .transform((val) => val === "true")
        .optional(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, email, status, super_admin } = c.req.valid("query");
    const where = {
      email: email ? { contains: email } : undefined,
      status: status ? status : undefined,
      super_admin: super_admin !== undefined ? super_admin : undefined,
    };
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const [data, total] = await db.$transaction([
      db.user.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        where,
        orderBy: orderBy || [{ id: "desc" }],
        include: { admin_roles: { select: { id: true, name: true } } },
      }),
      db.user.count({
        where,
      }),
    ]);
    return c.json({
      data: data.map(({ api_key: _apiKey, ...user }) => user),
      total,
    });
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建新用户",
    tags: ["管理员用户"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", UserRequestSchema),
  async (c) => {
    const actor = c.get("user");
    const {
      email,
      status,
      super_admin,
      auto_renew,
      tg_id,
      note,
      password,
      referral_commission_rate,
      referral_first_only,
      admin_role_ids,
    } = c.req.valid("json");
    if (!actor.super_admin && (super_admin === true || admin_role_ids !== undefined)) {
      throw new HTTPException(403, { message: "无权修改管理员权限" });
    }
    let uid: string | undefined;
    if (password) {
      const stackUserData = await userService.createUserWithPassword(email, password);
      uid = stackUserData.id;
    }
    await db.user.create({
      data: {
        email,
        status,
        super_admin,
        auto_renew,
        tg_id,
        note,
        uid,
        referral_commission_rate,
        referral_first_only,
        admin_roles: admin_role_ids
          ? { connect: admin_role_ids.map((roleId) => ({ id: roleId })) }
          : undefined,
      },
    });
    return c.body(null, 204);
  },
);

router.put(
  "/:id",
  describeRoute({
    summary: "通过 ID 更新用户",
    tags: ["管理员用户"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator(
    "json",
    UserSchema.pick({
      email: true,
      status: true,
      super_admin: true,
      auto_renew: true,
      tg_id: true,
      note: true,
      referral_commission_rate: true,
      referral_first_only: true,
    })
      .partial()
      .extend({
        admin_role_ids: z.array(z.number()).optional(),
      }),
  ),
  async (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("user");
    const {
      email,
      status,
      super_admin,
      auto_renew,
      tg_id,
      note,
      referral_commission_rate,
      referral_first_only,
      admin_role_ids,
    } = c.req.valid("json");
    if (!actor.super_admin) {
      if (super_admin !== undefined || admin_role_ids !== undefined) {
        throw new HTTPException(403, { message: "无权修改管理员权限" });
      }
      const target = await db.user.findUnique({
        where: { id },
        select: { super_admin: true },
      });
      if (target?.super_admin) {
        throw new HTTPException(403, { message: "无权修改管理员权限" });
      }
    }
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          email,
          status,
          super_admin,
          auto_renew,
          tg_id,
          note,
          referral_commission_rate,
          referral_first_only,
          admin_roles: admin_role_ids ? { set: admin_role_ids.map((roleId) => ({ id: roleId })) } : undefined,
        },
      });
      const adminExists = await tx.user.findFirst({
        where: {
          super_admin: true,
          status: Status.active,
        },
      });
      if (!adminExists) {
        throw new HTTPException(400, {
          message: "至少需要一个管理员",
        });
      }
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除用户",
    tags: ["管理员用户"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await db.$transaction(async (tx) => {
      await tx.tunnelTraffic.deleteMany({
        where: {
          tunnel: {
            user_id: {
              in: ids,
            },
          },
        },
      });
      await tx.tunnelChain.deleteMany({
        where: {
          tunnel: {
            user_id: {
              in: ids,
            },
          },
        },
      });
      await tx.tunnel.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.node.deleteMany({
        where: {
          node_group: {
            user_id: {
              in: ids,
            },
          },
        },
      });
      await tx.planNodeGroup.deleteMany({
        where: {
          node_group: {
            user_id: {
              in: ids,
            },
          },
        },
      });
      await tx.nodeGroup.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.userPlan.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.planOrder.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.topupOrder.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.balanceLog.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.commissionLog.deleteMany({
        where: {
          user_id: {
            in: ids,
          },
        },
      });
      await tx.user.deleteMany({
        where: { id: { in: ids } },
      });
      const adminExists = await tx.user.findFirst({
        where: {
          super_admin: true,
          status: Status.active,
        },
      });
      if (!adminExists) {
        throw new HTTPException(400, {
          message: "至少需要一个管理员",
        });
      }
    });
    return c.body(null, 204);
  },
);

router.post(
  "/:id/impersonate",
  describeRoute({
    summary: "以用户身份访问",
    description: "签发模拟登录令牌，超级管理员可以目标用户身份访问",
    tags: ["管理员用户"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                token: z.string(),
                max_age: z.number(),
              }),
            ),
          },
        },
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const actor = c.get("user");
    if (!actor.super_admin) {
      throw new HTTPException(403, { message: "无权以用户身份访问" });
    }
    const { id } = c.req.valid("param");
    const user = await db.user.findUnique({
      where: { id },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    if (user.status === Status.inactive) {
      throw new HTTPException(400, { message: "用户账户已被封禁" });
    }
    const token = crypto.randomUUID();
    await redisService.setImpersonation(token, user.id, IMPERSONATION_TTL_SECONDS);
    return c.json({ token, max_age: IMPERSONATION_TTL_SECONDS });
  },
);

router.patch(
  "/:id/password",
  describeRoute({
    summary: "修改用户密码",
    tags: ["管理员用户"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator(
    "json",
    z.object({
      password: z.string().min(6),
    }),
  ),
  async (c) => {
    const { id } = c.req.valid("param");
    const { password } = c.req.valid("json");
    await userService.changePassword(id, password);
    return c.body(null, 204);
  },
);

router.post(
  "/:id/balance/adjust",
  describeRoute({
    summary: "调整用户余额",
    tags: ["管理员用户"],
    responses: { 204: { description: "成功" } },
  }),
  zValidator("param", IdSchema),
  zValidator("json", BalanceAdjustSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { amount } = c.req.valid("json");
    await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      if (updated.balance < 0) {
        throw new HTTPException(400, { message: "调整后余额不能为负数" });
      }
      await tx.balanceLog.create({
        data: {
          user_id: id,
          amount,
          balance: updated.balance,
          type: BalanceLogType.admin_adjust,
        },
      });
    });
    return c.body(null, 204);
  },
);

router.post(
  "/:id/commission/adjust",
  describeRoute({
    summary: "调整用户佣金余额",
    tags: ["管理员用户"],
    responses: { 204: { description: "成功" } },
  }),
  zValidator("param", IdSchema),
  zValidator("json", BalanceAdjustSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { amount } = c.req.valid("json");
    await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { commission_balance: { increment: amount } },
        select: { commission_balance: true },
      });
      if (updated.commission_balance < 0) {
        throw new HTTPException(400, { message: "调整后佣金余额不能为负数" });
      }
      await tx.commissionLog.create({
        data: {
          user_id: id,
          amount,
          balance: updated.commission_balance,
          type: CommissionLogType.admin_adjust,
        },
      });
    });
    return c.body(null, 204);
  },
);

router.get(
  "/balance/log",
  describeRoute({
    summary: "获取余额记录",
    description: "获取余额记录",
    tags: ["管理员用户"],
    responses: {
      200: {
        description: "成功获取余额记录",
        content: {
          "application/json": { schema: resolver(BalanceLogResponseSchema) },
        },
      },
    },
  }),
  zValidator("query", BalanceLogQuerySchema),
  async (c) => {
    const { page, perPage, sort, type, email } = c.req.valid("query");
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const where = {
      type: type ? type : undefined,
      user: email ? { email: { contains: email } } : undefined,
    };
    const [data, total] = await db.$transaction([
      db.balanceLog.findMany({
        where,
        orderBy: orderBy || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: {
            select: {
              email: true,
            },
          },
        },
      }),
      db.balanceLog.count({
        where,
      }),
    ]);
    return c.json({
      data: data.map((log) => ({
        ...log,
        created_at: log.created_at.toISOString(),
      })),
      total,
    });
  },
);

router.get(
  "/commission/log",
  describeRoute({
    summary: "获取佣金记录",
    description: "获取佣金记录",
    tags: ["管理员用户"],
    responses: {
      200: {
        description: "成功获取佣金记录",
        content: {
          "application/json": { schema: resolver(CommissionLogResponseSchema) },
        },
      },
    },
  }),
  zValidator("query", CommissionLogQuerySchema),
  async (c) => {
    const { page, perPage, sort, type, email } = c.req.valid("query");
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const where = {
      type: type ? type : undefined,
      user: email ? { email: { contains: email } } : undefined,
    };
    const [data, total] = await db.$transaction([
      db.commissionLog.findMany({
        where,
        orderBy: orderBy || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: {
            select: {
              email: true,
            },
          },
        },
      }),
      db.commissionLog.count({
        where,
      }),
    ]);
    return c.json({
      data: data.map((log) => ({
        ...log,
        created_at: log.created_at.toISOString(),
      })),
      total,
    });
  },
);

export default router;
