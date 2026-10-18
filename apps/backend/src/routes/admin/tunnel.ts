import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Prisma, Status } from "@prisma/client";
import { db } from "../../db";
import { logger } from "../../logger";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { redisService } from "../../services/redis";
import { tunnelService } from "../../services/tunnel";
import {
  AdminTunnelRequestSchema,
  BatchIdSchema,
  BatchTunnelRequestSchema,
  IdSchema,
  TunnelQuerySchema,
  TunnelRequestSchema,
  TunnelStatsQuerySchema,
} from "../../schemas/request";
import {
  AdminTunnelStatsResponseSchema,
  TunnelResponseSchema,
} from "../../schemas/response";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/tunnel.ts (380 decompiled lines) — ported 1:1.
 *
 * Mounted by the frozen src/app.ts at /admin/tunnel (behind the admin guard).
 */

const router = new Hono<AppEnv>();

/** Prisma JSON column input: `undefined` leaves the value untouched, `null` stores JSON null. */
function toJsonInput(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

router.get(
  "/",
  describeRoute({
    summary: "获取所有隧道",
    tags: ["管理员隧道"],
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
  zValidator("query", TunnelQuerySchema.extend({ email: z.string().optional() })),
  async (c) => {
    const { email } = c.req.valid("query");
    let user_id: number | undefined;
    if (email) {
      const user = await db.user.findFirst({
        where: {
          email: {
            contains: email,
          },
        },
        select: { id: true },
      });
      if (user) {
        user_id = user.id;
      } else {
        return c.json({ data: [], total: 0 }, 200);
      }
    }
    const data = await tunnelService.getTunnels(c.req.valid("query"), user_id);
    return c.json(data);
  },
);

router.post(
  "/",
  describeRoute({
    summary: "管理员创建用户隧道",
    tags: ["管理员隧道"],
    responses: {
      204: {
        description: "隧道创建成功",
      },
    },
  }),
  zValidator("json", AdminTunnelRequestSchema),
  async (c) => {
    const { user_id, ...data } = c.req.valid("json");
    const user = await db.user.findUnique({
      where: { id: user_id },
      include: {
        user_plan: {
          include: {
            plan: true,
          },
        },
      },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    const user_plan = user.user_plan;
    if (!user_plan) {
      throw new HTTPException(404, { message: "用户没有有效的套餐" });
    }
    await tunnelService.createTunnel(
      user_id,
      data,
      user_plan.max_tunnels ?? user_plan.plan.max_tunnels,
    );
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/status",
  describeRoute({
    summary: "更新隧道状态",
    tags: ["管理员隧道"],
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
    await db.tunnel.update({
      where: { id },
      data: { status },
    });
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新隧道",
    tags: ["管理员隧道"],
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
    await tunnelService.checkTunnel(
      tunnel_type,
      in_node_group_id,
      out_node_group_id,
      listen_port,
      id,
      listen_protocol,
    );
    const existing = await db.tunnel.findUnique({
      where: { id },
      select: { listen_protocol: true },
    });
    const prepared_listen_protocol = tunnelService.prepareListenProtocol(
      listen_protocol,
      existing?.listen_protocol,
    );
    try {
      await db.$transaction(async (tx) => {
        await tx.tunnel.update({
          where: { id },
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
    tags: ["管理员隧道"],
    responses: {
      204: {
        description: "隧道更新成功",
      },
    },
  }),
  zValidator("json", BatchTunnelRequestSchema),
  async (c) => {
    const { ids, in_tunnel_chains, out_tunnel_chains, ...data } = c.req.valid("json");
    const where = { id: { in: ids } };
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
    tags: ["管理员隧道"],
    responses: {
      204: {
        description: "隧道删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    const where = { id: { in: ids } };
    await db.$transaction(async (tx) => {
      await tx.tunnelTraffic.deleteMany({
        where: {
          tunnel_id: { in: ids },
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

router.get(
  "/:id/test",
  describeRoute({
    summary: "测试隧道",
    tags: ["管理员隧道"],
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
    const ip = c.get("ip");
    const results = await tunnelService.testTunnel(id, ip);
    return c.json(results);
  },
);

router.delete(
  "/traffic",
  describeRoute({
    summary: "清空隧道流量",
    tags: ["管理员隧道"],
    responses: {
      204: {
        description: "隧道流量清空成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await db.tunnelTraffic.deleteMany({
      where: {
        tunnel_id: { in: ids },
      },
    });
    await db.tunnel.updateMany({
      where: {
        id: { in: ids },
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
  "/stats",
  describeRoute({
    summary: "获取所有隧道状态",
    tags: ["管理员隧道"],
    responses: {
      200: {
        description: "隧道状态获取成功",
        content: {
          "application/json": {
            schema: resolver(AdminTunnelStatsResponseSchema),
          },
        },
      },
    },
  }),
  zValidator(
    "query",
    TunnelStatsQuerySchema.extend({
      email: z.string().nullish(),
    }),
  ),
  async (c) => {
    const { page, perPage, sort, name, in_node_group_id, out_node_group_id, email } =
      c.req.valid("query");
    let user_id: number | undefined;
    if (email) {
      const user = await db.user.findFirst({
        where: { email: { contains: email } },
        select: { id: true },
      });
      if (user) {
        user_id = user.id;
      } else {
        return c.json({ data: [], total: 0 });
      }
    }
    const where = {
      user_id,
      name: name ? { contains: name } : undefined,
      in_node_group_id: in_node_group_id ? { in: in_node_group_id } : undefined,
      out_node_group_id: out_node_group_id ? { in: out_node_group_id } : undefined,
    };
    const orderBy = sort?.map((sortItem: { id: string; desc: boolean }) => ({
      [sortItem.id]: sortItem.desc ? "desc" : "asc",
    })) as Record<string, "asc" | "desc">[] | undefined;
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
          user: {
            select: { email: true },
          },
          in_node_group: {
            select: { id: true, name: true },
          },
          out_node_group: {
            select: { id: true, name: true },
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
        user: tunnel.user,
        in_node_group: tunnel.in_node_group,
        out_node_group: tunnel.out_node_group,
        stats: allStats.get(tunnel.id) ?? null,
      })),
      total,
    });
  },
);

export default router;
