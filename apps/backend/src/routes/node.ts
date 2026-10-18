import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { SystemConfigName } from "@prisma/client";
import { db } from "../db";
import { NodeSchema } from "../generated/zod";
import { describeRoute, resolver, zValidator } from "../openapi";
import { redisService } from "../services/redis";
import { nodeService } from "../services/node";
import { nodeGroupService } from "../services/node_group";
import { systemConfigService } from "../services/system_config";
import { BatchIdSchema, IdSchema, NodeQuerySchema } from "../schemas/request";
import { NodeResponseSchema } from "../schemas/response";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/node.ts (172 decompiled lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取用户节点",
    tags: ["用户节点"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(NodeResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", NodeQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { data, total } = await nodeService.getNodes(c.req.valid("query"), user.id);
    return c.json({
      data,
      total,
    });
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除用户节点",
    tags: ["用户节点"],
    responses: {
      204: {
        description: "节点删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const user = c.get("user");
    const { ids } = c.req.valid("query");
    await nodeService.deleteNodes(ids, user.id);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新用户节点",
    tags: ["用户节点"],
    responses: {
      204: {
        description: "节点更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", NodeSchema.pick({ weight: true, status: true, backup: true })),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { weight, status, backup } = c.req.valid("json");
    try {
      const updated = await db.node.update({
        where: {
          id,
          node_group: {
            user_id: user.id,
          },
        },
        data: { weight, status, backup },
        select: { node_id: true },
      });
      await redisService.delNodeInfo(updated.node_id);
    } catch {
      throw new HTTPException(404, { message: "节点不存在" });
    }
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "更新用户节点排序",
    tags: ["用户节点"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", z.object({ order_by: z.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { order_by } = c.req.valid("json");
    const user = c.get("user");
    await nodeService.updateNodeOrder(id, order_by, user.id);
    return c.body(null, 204);
  },
);

router.post(
  "/upgrade",
  describeRoute({
    summary: "升级所有节点",
    tags: ["用户节点"],
    responses: {
      204: {
        description: "升级成功",
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    await nodeService.upgradeAllNodes(user.id);
    return c.body(null, 204);
  },
);

router.post(
  "/check",
  describeRoute({
    summary: "检查节点 ID 是否唯一",
    tags: ["用户节点"],
    responses: {
      204: {
        description: "成功",
      },
      400: {
        description: "节点 ID 已存在",
      },
    },
  }),
  zValidator("json", z.object({ node_id: z.string() })),
  async (c) => {
    const { node_id } = c.req.valid("json");
    await nodeService.checkNodeId(node_id);
    return c.body(null, 204);
  },
);

router.get(
  "/sysinfo",
  describeRoute({
    summary: "获取用户节点系统信息",
    tags: ["用户节点"],
  }),
  async (c) => {
    const user = c.get("user");
    const hideNodeStatus = await systemConfigService.getConfig(
      SystemConfigName.HIDE_NODE_STATUS,
    );
    let groups = await nodeGroupService.getUserNodeGroups(user);
    if (hideNodeStatus) {
      groups = groups.filter((group) => group.user_id === user.id);
    }
    const sysinfos = await redisService.getSysinfo();
    const groupIds = groups.map((g) => g.id);
    const [nodes, latestVersion] = await Promise.all([
      db.node.findMany({
        where: { node_group_id: { in: groupIds } },
        select: {
          id: true,
          status: true,
          connect_ip: true,
          weight: true,
          backup: true,
          version: true,
        },
      }),
      redisService.getLatestAgentVersion(),
    ]);
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const orphanNodes: { node_group_id: number; node_id: number }[] = [];
    const data = groups.map((group) => {
      const isOwn = group.user_id === user.id;
      const sysinfo = sysinfos[group.id]
        ?.filter((item) => {
          if (!nodeMap.has(item.db_id)) {
            orphanNodes.push({ node_group_id: group.id, node_id: item.db_id });
            return false;
          }
          return true;
        })
        .map((item) => {
          const node = nodeMap.get(item.db_id)!;
          return {
            ...item,
            status: node.status,
            connect_ip: isOwn ? node.connect_ip : "",
            weight: node.weight,
            backup: node.backup,
            upgradeable: latestVersion ? (node.version ?? "") !== latestVersion : false,
          };
        });
      return {
        ...group,
        is_own: isOwn,
        sysinfo,
      };
    });
    if (orphanNodes.length > 0) {
      Promise.all(
        orphanNodes.map((n) => redisService.delNodeSysinfo(n.node_group_id, n.node_id)),
      ).catch(() => {});
    }
    return c.json(data);
  },
);

export default router;
