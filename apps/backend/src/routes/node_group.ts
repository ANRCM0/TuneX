import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { NodeType } from "@prisma/client";
import { describeRoute, resolver, zValidator } from "../openapi";
import { planRequired } from "../middlewares/plan";
import { nodeGroupService } from "../services/node_group";
import { BatchIdSchema, IdSchema, NodeGroupQuerySchema, NodeGroupRequestSchema } from "../schemas/request";
import { NodeGroupResponseSchema, NodeGroupSummaryResponseSchema } from "../schemas/response";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/node_group.ts (103 decompiled lines) — ported 1:1.
 */
const router = new Hono<AppEnv>();

router.get(
  "/summary",
  describeRoute({
    summary: "获取节点组摘要",
    tags: ["节点组"],
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
    const data = await nodeGroupService.getUserNodeGroups(c.get("user"));
    return c.json(data);
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取节点组列表",
    tags: ["节点组"],
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
    const { data, total } = await nodeGroupService.getNodeGroups(c.req.valid("query"), c.get("user").id);
    return c.json({
      data,
      total,
    });
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建节点组",
    tags: ["节点组"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", NodeGroupRequestSchema),
  planRequired,
  async (c) => {
    const user = c.get("user");
    const plan = c.get("plan")!;
    const allow_custom_in_node_group = plan.plan.allow_custom_in_node_group;
    const allow_custom_out_node_group = plan.plan.allow_custom_out_node_group;
    const node_type = c.req.valid("json").node_type;
    if (node_type === NodeType.in && !allow_custom_in_node_group) {
      throw new HTTPException(403, { message: "不允许创建入节点组" });
    }
    if (node_type === NodeType.out && !allow_custom_out_node_group) {
      throw new HTTPException(403, { message: "不允许创建出节点组" });
    }
    await nodeGroupService.createNodeGroup(user.id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除节点组",
    tags: ["节点组"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("query", BatchIdSchema),
  async (c) => {
    const user = c.get("user");
    const { ids } = c.req.valid("query");
    await nodeGroupService.deleteNodeGroups(ids, user.id);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新节点组",
    tags: ["节点组"],
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
    const user = c.get("user");
    await nodeGroupService.updateNodeGroup(id, c.req.valid("json"), user.id);
    return c.body(null, 204);
  },
);

router.patch(
  "/:id/order",
  describeRoute({
    summary: "更新节点组排序",
    tags: ["节点组"],
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
    await nodeGroupService.updateNodeGroupOrder(id, order_by, user.id);
    return c.body(null, 204);
  },
);

export default router;
