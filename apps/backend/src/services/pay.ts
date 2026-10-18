import { Payment as PaymentModel } from "@prisma/client";
import { getPay, type BasePay, type PaymentConfig } from "@relayx/shared/pay";
import { SITE_URL } from "../config";
import { db } from "../db";
import { service, TOKENS } from "../container";

/**
 * Upstream: src/services/pay.ts (29 lines) — ported 1:1.
 */
export const getPayment = (payment: PaymentModel): BasePay => {
  return getPay({
    id: payment.id,
    name: payment.name,
    url: payment.url,
    method: payment.method,
    fixed_fee: payment.fixed_fee,
    percent_fee: payment.percent_fee,
    config: payment.config as unknown as PaymentConfig,
    notify_url: `${SITE_URL}/api/pay/${payment.id}/callback`,
  });
};

export class PaymentService {
  async updatePayOrder(id: number, order_by: number): Promise<void> {
    await db.payment.update({
      where: { id },
      data: { order_by },
    });
  }
}

/** Self-registration. */
export const paymentService = service<PaymentService>(TOKENS.Payment, () => new PaymentService());
