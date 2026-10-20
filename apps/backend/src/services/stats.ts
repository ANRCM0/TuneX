import { formatDate, formatDateTime } from "@relayx/shared/date";
import { db } from "../db";
import { service, TOKENS } from "../container";
import { formatStatsDate, getDateGroupBy, getDateInterval, toLocalTZ } from "../utils/date";
import { redisService, type RedisService } from "./redis";

/**
 * Replica-side home for the aggregation SQL of `src/routes/admin/stats.ts` (upstream
 * module 083). Upstream keeps the three queries inline in the router; the replica's
 * convention is one self-registering service per concern, and the frozen container already
 * reserves `TOKENS.Stats` for it. The SQL, the China-time fragments (`toLocalTZ` /
 * `getDateGroupBy`) and the response shapes are unchanged.
 *
 * DEVIATION (for docs/DEVIATIONS.md): upstream interpolates the range bounds into the SQL
 * string (MySQL `'2026-10-17'` / `NOW() - INTERVAL n DAY`). The replica binds them as
 * parameters formatted in Asia/Shanghai by `@relayx/shared/date`. That keeps the query
 * engine-neutral, and it stays correct on both targets because `utils/date.ts` renders the
 * column as text in exactly the same `YYYY-MM-DD HH:MM:SS` shape on SQLite and MySQL, so the
 * comparison is text-to-text either way.
 */

export type AggregateBy = "day" | "month" | "year";

export interface StatsQuery {
  start_date?: Date;
  end_date?: Date;
  aggregate_by?: AggregateBy;
}

export interface TrafficStatsQuery extends StatsQuery {
  in_node_group_id?: number;
  out_node_group_id?: number;
}

