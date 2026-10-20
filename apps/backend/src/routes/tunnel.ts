import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { IpType, LoadBalanceType, Prisma, Status, SystemConfigName } from "@prisma/client";
import { formatDate } from "@relayx/shared/date";
import { db } from "../db";
import { logger } from "../logger";
import { describeRoute, resolver, zValidator } from "../openapi";
import { planRequired } from "../middlewares/plan";
import { nodeGroupService } from "../services/node_group";
import { planService } from "../services/plan";
import { redisService, type TunnelNodeStats } from "../services/redis";
import { systemConfigService } from "../services/system_config";
import { tunnelService } from "../services/tunnel";
import {
  BatchIdSchema,
  BatchTunnelRequestSchema,
  IdSchema,
  TunnelImportRequestSchema,
  TunnelQuerySchema,
  TunnelRequestSchema,
  TunnelStatsQuerySchema,
  TunnelTrafficQuerySchema,
  TunnelTrafficStatsQuerySchema,
  WhitelistUpdateSchema,
} from "../schemas/request";
import {
  TunnelResponseSchema,
  TunnelStatsResponseSchema,
  TunnelSummaryResponseSchema,
  TunnelTrafficResponseSchema,
  WhitelistResponseSchema,
} from "../schemas/response";
import { formatStatsDate, getDateGroupBy, getDateInterval, toLocalTZ, utcNowMinusDays } from "../utils/date";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/tunnel.ts (799 decompiled lines) — ported 1:1.
 *
 * DEVIATION (docs/DEVIATIONS.md): upstream uses `lodash.sum`; replaced with the local
 * `sum` helper. The raw aggregate SQL uses the frozen `utils/date.ts` fragments, which are
 * already the SQLite rewrite of upstream's MySQL `CONVERT_TZ`/`DATE_FORMAT` helpers.
 */
const router = new Hono<AppEnv>();

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + Number(value || 0), 0);
}

/** Prisma JSON column input: `undefined` leaves the value untouched, `null` stores JSON null. */
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

