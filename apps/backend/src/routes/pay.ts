import { Status, SystemConfigName, TopupOrderStatus } from "@prisma/client";
import { EPay } from "@relayx/shared/pay";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { logger } from "../logger";
import { describeRoute, resolver } from "../openapi";
import { PaymentSchema } from "../generated/zod";
import { getPayment } from "../services/pay";
import { notifyService } from "../services/notify";
import { systemConfigService } from "../services/system_config";
import { topupService } from "../services/topup";
import { settleTopupOrder } from "../services/topup-settlement";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/pay.ts (127 lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取支付方式",
    tags: ["支付"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(
              PaymentSchema.pick({
                id: true,
                name: true,
                method: true,
                type: true,
                fixed_fee: true,
                percent_fee: true,
              }).array(),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const payments = await db.payment.findMany({
      where: { status: Status.active },
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        method: true,
        type: true,
        fixed_fee: true,
        percent_fee: true,
      },
    });
    return c.json(payments);
  },
);

router.on(["POST", "GET"], "/:id/callback", async (c) => {
  const id = c.req.param("id");
  const method = c.req.method;
  let data: Record<string, any>;
  try {
    const contentType = c.req.header("content-type") || "";
    const parsed =
      method === "POST"
        ? contentType.includes("application/x-www-form-urlencoded")
          ? await c.req.parseBody()
          : await c.req.json()
        : c.req.query();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid callback payload");
    }
    data = parsed as Record<string, any>;
  } catch {
    throw new HTTPException(400, { message: "支付回调格式错误" });
  }
  const paymentId = Number(id);
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
    throw new HTTPException(404, { message: "支付方式不存在" });
  }
  const payment = await db.payment.findUnique({
    where: { id: paymentId, status: Status.active },
  });
  if (!payment) {
    throw new HTTPException(404, { message: "支付方式不存在" });
  }
  const pay = getPayment(payment);
  let order_id: string;
  let response: string;
  try {
    [order_id, response] = pay.notify(data);
    if (typeof order_id !== "string" || !order_id) {
      throw new Error("Missing payment order id");
    }
  } catch {
    throw new HTTPException(400, { message: "支付回调签名或状态无效" });
  }
  const pendingOrder = await db.topupOrder.findUnique({
    where: {
      order_id,
      payment_id: payment.id,
    },
  });
  if (!pendingOrder) {
    throw new HTTPException(404, { message: "充值订单不存在" });
  }
  const paymentOrder = {
    ...pendingOrder,
    type: payment.type,
  };
  try {
    pay.validateOrder(data, paymentOrder);
  } catch {
    throw new HTTPException(400, { message: "支付回调与充值订单不匹配" });
  }
  if (pendingOrder.status === TopupOrderStatus.success) {
    logger.warn(`订单已成功, order_id: ${order_id}`);
    return c.text(response);
  }
  if (pendingOrder.status !== TopupOrderStatus.pending) {
    throw new HTTPException(409, { message: "充值订单状态不正确" });
  }
  if (pay instanceof EPay) {
    try {
      await pay.verifyPaidOrder(paymentOrder);
    } catch {
      logger.warn({ order_id, payment_id: payment.id }, "支付网关查单未通过");
      throw new HTTPException(502, { message: "支付网关未确认订单支付成功" });
    }
  }
  const referralMode = await systemConfigService.getConfig<string>(SystemConfigName.REFERRAL_MODE);
  const commissionRate = await systemConfigService.getConfig<number>(
    SystemConfigName.REFERRAL_COMMISSION_RATE,
  );
  const order = await db.$transaction(async (tx) => {
    if (!(await settleTopupOrder(tx, pendingOrder))) {
      return null;
    }
    if (referralMode === "topup") {
      await topupService.processReferralCommission(
        tx,
        pendingOrder.user_id,
        pendingOrder.price,
        commissionRate,
      );
    }
    return pendingOrder;
  });
  if (order) {
    await notifyService.notifyTopup(order);
  }
  return c.text(response);
});

export default router;
