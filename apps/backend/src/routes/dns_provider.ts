import { Hono } from "hono";
import { describeRoute, zValidator } from "../openapi";
import {
  BatchIdSchema,
  DNSProviderQuerySchema,
  DNSProviderRequestSchema,
  IdSchema,
} from "../schemas/request";
import { dnsProviderService } from "../services/dns_provider";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/dns_provider.ts (module 095) — ported 1:1.
 *
 * Mounted at `/dns_provider` by the frozen `src/app.ts`.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取 DNS 授权配置列表",
    tags: ["DNS 授权配置"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  zValidator("query", DNSProviderQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { data, total } = await dnsProviderService.getDNSProviders(
      user.id,
      c.req.valid("query"),
    );
    return c.json({ data, total });
  },
);

router.get(
  "/summary",
  describeRoute({
    summary: "获取 DNS 授权配置摘要",
    tags: ["DNS 授权配置"],
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
    summary: "创建 DNS 授权配置",
    tags: ["DNS 授权配置"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("json", DNSProviderRequestSchema),
  async (c) => {
    const user = c.get("user");
    await dnsProviderService.createDNSProvider(user.id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新 DNS 授权配置",
    tags: ["DNS 授权配置"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", DNSProviderRequestSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    await dnsProviderService.updateDNSProvider(user.id, id, c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.delete(
  "/",
  describeRoute({
    summary: "批量删除 DNS 授权配置",
    tags: ["DNS 授权配置"],
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
    await dnsProviderService.deleteDNSProviders(user.id, ids);
    return c.body(null, 204);
  },
);

export default router;
