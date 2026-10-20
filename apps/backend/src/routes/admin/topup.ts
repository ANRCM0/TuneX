import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import {
  formatStatsDate,
  getDateGroupBy,
  getDateInterval,
  localNowMinusDays,
  toLocalTZ,
} from "../../utils/date";
import { IdSchema, TopupOrderQuerySchema } from "../../schemas/request";
import { TopupOrderResponseSchema, TopupOrderStatsResponseSchema } from "../../schemas/response";
import { topupService } from "../../services/topup";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/topup.ts (95 lines) — ported 1:1.
 *
 * The stats window is `localNowMinusDays(N)` from utils/date.ts — SQLite
 * `datetime('now', '+8 hours', '-N days')` or MySQL `DATE_FORMAT(DATE_SUB(CONVERT_TZ(
 * UTC_TIMESTAMP(), …), INTERVAL N DAY), …)`, both shaped like `toLocalTZ` so the
 * comparison is text-to-text on either engine.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取充值订单列表",
    tags: ["充值管理"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(TopupOrderResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", TopupOrderQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const { data, total } = await topupService.getTopupOrders(query);
    return c.json({ data, total });
  },
);

router.patch(
  "/:id/cancel",
  describeRoute({
    summary: "取消充值订单",
    tags: ["充值管理"],
    responses: {
      204: {
        description: "成功取消充值订单",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    await topupService.cancel(id);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/mark-paid",
  describeRoute({
    summary: "手动设置充值订单为已支付",
    tags: ["充值管理"],
    responses: {
      204: {
        description: "成功设置充值订单为已支付",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    await topupService.markAsPaid(id);
    return c.body(null, 204);
  },
);

router.get(
  "/stats",
  describeRoute({
    summary: "获取充值统计数据",
    tags: ["充值管理"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(TopupOrderStatsResponseSchema),
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
      payment_id: z.coerce.number().optional(),
    }),
  ),
  async (c) => {
    const { start_date, end_date, aggregate_by, payment_id } = c.req.valid("query");
    const interval = getDateInterval(aggregate_by);
    const localCreatedAt = toLocalTZ("created_at");
    const conds: string[] = ["status = 'success'"];
    if (start_date) {
      conds.push(`${localCreatedAt} >= '${start_date}'`);
    } else {
      conds.push(`${localCreatedAt} >= ${localNowMinusDays(interval)}`);
    }
    if (end_date) {
      conds.push(`${localCreatedAt} <= '${end_date}'`);
    }
    if (payment_id) {
      conds.push(`payment_id = ${payment_id}`);
    }
    const dateGroupBy = getDateGroupBy("created_at", aggregate_by);
    const sql = `SELECT ${dateGroupBy} as date, SUM(price) as total FROM topup_order WHERE ${conds.join(
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
