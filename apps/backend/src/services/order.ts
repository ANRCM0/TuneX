import { TopupOrderStatus } from "@prisma/client";
import { db } from "../db";
import { service, TOKENS } from "../container";

/**
 * Upstream: src/services/order.ts (20 lines) — ported 1:1.
 */
export class OrderService {
  async cancelUnpaidOrder(id: number): Promise<void> {
    await db.topupOrder.updateMany({
      where: {
        id,
        status: TopupOrderStatus.pending,
      },
      data: { status: TopupOrderStatus.cancelled },
    });
  }
}

/** Self-registration. */
export const orderService = service<OrderService>(TOKENS.PlanOrder, () => new OrderService());
