import {
  BalanceLogType,
  BillingCycle,
  CouponType,
  Plan,
  PlanCoupon,
  Prisma,
  Status,
  SystemConfigName,
  UserPlan,
} from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import type { SessionUser } from "../types";
import { db } from "../db";
import { instance, service, TOKENS } from "../container";
import { PlanCouponService } from "./plan_coupon";
import { RedisService } from "./redis";
import { NotifyService } from "./notify";
import { SystemConfigService } from "./system_config";
import { TopupService } from "./topup";

export interface SortItem {
  id: string;
  desc?: boolean;
}

/** The coupon terms the pricing helper needs (a `PlanCoupon` row or a stub). */
export interface PlanCouponTerms {
  type: CouponType;
  value: number;
}

export interface PlanPriceInput {
  price: number;
  coupon: PlanCouponTerms | null;
  setup_fee?: number | null;
  /** True when the user already owns this plan, which waives the setup fee. */
  samePlan: boolean;
}

/**
 * Recovered pricing rule (`relayx-analysis/work/modules/038__src__services__plan.ts`):
 * apply the coupon to the list price, clamp at zero, then add the setup fee unless the
 * user is re-subscribing to the plan they already hold. The referral commission is paid
 * on `priceBeforeSetupFee`, so both numbers are returned.
 */
export function computePlanPrice(input: PlanPriceInput): { price: number; priceBeforeSetupFee: number } {
  let price = input.price;
  if (input.coupon) {
    price =
      input.coupon.type === CouponType.percentage
        ? price * (1 - input.coupon.value / 100)
        : price - input.coupon.value;
  }
  if (price < 0) {
    price = 0;
  }
  const priceBeforeSetupFee = price;
  if (input.setup_fee && !input.samePlan) {
    price += input.setup_fee;
  }
  return { price, priceBeforeSetupFee };
}

/**
 * Upstream: src/services/plan.ts (375 lines) — ported 1:1.
 *
 * `subscribePlan` is the money-side heart of the panel: it locks the user, prices the
 * plan (coupon, then setup fee), debits `balance`, writes the plan order + balance log,
 * bumps stock, and — when `REFERRAL_MODE` is "plan" — pays the referral commission on
 * the pre-setup-fee amount.
 */
export class PlanService {
  constructor(
    private readonly planCouponService: PlanCouponService,
    private readonly redisService: RedisService,
    private readonly notifyService: NotifyService,
    private readonly systemConfigService: SystemConfigService,
    private readonly topupService: TopupService,
  ) {}

