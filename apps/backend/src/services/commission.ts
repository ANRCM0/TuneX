import { BalanceLogType, CommissionLogType, Prisma, SystemConfigName, WithdrawStatus } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../db";
import { instance, service, TOKENS } from "../container";
import { SystemConfigService } from "./system_config";
import { TicketService } from "./ticket";

/**
 * Upstream: src/services/commission.ts (184 lines) — ported 1:1.
 *
 * `commission_balance` is a separate wallet: it is only credited by referral payouts and
 * debited by withdrawals/transfers. `transferToBalance` moves it into `balance` and
 * writes both a commission log (negative) and a balance log (positive).
 */
export const WithdrawRequestQuerySchema = z.object({
  page: z.coerce.number().positive().default(1),
  perPage: z.coerce.number().int().default(10),
  sort: z
    .string()
    .transform((val) => JSON.parse(val))
    .nullish(),
  status: z.nativeEnum(WithdrawStatus).optional(),
  email: z.string().optional(),
});

export type WithdrawRequestQuery = z.infer<typeof WithdrawRequestQuerySchema>;

export class CommissionService {
  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly ticketService: TicketService,
  ) {}

  async transferToBalance(userId: number, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new HTTPException(400, { message: "划转金额必须大于0" });
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { commission_balance: true },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    if (user.commission_balance < amount) {
      throw new HTTPException(400, { message: "佣金余额不足" });
    }
    await db.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          commission_balance: { decrement: amount },
          balance: { increment: amount },
        },
        select: { balance: true, commission_balance: true },
      });
      await tx.commissionLog.create({
        data: {
          user_id: userId,
          balance: updatedUser.commission_balance,
          amount: -amount,
          type: CommissionLogType.transfer,
        },
      });
      await tx.balanceLog.create({
        data: {
          user_id: userId,
          balance: updatedUser.balance,
          amount,
          type: BalanceLogType.commission_transfer,
        },
      });
    });
  }

  async createWithdrawRequest(userId: number, amount: number, method: string, account: string) {
    const minAmount = await this.systemConfig.getConfig<number>(SystemConfigName.MIN_WITHDRAW_AMOUNT);
    if (amount < minAmount) {
      throw new HTTPException(400, { message: `最低提现金额为 ${minAmount} 元` });
    }
    const withdrawMethodsStr = (
      await this.systemConfig.getConfig<string>(SystemConfigName.WITHDRAW_METHODS)
    ).trim();
    if (!withdrawMethodsStr) {
      throw new HTTPException(400, { message: "暂不支持提现，请联系管理员" });
    }
    const withdrawMethods = withdrawMethodsStr.split(",");
    if (!withdrawMethods.includes(method)) {
      throw new HTTPException(400, { message: "不支持的提现方式" });
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { commission_balance: true },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    if (user.commission_balance < amount) {
      throw new HTTPException(400, { message: "佣金余额不足" });
    }
    const WITHDRAW_METHOD_MAP: Record<string, string> = {
      alipay: "支付宝",
      wechat: "微信",
      bank: "银行卡",
      usdt: "USDT",
    };
    const result = await db.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { commission_balance: { decrement: amount } },
        select: { commission_balance: true },
      });
      await tx.commissionLog.create({
        data: {
          user_id: userId,
          balance: updatedUser.commission_balance,
          amount: -amount,
          type: CommissionLogType.withdraw,
        },
      });
      const withdrawRequest = await tx.withdrawRequest.create({
        data: {
          user_id: userId,
          amount,
          method,
          account,
        },
      });
      return withdrawRequest;
    });
    await this.ticketService.createTicket(
      userId,
      "佣金提现申请",
      `提现金额：${amount} 元\n提现方式：${WITHDRAW_METHOD_MAP[method] || method}\n提现账号：${account}\n关联提现记录ID：${result.id}`,
    );
    return result;
  }

  async getWithdrawRequests(query: WithdrawRequestQuery, userId?: number) {
    const { page, perPage, sort, status, email } = query;
    const orderBy = sort?.map((s: { id: string; desc?: boolean }) => ({ [s.id]: s.desc ? "desc" : "asc" }));
    const where = {
      user_id: userId,
      status,
      user: email ? { email: { contains: email } } : undefined,
    };
    const [data, total] = await db.$transaction([
      db.withdrawRequest.findMany({
        where,
        orderBy: (orderBy as Prisma.WithdrawRequestOrderByWithRelationInput[] | undefined) || [
          { id: "desc" },
        ],
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: { select: { email: true } },
        },
      }),
      db.withdrawRequest.count({ where }),
    ]);
    return { data, total };
  }

  async approveWithdraw(id: number, remark?: string): Promise<void> {
    const request = await db.withdrawRequest.findUnique({
      where: { id, status: WithdrawStatus.pending },
    });
    if (!request) {
      throw new HTTPException(404, { message: "提现申请不存在或已处理" });
    }
    await db.withdrawRequest.update({
      where: { id },
      data: { status: WithdrawStatus.approved, remark },
    });
  }

  async rejectWithdraw(id: number, remark?: string): Promise<void> {
    const request = await db.withdrawRequest.findUnique({
      where: { id, status: WithdrawStatus.pending },
    });
    if (!request) {
      throw new HTTPException(404, { message: "提现申请不存在或已处理" });
    }
    await db.$transaction(async (tx) => {
      await tx.withdrawRequest.update({
        where: { id },
        data: { status: WithdrawStatus.rejected, remark },
      });
      await tx.user.update({
        where: { id: request.user_id },
        data: { commission_balance: { increment: request.amount } },
      });
    });
  }
}

/** Self-registration. */
export const commissionService = service<CommissionService>(
  TOKENS.Commission,
  () =>
    new CommissionService(
      instance.resolve<SystemConfigService>(TOKENS.SystemConfig),
      instance.resolve<TicketService>(TOKENS.Ticket),
    ),
);