router.get(
  "/",
  describeRoute({
    summary: "获取所有隧道",
    tags: ["隧道"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(TunnelResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", TunnelQuerySchema),
  async (c) => {
    const user = c.get("user");
    const data = await tunnelService.getTunnels(c.req.valid("query"), user.id);
    return c.json(data);
  },
);

router.get(
  "/summary",
  describeRoute({
    summary: "获取隧道统计",
    tags: ["隧道"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(TunnelSummaryResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const data = await tunnelService.getTunnelSummary(user.id);
    return c.json(data);
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建新隧道",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道创建成功",
      },
    },
  }),
  zValidator("json", TunnelRequestSchema),
  planRequired,
  async (c) => {
    const user = c.get("user");
    const user_plan = c.get("plan")!;
    await tunnelService.createTunnel(
      user.id,
      c.req.valid("json"),
      user_plan.max_tunnels ?? user_plan.plan.max_tunnels,
    );
    return c.body(null, 204);
  },
);

router.post(
  "/import",
  describeRoute({
    summary: "导入隧道",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道导入成功",
      },
    },
  }),
  zValidator("json", TunnelImportRequestSchema),
  planRequired,
  async (c) => {
    const {
      in_node_group_id,
      out_node_group_id,
      tunnel_type,
      tunnels,
      random_port_is_exist,
      overwrite_tunnel_on_port_conflict,
    } = c.req.valid("json");
    const user = c.get("user");
    const user_plan = c.get("plan")!;
    await redisService.lockUserTunnel(user.id, async () => {
      for (const tunnel of tunnels) {
        let shouldCreate = true;
        if (tunnel.listen_port) {
          try {
            await tunnelService.checkTunnel(
              tunnel_type,
              in_node_group_id,
              out_node_group_id,
              tunnel.listen_port,
              null,
            );
          } catch (error) {
            if (error instanceof HTTPException && error.status === 409) {
              if (overwrite_tunnel_on_port_conflict) {
                const existingTunnel = await db.tunnel.findUnique({
                  where: {
                    listen_port_in_node_group_id: {
                      listen_port: tunnel.listen_port,
                      in_node_group_id,
                    },
                  },
                });
                if (existingTunnel && existingTunnel.user_id === user.id) {
                  await db.tunnel.update({
                    where: { id: existingTunnel.id },
                    data: {
                      name: tunnel.name,
                      forward_addresses: tunnel.dest.map((dest) => ({
                        address: dest,
                        weight: 1,
                      })),
                    },
                  });
                  shouldCreate = false;
                } else {
                  throw error;
                }
              } else if (random_port_is_exist) {
                tunnel.listen_port = null;
              } else {
                throw error;
              }
            } else {
              throw error;
            }
          }
        }
        if (shouldCreate) {
          await nodeGroupService.checkUserNodeGroup(user, in_node_group_id, out_node_group_id);
          const max_tunnels = user_plan.max_tunnels ?? user_plan.plan.max_tunnels;
          const existing_tunnels = await db.tunnel.count({
            where: {
              user_id: user.id,
            },
          });
          if (max_tunnels && existing_tunnels >= max_tunnels) {
            throw new HTTPException(409, { message: "已达到最大隧道数量，请升级套餐" });
          }
          await db.tunnel.create({
            data: {
              name: tunnel.name,
              listen_ip: null,
              listen_port: tunnel.listen_port,
              forward_addresses: tunnel.dest.map((dest) => ({
                address: dest,
                weight: 1,
              })),
              in_node_group_id,
              out_node_group_id,
              load_balance_type: LoadBalanceType.round,
              tunnel_type,
              ip_type: IpType.auto,
              user_id: user.id,
              order_by: (await db.tunnel.count()) * 1000,
            },
          });
        }
      }
    });
    return c.body(null, 204);
  },
);

router.get(
  "/whitelist",
  describeRoute({
    summary: "获取白名单 IP",
    tags: ["隧道"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(WhitelistResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const user_plan = await planService.getUserPlan(user);
    return c.json({
      whitelist_ips: user_plan?.whitelist_ips ?? [],
      whitelist_limit: user_plan ? user_plan.plan.whitelist_limit : 0,
    });
  },
);

router.patch(
  "/whitelist",
  describeRoute({
    summary: "更新白名单 IP",
    tags: ["隧道"],
    responses: {
      204: {
        description: "更新成功",
      },
    },
  }),
  zValidator("json", WhitelistUpdateSchema),
  planRequired,
  async (c) => {
    const user = c.get("user");
    const user_plan = c.get("plan")!;
    const { whitelist_ips } = c.req.valid("json");
    const limit = user_plan.plan.whitelist_limit;
    if (limit !== null && whitelist_ips.length > limit) {
      throw new HTTPException(400, { message: `白名单 IP 数量不能超过 ${limit} 个` });
    }
    await db.userPlan.update({
      where: { user_id: user.id },
      data: { whitelist_ips },
    });
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/status",
  describeRoute({
    summary: "更新隧道状态",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道状态更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", z.object({ status: z.nativeEnum(Status) })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const user = c.get("user");
    await db.tunnel.update({
      where: { id, user_id: user.id },
      data: { status },
    });
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "更新隧道排序",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道排序更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", z.object({ order_by: z.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { order_by } = c.req.valid("json");
    const user = c.get("user");
    await tunnelService.updateTunnelOrder(id, order_by, user.id);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新隧道",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", TunnelRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const {
      name,
      listen_ip,
      listen_port,
      forward_addresses,
      in_node_group_id,
      out_node_group_id,
      tunnel_type,
      ip_type,
      status,
      load_balance_type,
      ip_limit,
      client_limit,
      bandwidth_limit,
      category,
      tunnel_chains,
      listen_protocol,
      forward_addresses_protocol,
      proxy_protocol,
    } = c.req.valid("json");
    const user = c.get("user");
    await nodeGroupService.checkUserNodeGroup(user, in_node_group_id, out_node_group_id);
    await tunnelService.checkTunnel(
      tunnel_type,
      in_node_group_id,
      out_node_group_id,
      listen_port,
      id,
      listen_protocol,
    );
    const existing = await db.tunnel.findUnique({
      where: { id, user_id: user.id },
      select: { listen_protocol: true },
    });
    const prepared_listen_protocol = tunnelService.prepareListenProtocol(
      listen_protocol,
      existing?.listen_protocol,
    );
    try {
      await db.$transaction(async (tx) => {
        await tx.tunnel.update({
          where: { id, user_id: user.id },
          data: {
            name,
            listen_ip,
            listen_port,
            forward_addresses,
            in_node_group_id,
            out_node_group_id,
            tunnel_type,
            ip_type,
            status,
            load_balance_type,
            ip_limit,
            client_limit,
            bandwidth_limit,
            category,
            listen_protocol: toJsonInput(prepared_listen_protocol),
            forward_addresses_protocol: toJsonInput(forward_addresses_protocol),
            proxy_protocol: proxy_protocol ?? false,
          },
        });
        if (tunnel_chains) {
          await tx.tunnelChain.deleteMany({
            where: { tunnel_id: id },
          });
          await tx.tunnelChain.createMany({
            data: tunnel_chains.map((chain) => ({
              tunnel_id: id,
              node_group_id: chain.node_group_id,
              node_type: chain.node_type,
            })),
          });
        }
      });
    } catch (error) {
      logger.error(`update tunnel error: ${error}`);
      throw new HTTPException(409, { message: "端口已存在" });
    }
    return c.body(null, 204);
  },
);

router.patch(
  "/batch/update",
  describeRoute({
    summary: "批量更新隧道",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道更新成功",
      },
    },
  }),
  zValidator("json", BatchTunnelRequestSchema),
  async (c) => {
    const { ids, in_tunnel_chains, out_tunnel_chains, ...data } = c.req.valid("json");
    const user = c.get("user");
    const where = { id: { in: ids }, user_id: user.id };
    const filteredData: Record<string, unknown> = {};
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        filteredData[key] = value;
      }
    });
    await db.$transaction(async (tx) => {
      if (Object.keys(filteredData).length > 0) {
        await tx.tunnel.updateMany({
          where,
          data: filteredData,
        });
      }
      if (in_tunnel_chains !== undefined) {
        for (const id of ids) {
          await tx.tunnelChain.deleteMany({
            where: { tunnel_id: id, node_type: "in" },
          });
          if (in_tunnel_chains !== null && in_tunnel_chains.length > 0) {
            await tx.tunnelChain.createMany({
              data: in_tunnel_chains.map((node_group_id) => ({
                tunnel_id: id,
                node_group_id,
                node_type: "in",
              })),
            });
          }
        }
      }
      if (out_tunnel_chains !== undefined) {
        for (const id of ids) {
          await tx.tunnelChain.deleteMany({
            where: { tunnel_id: id, node_type: "out" },
          });
          if (out_tunnel_chains !== null && out_tunnel_chains.length > 0) {
            await tx.tunnelChain.createMany({
              data: out_tunnel_chains.map((node_group_id) => ({
                tunnel_id: id,
                node_group_id,
                node_type: "out",
              })),
            });
          }
        }
      }
    });
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除隧道",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    const user = c.get("user");
    const where = {
      id: { in: ids },
      user_id: user.id,
    };
    await db.$transaction(async (tx) => {
      await tx.tunnelTraffic.deleteMany({
        where: {
          tunnel_id: { in: ids },
          tunnel: {
            user_id: user.id,
          },
        },
      });
      await tx.tunnelChain.deleteMany({
        where: {
          tunnel_id: { in: ids },
        },
      });
      await tx.tunnel.deleteMany({
        where,
      });
      await redisService.clearTunnelTraffic(ids);
    });
    return c.body(null, 204);
  },
);

router.post(
  "/observer",
  describeRoute({
    summary: "代理报告状态",
    tags: ["隧道"],
    hide: true,
    responses: {
      200: {
        description: "状态报告成功",
        content: {
          "application/json": {
            schema: resolver(z.object({ ok: z.boolean() })),
          },
        },
      },
    },
  }),
  zValidator("query", z.object({ node_id: z.string().optional() })),
  zValidator(
    "json",
    z.object({
      events: z.array(
        z.object({
          kind: z.string(),
          service: z.string(),
          type: z.string(),
          status: z
            .object({
              state: z.string(),
              msg: z.string(),
            })
            .optional(),
          stats: z
            .object({
              totalConns: z.number(),
              currentConns: z.number(),
              currentClients: z.array(z.string()).nullish(),
              inputBytes: z.number(),
              outputBytes: z.number(),
              totalErrs: z.number(),
            })
            .optional(),
        }),
      ),
    }),
  ),
  async (c) => {
    const { node_id } = c.req.valid("query");
    const { events } = c.req.valid("json");
    const observerPeriod = await systemConfigService.getConfig<number>(SystemConfigName.OBSERVER_PERIOD);
    const statsTtl = (observerPeriod ?? 0) * 3;
    const traffics: { tunnel_id: number; traffic: number; traffic_cost: number }[] = [];
    const nodeStatsEntries: { tunnel_id: number; stats: TunnelNodeStats }[] = [];
    for (const event of events) {
      const { kind, service, type, stats } = event;
      if (kind === "service" && type === "stats" && stats) {
        const id_str = service
          .replace("tcp-", "")
          .replace("udp-", "")
          .replace("rtcp-", "")
          .replace("rudp-", "")
          .replace("wg-", "")
          .replace("mieru-", "");
        const id = Number(id_str);
        if (isNaN(id)) {
          continue;
        }
        const tunnel = await db.tunnel.findUnique({
          where: { id },
          include: {
            in_node_group: {
              select: { traffic_rate: true },
            },
            tunnel_chains: {
              include: {
                node_group: {
                  select: { traffic_rate: true },
                },
              },
            },
            out_node_group: {
              select: { traffic_rate: true },
            },
          },
        });
        if (!tunnel) {
          continue;
        }
        nodeStatsEntries.push({ tunnel_id: id, stats: stats as TunnelNodeStats });
        const traffic = (stats.inputBytes + stats.outputBytes) / 1024 / 1024 / 1024;
        const in_traffic_cost = traffic * tunnel.in_node_group.traffic_rate;
        const out_traffic_cost = traffic * (tunnel.out_node_group?.traffic_rate ?? 0);
        let chain_traffic_cost = 0;
        for (const chain of tunnel.tunnel_chains) {
          chain_traffic_cost += traffic * chain.node_group.traffic_rate;
        }
        const traffic_cost = in_traffic_cost + out_traffic_cost + chain_traffic_cost;
        if (traffic > 0) {
          if (traffic_cost > 0) {
            await db.userPlan.update({
              where: { user_id: tunnel.user_id },
              data: { traffic_used: { increment: traffic_cost } },
            });
          }
          await db.tunnel.update({
            where: { id: tunnel.id },
            data: {
              traffic: { increment: traffic },
              traffic_cost: { increment: traffic_cost },
            },
          });
          traffics.push({ tunnel_id: tunnel.id, traffic, traffic_cost });
        }
      }
    }
    if (traffics.length > 0) {
      await redisService.incrTunnelTraffics(traffics);
    }
    if (node_id && nodeStatsEntries.length > 0) {
      await redisService.setTunnelNodeStatsBatch(Number(node_id), nodeStatsEntries, statsTtl);
    }
    return c.json({ ok: true });
  },
);

router.get(
  "/traffic/stats",
  describeRoute({
    summary: "获取隧道流量统计",
    tags: ["隧道"],
    responses: {
      200: {
        description: "隧道流量统计获取成功",
        content: {
          "application/json": {
            schema: resolver(TunnelTrafficResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", TunnelTrafficStatsQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { start_date, end_date, in_node_group_id, out_node_group_id, aggregate_by } = c.req.valid("query");
    const whereConditions = [`tunnel.user_id = ${user.id}`];
    const localTrafficDate = toLocalTZ("tunnel_traffic.date");
    if (start_date) {
      whereConditions.push(`${localTrafficDate} >= '${formatDate(start_date)}'`);
    } else {
      const interval = getDateInterval(aggregate_by);
      whereConditions.push(`${localTrafficDate} > ${utcNowMinusDays(interval)}`);
    }
    if (end_date) {
      whereConditions.push(`${localTrafficDate} <= '${formatDate(end_date)}'`);
    }
    if (in_node_group_id) {
      whereConditions.push(`tunnel.in_node_group_id = ${in_node_group_id}`);
    }
    if (out_node_group_id) {
      whereConditions.push(`tunnel.out_node_group_id = ${out_node_group_id}`);
    }
    const dateGroupBy = getDateGroupBy("tunnel_traffic.date", aggregate_by);
    const query = `
        SELECT
          ${dateGroupBy} AS date,
          SUM(tunnel_traffic.traffic) AS traffic,
          SUM(tunnel_traffic.traffic_cost) AS traffic_cost
        FROM tunnel_traffic
        JOIN tunnel ON tunnel_traffic.tunnel_id = tunnel.id
        WHERE ${whereConditions.join(" AND ")}
        GROUP BY ${dateGroupBy}
        ORDER BY ${dateGroupBy}
      `;
    const ret = await db.$queryRawUnsafe<{ date: unknown; traffic: number; traffic_cost: number }[]>(query);
    const tunnels: { date: string; traffic: number; traffic_cost: number }[] = ret.map((item) => ({
      date: formatStatsDate(item.date, aggregate_by),
      traffic: item.traffic,
      traffic_cost: item.traffic_cost,
    }));
    const shouldIncludeToday = !end_date || end_date >= new Date();
    const isToday = !start_date || start_date <= new Date();
    if (shouldIncludeToday && isToday && aggregate_by === "day") {
      const tunnelWhere: {
        user_id: number;
        in_node_group_id?: number;
        out_node_group_id?: number;
      } = { user_id: user.id };
      if (in_node_group_id) {
        tunnelWhere.in_node_group_id = in_node_group_id;
      }
      if (out_node_group_id) {
        tunnelWhere.out_node_group_id = out_node_group_id;
      }
      const userTunnels = await db.tunnel.findMany({
        where: tunnelWhere,
        select: { id: true },
      });
      const ids = userTunnels.map((tunnel) => tunnel.id);
      if (ids.length > 0) {
        const todayTraffic = await redisService.getTunnelTraffic(false, ids);
        const todayTrafficCost = await redisService.getTunnelTraffic(true, ids);
        tunnels.push({
          date: formatDate(new Date()),
          traffic: sum(Object.values(todayTraffic).map(Number)),
          traffic_cost: sum(Object.values(todayTrafficCost).map(Number)),
        });
      }
    }
    return c.json(tunnels);
  },
);

router.get(
  "/:id/test",
  describeRoute({
    summary: "测试隧道",
    tags: ["隧道"],
    responses: {
      200: {
        description: "隧道测试成功",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                in_node_group: z.array(
                  z.object({
                    node_id: z.string(),
                    results: z.record(z.string(), z.number()),
                  }),
                ),
                out_node_group: z.array(
                  z.object({
                    node_id: z.string(),
                    results: z.record(z.string(), z.number()),
                  }),
                ),
              }),
            ),
          },
        },
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const ip = c.get("ip");
    const results = await tunnelService.testTunnel(id, ip, user.id);
    return c.json(results);
  },
);

router.delete(
  "/traffic",
  describeRoute({
    summary: "清空隧道流量",
    tags: ["隧道"],
    responses: {
      204: {
        description: "隧道流量清空成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    const user = c.get("user");
    await db.tunnelTraffic.deleteMany({
      where: {
        tunnel_id: { in: ids },
        tunnel: {
          user_id: user.id,
        },
      },
    });
    await db.tunnel.updateMany({
      where: {
        id: { in: ids },
        user_id: user.id,
      },
      data: {
        traffic: 0,
        traffic_cost: 0,
      },
    });
    await redisService.clearTunnelTraffic(ids);
    return c.body(null, 204);
  },
);

router.get(
  "/traffic",
  describeRoute({
    summary: "获取隧道流量列表",
    tags: ["隧道"],
    responses: {
      200: {
        description: "隧道流量获取成功",
        content: {
          "application/json": {
            schema: resolver(TunnelTrafficResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", TunnelTrafficQuerySchema),
  async (c) => {
    const user = c.get("user");
    const data = await tunnelService.getTunnelTraffics(user.id, c.req.valid("query"));
    return c.json(data);
  },
);

router.get(
  "/stats",
  describeRoute({
    summary: "获取隧道状态列表",
    tags: ["隧道"],
    responses: {
      200: {
        description: "隧道状态获取成功",
        content: {
          "application/json": {
            schema: resolver(TunnelStatsResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", TunnelStatsQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { page, perPage, sort, name, in_node_group_id, out_node_group_id } = c.req.valid("query");
    const where = {
      user_id: user.id,
      name: name ? { contains: name } : undefined,
      in_node_group_id: in_node_group_id ? { in: in_node_group_id } : undefined,
      out_node_group_id: out_node_group_id ? { in: out_node_group_id } : undefined,
    };
    const orderBy = sort?.map((sortItem: { id: string; desc: boolean }) => {
      return {
        [sortItem.id]: sortItem.desc ? "desc" : "asc",
      };
    }) as Record<string, "asc" | "desc">[] | undefined;
    const [data, total] = await db.$transaction([
      db.tunnel.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ order_by: "desc" }, { id: "desc" }],
        where,
        select: {
          id: true,
          name: true,
          client_limit: true,
          in_node_group: {
            select: {
              id: true,
              name: true,
            },
          },
          out_node_group: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      db.tunnel.count({ where }),
    ]);
    const allStats = await redisService.getAllTunnelNodeStats();
    return c.json({
      data: data.map((tunnel) => ({
        id: tunnel.id,
        name: tunnel.name,
        client_limit: tunnel.client_limit,
        in_node_group: tunnel.in_node_group,
        out_node_group: tunnel.out_node_group,
        stats: allStats.get(tunnel.id) ?? null,
      })),
      total,
    });
  },
);

router.get(
  "/subscription",
  describeRoute({
    summary: "获取订阅地址",
    description: "获取通用 / Clash 格式的订阅内容",
    tags: ["隧道"],
    responses: {
      200: {
        description: "订阅内容",
        content: {
          "text/plain": {
            schema: resolver(z.string()),
          },
        },
      },
    },
  }),
  zValidator("query", z.object({ token: z.string() })),
  async (c) => {
    const enabled = await systemConfigService.getConfig<boolean>(SystemConfigName.ENABLE_SUBSCRIPTION);
    if (!enabled) {
      throw new HTTPException(404, { message: "订阅功能未开启" });
    }
    const { token } = c.req.valid("query");
    const user = await db.user.findUnique({
      where: { subscription_key: token, status: Status.active },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    const userPlan = await db.userPlan.findUnique({
      where: { user_id: user.id },
      include: { plan: { select: { traffic: true } } },
    });
    const totalGB = userPlan?.traffic ?? userPlan?.plan.traffic ?? 0;
    const usedGB = userPlan?.traffic_used ?? 0;
    const GB = 1024 ** 3;
    const downloadBytes = Math.round(usedGB * GB);
    const totalBytes = Math.round(totalGB * GB);
    const expireSeconds = userPlan?.expired_at ? Math.floor(userPlan.expired_at.getTime() / 1000) : 0;
    c.header(
      "Subscription-Userinfo",
      `upload=0; download=${downloadBytes}; total=${totalBytes}; expire=${expireSeconds}`,
    );
    const userAgent = c.req.header("User-Agent")?.toLowerCase() ?? "";
    if (userAgent.includes("clash") || userAgent.includes("stash")) {
      const subscription = await tunnelService.generateClashSubscription(user.id);
      return c.text(subscription);
    }
    const wgFormat = userAgent.includes("shadowrocket") ? "shadowrocket" : "v2rayn";
    const subscription = await tunnelService.generateSubscription(user.id, wgFormat);
    return c.text(Buffer.from(subscription).toString("base64"));
  },
);

export default router;
