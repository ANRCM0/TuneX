import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../../db";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { nodeGroupService } from "../../services/node_group";
import {
  BatchIdSchema,
  IdSchema,
  NodeGroupQuerySchema,
  NodeGroupRequestSchema,
} from "../../schemas/request";
import { NodeGroupResponseSchema, NodeGroupSummaryResponseSchema } from "../../schemas/response";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/node_group.ts (116 decompiled lines) — ported 1:1.
 * Mounted at `/admin/node-groups` by the frozen `src/app.ts`.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取所有节点组",
    tags: ["管理员节点组"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(NodeGroupResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("query", NodeGroupQuerySchema),
  async (c) => {
    const { data, total } = await nodeGroupService.getNodeGroups(c.req.valid("query"));
    return c.json({
      data,
      total,
    });
  },
);

router.get(
  "/summary",
  describeRoute({
    summary: "获取节点组摘要",
    tags: ["管理员节点组"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(z.array(NodeGroupSummaryResponseSchema)),
          },
        },
      },
    },
  }),
  async (c) => {
    const data = await nodeGroupService.getAdminNodeGroupSummary();
    return c.json(data);
  },
);

router.get(
  "/user/:user_id/summary",
  describeRoute({
    summary: "根据用户ID获取该用户有权限的节点组摘要",
    tags: ["管理员节点组"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": {
            schema: resolver(z.array(NodeGroupSummaryResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("param", z.object({ user_id: z.string() })),
  async (c) => {
    const { user_id } = c.req.valid("param");
    const user = await db.user.findUnique({
      where: { id: Number(user_id) },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    const data = await nodeGroupService.getUserNodeGroups(user);
    return c.json(data);
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建新节点组",
    tags: ["管理员节点组"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", NodeGroupRequestSchema),
  async (c) => {
    const user = c.get("user");
    await nodeGroupService.createNodeGroup(user.id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除节点组",
    tags: ["管理员节点组"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const { ids } = c.req.valid("query");
    await nodeGroupService.deleteNodeGroups(ids);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "通过 ID 更新节点组",
    tags: ["管理员节点组"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", NodeGroupRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    await nodeGroupService.updateNodeGroup(id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "通过 ID 更新节点组顺序",
    tags: ["管理员节点组"],
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
    await nodeGroupService.updateNodeGroupOrder(id, order_by);
    return c.body(null, 204);
  },
);

export default router;
