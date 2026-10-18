import { Hono } from "hono";
import { z } from "zod";
import { CommissionLogType, Prisma, SystemConfigName } from "@prisma/client";
import { formatDate } from "@relayx/shared/date";
import { describeRoute, resolver, zValidator } from "../openapi";
import {
  BalanceLogQuerySchema,
  CommissionLogQuerySchema,
  ReferralStatsQuerySchema,
  UserUpdateSchema,
} from "../schemas/request";
import {
  BalanceLogResponseSchema,
  CommissionLogResponseSchema,
  ReferralInfoResponseSchema,
  ReferralStatsResponseSchema,
} from "../schemas/response";
import {
  AdminNotifyType,
  NotifyType,
  buildAdminNotifySubscriptionsResponse,
  normalizeNotifySubscriptions,
} from "../services/notify-types";
import { systemConfigService } from "../services/system_config";
import { getEffectiveAccess } from "../middlewares/auth";
import { SITE_URL } from "../config";
import { db } from "../db";
import { PlanSchema, UserPlanSchema, UserSchema } from "../generated/zod";
import { formatStatsDate, getDateGroupBy, getDateInterval, toLocalTZ } from "../utils/date";
import type { AppEnv } from "../types";

const router = new Hono<AppEnv>();

/**
 * SQLite has no `NOW() - INTERVAL n DAY`; the equivalent local-time bound is
 * `datetime('now', '+8 hours', '-n days')`, which is directly comparable with the
 * `datetime(col / 1000, 'unixepoch', '+8 hours')` fragments built by `utils/date`.
 */
const localNowMinusDays = (days: number): string =>
  `datetime('now', '+8 hours', '-${days} days')`;

