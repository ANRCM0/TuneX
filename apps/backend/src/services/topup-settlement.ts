import { BalanceLogType, TopupOrder, TopupOrderStatus } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import type { Prisma } from "../db";

/**
 * Upstream: src/services/topup-settlement.ts (45 lines) — ported 1:1.
 *
 * The settlement protocol is deliberately optimistic: the order row is claimed with a
 * conditional `updateMany` that repeats every field the payment callback was verified
 * against, so a replayed callback can never credit the balance twice.
 */
export async function settleTopupOrder(tx: Prisma.TransactionClient, order: TopupOrder): Promise<boolean> {
  const totalAmount = order.price + order.bonus;
  const claimed = await tx.topupOrder.updateMany({
    where: {
      id: order.id,
      status: TopupOrderStatus.pending,
      payment_id: order.payment_id,
      trade_id: order.trade_id,
      price: order.price,
      bonus: order.bonus,
    },
    data: {
      status: TopupOrderStatus.success,
      balance: { increment: totalAmount },
    },
  });
  if (claimed.count === 0) {
    const current = await tx.topupOrder.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    if (current?.status === TopupOrderStatus.success) {
      return false;
    }
    throw new HTTPException(409, { message: "充值订单不存在或状态不正确" });
  }
  const user = await tx.user.update({
    where: { id: order.user_id },
    data: { balance: { increment: totalAmount } },
    select: { balance: true },
  });
  await tx.balanceLog.create({
    data: {
      user_id: order.user_id,
      balance: user.balance,
      amount: totalAmount,
      type: BalanceLogType.topup,
    },
  });
  return true;
}
