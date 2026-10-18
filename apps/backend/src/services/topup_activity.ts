import { TopupActivity, TopupActivityType } from "@prisma/client";
import { db } from "../db";
import { service } from "../container";

export interface TopupActivityQuery {
  page: number;
  perPage: number;
  sort?: { id: string; desc?: boolean }[] | null;
  type?: TopupActivityType;
}

/**
 * Upstream: src/services/topup_activity.ts (85 lines) — ported 1:1.
 */
export class TopupActivityService {
  async getTopupActivities(query: TopupActivityQuery): Promise<{ data: TopupActivity[]; total: number }> {
    const { page, perPage, sort, type } = query;
    const orderBy = sort?.map((sort2) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    });
    const where = {
      type,
    };
    const [data, total] = await db.$transaction([
      db.topupActivity.findMany({
        where,
        orderBy: (orderBy as never) || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      db.topupActivity.count({
        where,
      }),
    ]);
    return { data, total };
  }

  async getActiveTopupActivities(): Promise<TopupActivity[]> {
    const now = new Date();
    return await db.topupActivity.findMany({
      where: {
        AND: [
          {
            OR: [{ valid_start: null }, { valid_start: { lte: now } }],
          },
          {
            OR: [{ valid_end: null }, { valid_end: { gte: now } }],
          },
        ],
      },
      orderBy: {
        id: "desc",
      },
    });
  }

  async calculateBonus(price: number): Promise<number> {
    const now = new Date();
    const activities = await db.topupActivity.findMany({
      where: {
        AND: [
          {
            OR: [{ valid_start: null }, { valid_start: { lte: now } }],
          },
          {
            OR: [{ valid_end: null }, { valid_end: { gte: now } }],
          },
          {
            OR: [{ min_amount: null }, { min_amount: { lte: price } }],
          },
          {
            OR: [{ max_amount: null }, { max_amount: { gte: price } }],
          },
        ],
      },
    });
    if (activities.length === 0) {
      return 0;
    }
    let totalBonus = 0;
    for (const activity of activities) {
      if (activity.type === TopupActivityType.percentage) {
        totalBonus += price * (activity.value / 100);
      } else if (activity.type === TopupActivityType.fixed) {
        totalBonus += activity.value;
      }
    }
    return totalBonus;
  }
}

/** Self-registration. */
export const topupActivityService = service<TopupActivityService>(
  "TopupActivityService",
  () => new TopupActivityService(),
);
