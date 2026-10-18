import { Hono } from "hono";
import { describeRoute, zValidator } from "../openapi";
import {
  BatchIdSchema,
  IdSchema,
  InNodeGroupDNSQuerySchema,
  InNodeGroupDNSRequestSchema,
} from "../schemas/request";
import { dnsProviderService } from "../services/dns_provider";
import { inNodeGroupDNSService } from "../services/in_node_group_dns";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/in_node_group_dns.ts (module 096) — ported 1:1.
 *
 * Mounted at `/in_node_group_dns` by the frozen `src/app.ts`. The static
 * `/dns_providers` route is registered before `/:id/sync` so it cannot be swallowed by
 * the parameterised path.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取入口保活配置列表",
    tags: ["入口保活"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  zValidator("query", InNodeGroupDNSQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { data, total } = await inNodeGroupDNSService.getInNodeGroupDNSList(
      user.id,
      c.req.valid("query"),
    );
    return c.json({ data, total });
  },
);

router.get(
  "/dns_providers",
  describeRoute({
    summary: "获取 DNS 授权配置摘要",
    tags: ["入口保活"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const data = await dnsProviderService.getDNSProviderSummary(user.id);
    return c.json(data);
  },
);

router.post(
  "/",
  describeRoute({
    summary: "创建入口保活配置",
    tags: ["入口保活"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", InNodeGroupDNSRequestSchema),
  async (c) => {
    const user = c.get("user");
    await inNodeGroupDNSService.createInNodeGroupDNS(user.id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新入口保活配置",
    tags: ["入口保活"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", InNodeGroupDNSRequestSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    await inNodeGroupDNSService.updateInNodeGroupDNS(user.id, id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除入口保活配置",
    tags: ["入口保活"],
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
    await inNodeGroupDNSService.deleteInNodeGroupDNS(user.id, ids);
    return c.body(null, 204);
  },
);

router.post(
  "/:id/sync",
  describeRoute({
    summary: "同步 DNS 记录",
    tags: ["入口保活"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const result = await inNodeGroupDNSService.syncDNSRecords(user.id, id);
    return c.json(result);
  },
);

export default router;
