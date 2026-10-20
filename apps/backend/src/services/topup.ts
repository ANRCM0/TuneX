import { CommissionLogType, Status, SystemConfigName, TopupOrder, TopupOrderStatus } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import type { Prisma } from "../db";
import { db } from "../db";
import { instance, service, TOKENS } from "../container";
import { LicenseService } from "./license";
import { SystemConfigService } from "./system_config";
import { getPayment } from "./pay";
import { settleTopupOrder } from "./topup-settlement";

export interface TopupOrderQuery {
  page: number;
  perPage: number;
  sort?: { id: string; desc?: boolean }[] | null;
  status?: TopupOrderStatus;
  payment?: number;
  order_id?: string;
  email?: string;
}

/**
 * Upstream: src/services/topup.ts (155 lines) — ported 1:1.
 *
 * Also hosts the referral payout (`processReferralCommission`), the single place where
 * `commission_balance` is credited from a topup or plan purchase. It must never credit
 * twice: `REFERRAL_FIRST_ONLY` (parent override, else system config) makes the payout
 * conditional on the parent having no prior `referral` commission log.
 */
export class TopupService {
  constructor(
    private readonly licenseService: LicenseService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async processReferralCommission(
    tx: Prisma.TransactionClient,
    userId: number,
    amount: number,
    commissionRate?: number,
  ): Promise<void> {
    const license = await this.licenseService.getLicense();
    if (license?.type !== "business") {
      return;
    }
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { parent_id: true },
    });
    if (!user || !user.parent_id) {
      return;
    }
    const parentUser = await tx.user.findUnique({
      where: { id: user.parent_id },
      select: { id: true, referral_commission_rate: true, referral_first_only: true },
    });
    if (!parentUser) {
      return;
    }
    const firstOnly =
      parentUser.referral_first_only ??
      (await this.systemConfig.getConfig<boolean>(SystemConfigName.REFERRAL_FIRST_ONLY));
    if (firstOnly) {
      const existingCommission = await tx.commissionLog.findFirst({
        where: {
          user_id: user.parent_id,
          type: CommissionLogType.referral,
        },
      });
      if (existingCommission) {
        return;
      }
    }
    const rate =
      parentUser.referral_commission_rate ??
      commissionRate ??
      (await this.systemConfig.getConfig<number>(SystemConfigName.REFERRAL_COMMISSION_RATE));
    if (!rate || rate <= 0) {
      return;
    }
    const commissionAmount = (amount * rate) / 100;
    if (commissionAmount <= 0) {
      return;
    }
    const updatedParent = await tx.user.update({
      where: { id: parentUser.id },
      data: { commission_balance: { increment: commissionAmount } },
      select: { commission_balance: true },
    });
    await tx.commissionLog.create({
      data: {
        user_id: parentUser.id,
        balance: updatedParent.commission_balance,
        amount: commissionAmount,
        type: CommissionLogType.referral,
      },
    });
  }

  async getTopupOrders(
    query: TopupOrderQuery,
    user_id?: number,
  ): Promise<{ data: TopupOrder[]; total: number }> {
    const { page, perPage, sort, status, payment, order_id, email } = query;
    const orderBy = sort?.map((sort2) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    });
    const where = {
      user_id,
      status,
      payment_id: payment,
      order_id: order_id ? { contains: order_id } : undefined,
      user: email ? { email: { contains: email } } : undefined,
    };
    const [data, total] = await db.$transaction([
      db.topupOrder.findMany({
        where,
        orderBy: (orderBy as never) || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: {
            select: {
              email: true,
            },
          },
          payment: {
            select: {
              name: true,
            },
          },
        },
      }),
      db.topupOrder.count({
        where,
      }),
    ]);
    return { data, total };
  }

  async cancel(id: number, user_id?: number): Promise<void> {
    const topup_order = await db.topupOrder.findUnique({
      where: { id, user_id, status: TopupOrderStatus.pending },
    });
    if (!topup_order) {
      throw new HTTPException(404, { message: "充值订单不存在" });
    }
    const payment = await db.payment.findUnique({
      where: { id: topup_order.payment_id, status: Status.active },
    });
    if (!payment) {
      throw new HTTPException(404, { message: "支付方式不存在" });
    }
    const pay = getPayment(payment);
    await pay.cancelOrder(topup_order.trade_id as string);
    const cancelled = await db.topupOrder.updateMany({
      where: { id, status: TopupOrderStatus.pending },
      data: { status: TopupOrderStatus.cancelled },
    });
    if (cancelled.count === 0) {
      throw new HTTPException(409, { message: "充值订单状态已变更" });
    }
  }

  async markAsPaid(id: number): Promise<void> {
    const topup_order = await db.topupOrder.findUnique({
      where: { id, status: TopupOrderStatus.pending },
    });
    if (!topup_order) {
      throw new HTTPException(404, { message: "充值订单不存在或状态不正确" });
    }
    const referralMode = await this.systemConfig.getConfig<string>(SystemConfigName.REFERRAL_MODE);
    const commissionRate = await this.systemConfig.getConfig<number>(
      SystemConfigName.REFERRAL_COMMISSION_RATE,
    );
    await db.$transaction(async (tx) => {
      if (!(await settleTopupOrder(tx, topup_order))) {
        throw new HTTPException(409, { message: "充值订单状态已变更" });
      }
      if (referralMode === "topup") {
        await this.processReferralCommission(tx, topup_order.user_id, topup_order.price, commissionRate);
      }
    });
  }
}

/** Self-registration. */
export const topupService = service<TopupService>(
  TOKENS.Topup,
  () =>
    new TopupService(
      instance.resolve<LicenseService>(TOKENS.License),
      instance.resolve<SystemConfigService>(TOKENS.SystemConfig),
    ),
);
