import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { NodeSchema } from "../../generated/zod";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { nodeService } from "../../services/node";
import { BatchIdSchema, IdSchema, NodeQuerySchema } from "../../schemas/request";
import { NodeResponseSchema } from "../../schemas/response";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/node.ts (76 decompiled lines) — ported 1:1.
 * Mounted at `/admin/nodes` by the frozen `src/app.ts`.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取所有节点",
    tags: ["管理员节点"],
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
    const { data, total } = await nodeService.getNodes(c.req.valid("query"));
    return c.json({
      data,
      total,
    });
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除节点",
    tags: ["管理员节点"],
    responses: {
      204: {
        description: "节点删除成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await nodeService.deleteNodes(ids);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新节点",
    tags: ["管理员节点"],
    responses: {
      204: {
        description: "节点更新成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", NodeSchema.pick({ weight: true, status: true, backup: true })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { weight, status, backup } = c.req.valid("json");
    await db.node.update({
      where: { id },
      data: { weight, status, backup },
    });
    return c.body(null, 204);
  },
);

router.post(
  "/upgrade",
  describeRoute({
    summary: "升级所有节点",
    tags: ["管理员节点"],
    responses: {
      204: {
        description: "升级成功",
      },
    },
  }),
  async (c) => {
    await nodeService.upgradeAllNodes();
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "通过 ID 更新节点顺序",
    tags: ["管理员节点"],
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
    await nodeService.updateNodeOrder(id, order_by);
    return c.body(null, 204);
  },
);

export default router;