  async deletePlans(ids: number[]): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.planNodeGroup.deleteMany({ where: { plan_id: { in: ids } } });
      await tx.planOrder.deleteMany({ where: { plan_id: { in: ids } } });
      await tx.userPlan.deleteMany({ where: { plan_id: { in: ids } } });
      await tx.plan.deleteMany({ where: { id: { in: ids } } });
    });
  }

  async getUserPlan(user: SessionUser): Promise<(UserPlan & { plan: Plan }) | null> {
    return await db.userPlan.findUnique({
      where: {
        user_id: user.id,
      },
      include: {
        plan: true,
      },
    });
  }

  async checkUserPlan(user: SessionUser): Promise<UserPlan & { plan: Plan }> {
    const plan = await this.getUserPlan(user);
    if (!plan) {
      throw new HTTPException(409, {
        message: "请先购买套餐",
      });
    }
    if (plan.expired_at && plan.expired_at < new Date()) {
      throw new HTTPException(409, {
        message: "套餐已过期，请及时续费",
      });
    }
    if (plan.plan.traffic && plan.traffic_used >= plan.plan.traffic) {
      throw new HTTPException(409, {
        message: "套餐流量已用完",
      });
    }
    return plan;
  }

  async renewUsersPlan(): Promise<void> {
    const users = await db.user.findMany({
      where: {
        auto_renew: true,
        status: Status.active,
        user_plan: {
          plan: {
            renewable: true,
          },
        },
      },
      include: {
        user_plan: {
          include: {
            plan: true,
          },
        },
      },
    });
    for (const user of users) {
      const user_plan = user.user_plan;
      if (!user_plan) {
        continue;
      }
      if (user.balance < user_plan.plan.price) {
        continue;
      }
      const plan = user_plan.plan;
      const expired_at = user_plan.expired_at;
      const traffic_used = user_plan.traffic_used;
      const traffic = plan.traffic;
      const now = new Date();
      const oneMinuteLater = new Date(now.getTime() + 1000 * 60);
      if (expired_at && expired_at < oneMinuteLater) {
        await this.subscribePlan(user as unknown as SessionUser, plan.id, true, undefined, undefined, true);
      } else if (traffic && traffic_used >= traffic - 1) {
        const remaining_traffic = traffic - traffic_used > 0 ? traffic - traffic_used : 0;
        await this.subscribePlan(
          user as unknown as SessionUser,
          plan.id,
          true,
          undefined,
          remaining_traffic,
          true,
        );
      }
    }
  }

  async renewUserPlan(user: SessionUser): Promise<void> {
    const user_plan = await this.getUserPlan(user);
    if (!user_plan) {
      throw new HTTPException(409, { message: "请先购买套餐" });
    }
    await this.subscribePlan(user, user_plan.plan_id, true);
  }

  async subscribePlan(
    user: SessionUser,
    plan_id: number,
    auto_renew = false,
    code?: string,
    remaining_traffic?: number,
    fromCron = false,
  ): Promise<void> {
    let plan: Plan | null = null;
    let price = 0;
    let balanceAfter = 0;
    let skipped = false;
    await this.redisService.lockUserSubscribe(user.id, async () => {
      await db.$transaction(async (tx) => {
        const oldUserPlan = await tx.userPlan.findUnique({
          where: { user_id: user.id },
        });
        plan = await tx.plan.findUnique({
          where: { id: plan_id },
        });
        if (!plan) {
          if (fromCron) {
            skipped = true;
            return;
          }
          throw new HTTPException(404, { message: "套餐不存在" });
        }
        if (fromCron && oldUserPlan && oldUserPlan.plan_id === plan_id) {
          const now = new Date();
          const oneMinuteLater = new Date(now.getTime() + 1000 * 60);
          const expiringSoon = oldUserPlan.expired_at && oldUserPlan.expired_at < oneMinuteLater;
          const trafficSoonOut = oldUserPlan.traffic
            ? oldUserPlan.traffic_used >= oldUserPlan.traffic - 1
            : false;
          if (!expiringSoon && !trafficSoonOut) {
            skipped = true;
            return;
          }
        }
        if (plan.stock !== null && plan.stock <= 0 && !auto_renew) {
          throw new HTTPException(409, { message: "套餐库存不足" });
        }
        let coupon: PlanCoupon | null = null;
        if (code) {
          coupon = await this.planCouponService.getCoupon(code, plan.billing_cycle, user.id);
        }
        const samePlan = oldUserPlan?.plan_id === plan_id;
        const priced = computePlanPrice({
          price: plan.price,
          coupon,
          setup_fee: plan.setup_fee,
          samePlan,
        });
        price = priced.price;
        const priceBeforeSetupFee = priced.priceBeforeSetupFee;
        const currentUser = await tx.user.findUnique({
          where: { id: user.id },
          select: { balance: true },
        });
        if (!currentUser) {
          throw new HTTPException(404, { message: "用户不存在" });
        }
        if (currentUser.balance < price) {
          if (auto_renew) {
            await this.notifyService.notifyRenewPlanFailed({
              user,
              plan,
              reason: "余额不足",
              expire_at: oldUserPlan?.expired_at ?? new Date(),
            });
          }
          throw new HTTPException(409, { message: "余额不足" });
        }
        let duration = 0;
        const billing_cycle = plan.billing_cycle;
        switch (billing_cycle) {
          case BillingCycle.month:
            duration = 30;
            break;
          case BillingCycle.quarter:
            duration = 90;
            break;
          case BillingCycle.half_year:
            duration = 180;
            break;
          case BillingCycle.year:
            duration = 365;
            break;
        }
        duration = duration * 24 * 60 * 60 * 1000;
        if (samePlan && !plan.renewable) {
          if (auto_renew) {
            await this.notifyService.notifyRenewPlanFailed({
              user,
              plan,
              reason: "套餐不可续费",
              expire_at: oldUserPlan?.expired_at ?? new Date(),
            });
          }
          throw new HTTPException(409, { message: "套餐不可续费" });
        }
        if (!samePlan && plan.status === Status.inactive) {
          if (auto_renew) {
            await this.notifyService.notifyRenewPlanFailed({
              user,
              plan,
              reason: "套餐已下架",
              expire_at: oldUserPlan?.expired_at ?? new Date(),
            });
          }
          throw new HTTPException(409, { message: "套餐已下架" });
        }
        let expired_at: Date | null = null;
        let traffic: number | null = plan.traffic;
        let traffic_used = 0;
        if (oldUserPlan) {
          if (!plan.traffic && plan.billing_cycle !== BillingCycle.lifetime) {
            const start_time =
              oldUserPlan.expired_at && oldUserPlan.expired_at > new Date()
                ? oldUserPlan.expired_at
                : new Date();
            expired_at = new Date(start_time.getTime() + duration);
            traffic_used = oldUserPlan.traffic_used;
          } else if (plan.billing_cycle === BillingCycle.lifetime && plan.traffic) {
            if (oldUserPlan.traffic) {
              traffic = plan.traffic + oldUserPlan.traffic;
            }
            traffic_used = oldUserPlan.traffic_used;
            expired_at = null;
          } else if (plan.billing_cycle === BillingCycle.lifetime && !plan.traffic) {
            expired_at = null;
            traffic = null;
            traffic_used = 0;
          } else {
            if (billing_cycle !== BillingCycle.lifetime) {
              expired_at = new Date(new Date().getTime() + duration);
            }
            traffic_used = 0;
          }
        } else {
          if (billing_cycle !== BillingCycle.lifetime) {
            expired_at = new Date(new Date().getTime() + duration);
          }
        }
        const data = {
          expired_at,
          traffic_used,
          plan_id,
          traffic: remaining_traffic && traffic ? remaining_traffic + traffic : traffic,
        };
        if (oldUserPlan) {
          await tx.userPlan.update({
            where: { id: oldUserPlan.id },
            data,
          });
        } else {
          await tx.userPlan.create({
            data: {
              ...data,
              user_id: user.id,
            },
          });
        }
        const updatedUser = await tx.user.update({
          where: { id: user.id, balance: { gte: price } },
          data: {
            balance: {
              decrement: price,
            },
          },
          select: { balance: true },
        });
        balanceAfter = updatedUser.balance;
        await tx.planOrder.create({
          data: {
            user_id: user.id,
            plan_id,
            price,
            balance: updatedUser.balance,
            coupon_id: coupon?.id,
          },
        });
        await tx.balanceLog.create({
          data: {
            user_id: user.id,
            balance: updatedUser.balance,
            amount: -price,
            type: BalanceLogType.plan,
          },
        });
        if (plan.stock !== null && plan.stock > 0 && !auto_renew) {
          await tx.plan.update({
            where: { id: plan_id },
            data: {
              stock: {
                decrement: 1,
              },
            },
          });
        }
        const referralMode = await this.systemConfigService.getConfig<string>(SystemConfigName.REFERRAL_MODE);
        if (referralMode === "plan" && price > 0) {
          await this.topupService.processReferralCommission(tx, user.id, priceBeforeSetupFee);
        }
      });
    });
    if (skipped) {
      return;
    }
    await this.notifyService.notifySubscribePlan(user, plan as unknown as Plan, price, balanceAfter);
  }

  async getPlanOrders(
    page: number,
    perPage: number,
    user_id?: number,
    sort?: SortItem[] | null,
    plan_id?: number,
    email?: string,
  ): Promise<{ data: unknown[]; total: number }> {
    const orderBy = sort?.map((sort2) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    });
    const [data, total] = await db.$transaction([
      db.planOrder.findMany({
        where: {
          user_id,
          plan_id,
          user: email ? { email: { contains: email } } : undefined,
        },
        orderBy: (orderBy as Prisma.PlanOrderOrderByWithRelationInput[] | undefined) || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          plan: {
            select: {
              name: true,
              price: true,
            },
          },
          coupon: {
            select: {
              type: true,
              value: true,
            },
          },
          user: {
            select: {
              email: true,
            },
          },
        },
      }),
      db.planOrder.count({
        where: { user_id },
      }),
    ]);
    return { data, total };
  }

  async updatePlanOrder(id: number, order_by: number): Promise<void> {
    await db.plan.update({
      where: { id },
      data: { order_by },
    });
  }

  async getPlanSummary(): Promise<{ id: number; name: string }[]> {
    return await db.plan.findMany({
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
      },
    });
  }
}

/** Self-registration. */
export const planService = service<PlanService>(
  TOKENS.Plan,
  () =>
    new PlanService(
      instance.resolve<PlanCouponService>(TOKENS.Coupon),
      instance.resolve<RedisService>(TOKENS.Redis),
      instance.resolve<NotifyService>("NotifyService"),
      instance.resolve<SystemConfigService>(TOKENS.SystemConfig),
      instance.resolve<TopupService>(TOKENS.Topup),
    ),
);