router.get(
  "/info",
  describeRoute({
    summary: "获取用户信息",
    description: "获取用户信息",
    tags: ["用户"],
    responses: {
      200: {
        description: "用户信息",
        content: {
          "application/json": {
            schema: resolver(
              UserSchema.omit({
                notify_subscriptions: true,
                admin_notify_subscriptions: true,
                api_key: true,
              }).extend({
                notify_subscriptions: z.record(
                  z.nativeEnum(NotifyType),
                  z.object({ email: z.boolean(), telegram: z.boolean() }),
                ),
                admin_notify_subscriptions: z.record(
                  z.nativeEnum(AdminNotifyType),
                  z.object({ email: z.boolean(), telegram: z.boolean() }),
                ),
                plan: PlanSchema.extend({
                  user_plan: UserPlanSchema.omit({
                    whitelist_ips: true,
                  }).extend({
                    whitelist_ips: z.array(z.string()).nullable(),
                  }),
                }),
                admin_roles: z.array(z.object({ id: z.number(), name: z.string() })),
                admin_access: z.record(z.string(), z.enum(["read", "write"])),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const user_plan = await db.userPlan.findUnique({
      where: {
        user_id: user.id,
      },
      include: {
        plan: true,
      },
    });
    if (user_plan) {
      user_plan.traffic = user_plan.traffic ?? user_plan.plan.traffic;
    }
    const { admin_roles, api_key: _apiKey, ...userScalars } = user;
    return c.json({
      ...userScalars,
      notify_subscriptions: normalizeNotifySubscriptions(user.notify_subscriptions),
      admin_notify_subscriptions: user.super_admin
        ? buildAdminNotifySubscriptionsResponse(user.admin_notify_subscriptions)
        : {},
      user_plan,
      admin_roles: admin_roles.map((role) => ({ id: role.id, name: role.name })),
      admin_access: Object.fromEntries(getEffectiveAccess(user)),
    });
  },
);

router.patch(
  "",
  describeRoute({
    summary: "更新用户信息",
    description: "更新用户信息",
    tags: ["用户"],
    responses: {
      200: {
        description: "更新用户信息成功，重置 API Key 时返回新密钥（仅此一次）",
        content: {
          "application/json": {
            schema: resolver(z.object({ api_key: z.string().optional() })),
          },
        },
      },
    },
  }),
  zValidator("json", UserUpdateSchema),
  async (c) => {
    const user = c.get("user");
    const {
      auto_renew,
      notify_subscriptions,
      admin_notify_subscriptions,
      api_key,
      subscription_key,
    } = c.req.valid("json");
    const data: Prisma.UserUpdateInput = {};
    if (auto_renew !== undefined) {
      data.auto_renew = auto_renew;
    }
    if (notify_subscriptions !== undefined) {
      data.notify_subscriptions = normalizeNotifySubscriptions(
        notify_subscriptions,
      ) as Prisma.InputJsonValue;
    }
    if (admin_notify_subscriptions !== undefined && user.super_admin) {
      data.admin_notify_subscriptions =
        admin_notify_subscriptions as unknown as Prisma.InputJsonValue;
    }
    let newApiKey: string | undefined;
    if (api_key !== undefined) {
      newApiKey = crypto.randomUUID();
      data.api_key = newApiKey;
    }
    if (subscription_key !== undefined) {
      data.subscription_key = crypto.randomUUID();
    }
    await db.user.update({
      where: { id: user.id },
      data,
    });
    return c.json({ api_key: newApiKey });
  },
);

router.get(
  "/balance/log",
  describeRoute({
    summary: "获取余额记录",
    description: "获取余额记录",
    tags: ["用户"],
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
    const user = c.get("user");
    const { page, perPage, sort, type } = c.req.valid("query");
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const where = {
      user_id: user.id,
      type: type ? type : undefined,
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
    tags: ["用户"],
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
    const user = c.get("user");
    const { page, perPage, sort, type } = c.req.valid("query");
    const orderBy = sort?.map((sort: { id: string; desc?: boolean }) => {
      return {
        [sort.id]: sort.desc ? "desc" : "asc",
      };
    });
    const where = {
      user_id: user.id,
      type: type ? type : undefined,
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

router.get(
  "/referral/info",
  describeRoute({
    summary: "获取推广信息",
    description: "获取推广信息",
    tags: ["用户"],
    responses: {
      200: {
        description: "成功获取推广信息",
        content: {
          "application/json": { schema: resolver(ReferralInfoResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const referralUrl = `${SITE_URL}?ref=${user.id}`;
    const systemCommissionRate =
      (await systemConfigService.getConfig<number>(SystemConfigName.REFERRAL_COMMISSION_RATE)) || 0;
    const commissionRate = user.referral_commission_rate ?? systemCommissionRate;
    const referralCount = await db.user.count({
      where: {
        parent_id: user.id,
      },
    });
    const totalEarningsResult = await db.commissionLog.aggregate({
      where: {
        user_id: user.id,
        type: CommissionLogType.referral,
      },
      _sum: {
        amount: true,
      },
    });
    const totalEarnings = totalEarningsResult._sum.amount || 0;
    return c.json({
      referral_url: referralUrl,
      commission_rate: commissionRate,
      referral_count: referralCount,
      total_earnings: totalEarnings,
    });
  },
);

router.get(
  "/referral/stats",
  describeRoute({
    summary: "获取推广统计",
    description: "获取推广统计",
    tags: ["用户"],
    responses: {
      200: {
        description: "成功获取推广统计",
        content: {
          "application/json": { schema: resolver(ReferralStatsResponseSchema) },
        },
      },
    },
  }),
  zValidator("query", ReferralStatsQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { start_date, end_date, aggregate_by } = c.req.valid("query");
    const whereConditions = [`user.parent_id = ${user.id}`];
    const interval = getDateInterval(aggregate_by);
    const localUserCreatedAt = toLocalTZ("user.created_at");
    if (start_date) {
      whereConditions.push(`DATE(${localUserCreatedAt}) >= '${formatDate(start_date)}'`);
    } else {
      whereConditions.push(`${localUserCreatedAt} > ${localNowMinusDays(interval)}`);
    }
    if (end_date) {
      whereConditions.push(`DATE(${localUserCreatedAt}) <= '${formatDate(end_date)}'`);
    }
    const dateGroupBy = getDateGroupBy("user.created_at", aggregate_by);
    const referralCountQuery = `
        SELECT
          ${dateGroupBy} AS date,
          COUNT(*) AS referral_count
        FROM user
        WHERE ${whereConditions.join(" AND ")}
        GROUP BY ${dateGroupBy}
        ORDER BY ${dateGroupBy}
      `;
    const earningsWhereConditions = [
      `commission_log.user_id = ${user.id}`,
      `commission_log.type = 'referral'`,
    ];
    const localCommissionCreatedAt = toLocalTZ("commission_log.created_at");
    if (start_date) {
      earningsWhereConditions.push(
        `DATE(${localCommissionCreatedAt}) >= '${formatDate(start_date)}'`,
      );
    } else {
      earningsWhereConditions.push(`${localCommissionCreatedAt} > ${localNowMinusDays(interval)}`);
    }
    if (end_date) {
      earningsWhereConditions.push(
        `DATE(${localCommissionCreatedAt}) <= '${formatDate(end_date)}'`,
      );
    }
    const earningsDateGroupBy = getDateGroupBy("commission_log.created_at", aggregate_by);
    const earningsQuery = `
        SELECT
          ${earningsDateGroupBy} AS date,
          SUM(commission_log.amount) AS earnings
        FROM commission_log
        WHERE ${earningsWhereConditions.join(" AND ")}
        GROUP BY ${earningsDateGroupBy}
        ORDER BY ${earningsDateGroupBy}
      `;
    const [referralCounts, earnings] = await Promise.all([
      db.$queryRawUnsafe<{ date: unknown; referral_count: unknown }[]>(referralCountQuery),
      db.$queryRawUnsafe<{ date: unknown; earnings: unknown }[]>(earningsQuery),
    ]);
    const dateMap = new Map<string, { referral_count: number; earnings: number }>();
    referralCounts.forEach((item) => {
      const dateKey = formatStatsDate(item.date, aggregate_by);
      dateMap.set(dateKey, {
        referral_count: Number(item.referral_count),
        earnings: 0,
      });
    });
    earnings.forEach((item) => {
      const dateKey = formatStatsDate(item.date, aggregate_by);
      const existing = dateMap.get(dateKey);
      if (existing) {
        existing.earnings = Number(item.earnings);
      } else {
        dateMap.set(dateKey, {
          referral_count: 0,
          earnings: Number(item.earnings),
        });
      }
    });
    const result = Array.from(dateMap.entries())
      .map(([date, data]) => ({
        date,
        referral_count: data.referral_count,
        earnings: data.earnings,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return c.json(result);
  },
);

export default router;
