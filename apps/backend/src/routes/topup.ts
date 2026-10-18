import { Status, SystemConfigName, TopupOrderStatus } from "@prisma/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { queueDefault } from "../bullmq/queue";
import { db } from "../db";
import { describeRoute, resolver, zValidator } from "../openapi";
import { IdSchema, TopupOrderQuerySchema } from "../schemas/request";
import { TopupOrderResponseSchema } from "../schemas/response";
import { TopupActivitySchema, TopupOrderSchema } from "../generated/zod";
import { getPayment } from "../services/pay";
import { redisService } from "../services/redis";
import { systemConfigService } from "../services/system_config";
import { topupService } from "../services/topup";
import { topupActivityService } from "../services/topup_activity";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/topup.ts (136 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/activities",
  describeRoute({
    summary: "获取当前活跃的充值活动",
    tags: ["充值"],
    responses: {
      200: {
        description: "成功获取当前活跃的充值活动",
        content: {
          "application/json": {
            schema: resolver(TopupActivitySchema.array()),
          },
        },
      },
    },
  }),
  async (c) => {
    const activities = await topupActivityService.getActiveTopupActivities();
    return c.json(activities);
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取充值记录",
    tags: ["充值"],
    responses: {
      200: {
        description: "成功获取充值记录",
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
    const user = c.get("user");
    const { data, total } = await topupService.getTopupOrders(query, user.id);
    return c.json({ data, total });
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建充值订单",
    tags: ["充值"],
    responses: {
      200: {
        description: "充值订单创建成功",
        content: {
          "application/json": {
            schema: resolver(z.object({ pay_url: z.string() })),
          },
        },
      },
    },
  }),
  zValidator(
    "json",
    TopupOrderSchema.pick({ price: true }).extend({
      redirect_url: z.string().url(),
      payment_id: z.coerce.number(),
    }),
  ),
  async (c) => {
    const { price, redirect_url, payment_id } = c.req.valid("json");
    const user = c.get("user");
    const ip = c.get("ip");
    const minTopupAmount = await systemConfigService.getConfig<number>(SystemConfigName.MIN_TOPUP_AMOUNT);
    if (price < minTopupAmount) {
      throw new HTTPException(400, { message: `充值金额不能小于 ${minTopupAmount} 元` });
    }
    const payment = await db.payment.findUnique({
      where: { id: payment_id, status: Status.active },
    });
    if (!payment) {
      throw new HTTPException(404, { message: "支付方式不存在" });
    }
    const pay = getPayment(payment);
    let pay_url = "";
    await redisService.lockTopupOrder(user.id, async () => {
      const pending_order = await db.topupOrder.findFirst({
        where: {
          user_id: user.id,
          status: TopupOrderStatus.pending,
        },
      });
      if (pending_order) {
        throw new HTTPException(409, { message: "存在未完成的充值订单" });
      }
      const order_id = pay.generateOrderNo();
      const [url, trade_id] = await pay.pay(order_id, price, redirect_url, ip, payment.type ?? undefined);
      pay_url = url;
      const bonus = await topupActivityService.calculateBonus(price);
      const order = await db.topupOrder.create({
        data: {
          user_id: user.id,
          price,
          pay_url,
          payment_id,
          order_id,
          trade_id,
          balance: user.balance,
          bonus,
        },
      });
      await queueDefault?.add("cancel_unpaid_order", { id: order.id }, { delay: 10 * 60 * 1000 });
    });
    return c.json({ pay_url });
  },
);

router.patch(
  "/:id/cancel",
  describeRoute({
    summary: "取消充值订单",
    tags: ["充值"],
    responses: {
      200: {
        description: "成功取消充值订单",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    await topupService.cancel(id, user.id);
    return c.body(null, 204);
  },
);

export default router;
