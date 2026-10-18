import { BalanceLogType, BalanceLog, CommissionLogType, Prisma } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { db } from "../db";
import { service, TOKENS } from "../container";
import { BalanceLogQuerySchema } from "../schemas/request";

export type BalanceLogQuery = z.infer<typeof BalanceLogQuerySchema>;

/**
 * Replica-only helper (no upstream `src/services/balance.ts` exists).
 *
 * Upstream implements these operations inline in `routes/user.ts` (`GET /balance/log`)
 * and `routes/admin/user.ts` (`POST /:id/balance/adjust`, `POST /:id/commission/adjust`,
 * `GET /balance/log`). Those route modules are owned by the identity vertical and keep
 * their faithful inline implementations; this service exposes the same semantics for
 * reuse without changing any route behaviour.
 */
export class BalanceService {
  async getBalanceLogs(query: BalanceLogQuery, user_id?: number) {
    const { page, perPage, sort, type, email } = query;
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({
      [sort2.id]: sort2.desc ? "desc" : "asc",
    }));
    const where = {
      user_id,
      type: type ? type : undefined,
      user: email ? { email: { contains: email } } : undefined,
    };
    const [data, total] = await db.$transaction([
      db.balanceLog.findMany({
        where,
        orderBy: (orderBy as Prisma.BalanceLogOrderByWithRelationInput[] | undefined) || [{ id: "desc" }],
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
    return {
      data: data.map((log: BalanceLog) => ({
        ...log,
        created_at: log.created_at.toISOString(),
      })),
      total,
    };
  }

  async adjustBalance(userId: number, amount: number): Promise<void> {
    await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      if (updated.balance < 0) {
        throw new HTTPException(400, { message: "调整后余额不能为负数" });
      }
      await tx.balanceLog.create({
        data: {
          user_id: userId,
          amount,
          balance: updated.balance,
          type: BalanceLogType.admin_adjust,
        },
      });
    });
  }

  async adjustCommissionBalance(userId: number, amount: number): Promise<void> {
    await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { commission_balance: { increment: amount } },
        select: { commission_balance: true },
      });
      if (updated.commission_balance < 0) {
        throw new HTTPException(400, { message: "调整后佣金余额不能为负数" });
      }
      await tx.commissionLog.create({
        data: {
          user_id: userId,
          amount,
          balance: updated.commission_balance,
          type: CommissionLogType.admin_adjust,
        },
      });
    });
  }
}

/** Self-registration. */
export const balanceService = service<BalanceService>(TOKENS.Balance, () => new BalanceService());