export interface StatsOverview {
  user: { status: string; count: number }[];
  node_group: { node_type: string; count: number }[];
  tunnel: { status: string; count: number }[];
  topup_order: { status: string; count: number }[];
  node: { status: string; count: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class StatsService {
  private redisService: RedisService;

  constructor(redisService: RedisService) {
    this.redisService = redisService;
  }

  /**
   * Lower/upper bounds of the aggregation window, as local wall-clock strings comparable
   * with `toLocalTZ` on either dialect. An explicit bound keeps upstream's
   * date-granularity semantics; the implicit lower bound is `NOW() - INTERVAL n DAY`.
   */
  private rangeConditions(
    column: string,
    start_date: Date | undefined,
    end_date: Date | undefined,
    aggregate_by: AggregateBy | undefined,
  ): { conditions: string[]; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (start_date) {
      conditions.push(`${column} >= ?`);
      params.push(formatDate(start_date));
    } else {
      conditions.push(`${column} >= ?`);
      params.push(formatDateTime(new Date(Date.now() - getDateInterval(aggregate_by) * DAY_MS)));
    }
    if (end_date) {
      conditions.push(`${column} <= ?`);
      params.push(formatDate(end_date));
    }
    return { conditions, params };
  }

  /** `GET /admin/stats` — current entity counts grouped by status / node type. */
  async getOverview(): Promise<StatsOverview> {
    return db.$transaction(async (tx) => {
      const users = await tx.user.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const userStats = users.map((user) => ({
        status: user.status,
        count: user._count._all,
      }));
      const nodeGroups = await tx.nodeGroup.groupBy({
        by: ["node_type"],
        _count: { _all: true },
      });
      const nodeGroupStats = nodeGroups.map((nodeGroup) => ({
        node_type: nodeGroup.node_type,
        count: nodeGroup._count._all,
      }));
      const nodes = await tx.node.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const nodeStats = nodes.map((node) => ({
        status: node.status,
        count: node._count._all,
      }));
      const tunnels = await tx.tunnel.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const tunnelStats = tunnels.map((tunnel) => ({
        status: tunnel.status,
        count: tunnel._count._all,
      }));
      const topupOrders = await tx.topupOrder.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const topupOrderStats = topupOrders.map((topupOrder) => ({
        status: topupOrder.status,
        count: topupOrder._count._all,
      }));
      return {
        user: userStats,
        node_group: nodeGroupStats,
        tunnel: tunnelStats,
        topup_order: topupOrderStats,
        node: nodeStats,
      };
    });
  }

  /** `GET /admin/stats/user` — new-user counts bucketed by day/month/year. */
  async getUserStats(query: StatsQuery): Promise<{ date: string; total: number }[]> {
    const { start_date, end_date, aggregate_by } = query;
    const { conditions, params } = this.rangeConditions(
      toLocalTZ("created_at"),
      start_date,
      end_date,
      aggregate_by,
    );
    const dateGroupBy = getDateGroupBy("created_at", aggregate_by);
    const sql = `
        SELECT ${dateGroupBy} as date, COUNT(*) as total
        FROM user
        WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "1=1"}
        GROUP BY ${dateGroupBy}
        ORDER BY ${dateGroupBy}
      `;
    const stats = await db.$queryRawUnsafe<{ date: unknown; total: unknown }[]>(sql, ...params);
    return stats.map((item) => ({
      date: formatStatsDate(item.date, aggregate_by),
      total: Number(item.total),
    }));
  }

  /** `GET /admin/stats/traffic` — traffic/cost buckets plus today's live Redis traffic. */
  async getTrafficStats(
    query: TrafficStatsQuery,
  ): Promise<{ date: string; traffic: number; traffic_cost: number }[]> {
    const { start_date, end_date, aggregate_by, in_node_group_id, out_node_group_id } = query;
    const { conditions, params } = this.rangeConditions(
      toLocalTZ("tunnel_traffic.date"),
      start_date,
      end_date,
      aggregate_by,
    );
    if (in_node_group_id) {
      conditions.push("tunnel.in_node_group_id = ?");
      params.push(String(in_node_group_id));
    }
    if (out_node_group_id) {
      conditions.push("tunnel.out_node_group_id = ?");
      params.push(String(out_node_group_id));
    }
    const dateGroupBy = getDateGroupBy("tunnel_traffic.date", aggregate_by);
    const sql = `
        SELECT
          ${dateGroupBy} AS date,
          SUM(tunnel_traffic.traffic) AS traffic,
          SUM(tunnel_traffic.traffic_cost) AS traffic_cost
        FROM tunnel_traffic
        JOIN tunnel ON tunnel_traffic.tunnel_id = tunnel.id
        WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "1=1"}
        GROUP BY ${dateGroupBy}
        ORDER BY ${dateGroupBy}
      `;
    const stats = await db.$queryRawUnsafe<{ date: unknown; traffic: unknown; traffic_cost: unknown }[]>(
      sql,
      ...params,
    );
    const result = stats.map((item) => ({
      date: formatStatsDate(item.date, aggregate_by),
      traffic: Number(item.traffic),
      traffic_cost: Number(item.traffic_cost),
    }));

    const now = new Date();
    const shouldIncludeToday = !end_date || new Date(end_date) >= now;
    const isToday = !start_date || new Date(start_date) <= now;
    if (shouldIncludeToday && isToday && (!aggregate_by || aggregate_by === "day")) {
      let tunnelIds: number[] | undefined;
      if (in_node_group_id || out_node_group_id) {
        const tunnels = await db.tunnel.findMany({
          where: { in_node_group_id, out_node_group_id },
          select: { id: true },
        });
        tunnelIds = tunnels.map((t) => t.id);
        if (tunnelIds.length === 0) {
          return result;
        }
      }
      const todayTraffic = await this.redisService.getTunnelTraffic(false, tunnelIds);
      const todayTrafficCost = await this.redisService.getTunnelTraffic(true, tunnelIds);
      const sum = (values: Record<string, string>) =>
        Object.values(values).reduce((acc, value) => acc + Number(value), 0);
      const traffic = sum(todayTraffic);
      const traffic_cost = sum(todayTrafficCost);
      if (traffic || traffic_cost) {
        result.push({ date: formatDate(now), traffic, traffic_cost });
      }
    }
    return result;
  }
}

/** Self-registration. */
export const statsService = service<StatsService>(TOKENS.Stats, () => new StatsService(redisService));
