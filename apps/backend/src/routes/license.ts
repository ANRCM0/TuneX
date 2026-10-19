import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../openapi";
import { LicenseResponseSchema } from "../schemas/response";
import { licenseService } from "../services/license";
import { CouponValidCycle, LicenseType } from "../services/license";
import type { AppEnv } from "../types";

const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取 License",
    description: "获取当前站点的 License 信息",
    tags: ["License"],
    responses: {
      200: {
        description: "成功",
        content: { "application/json": { schema: resolver(LicenseResponseSchema) } },
      },
    },
  }),
  zValidator("query", z.object({ force: z.string().optional() })),
  async (c) => {
    const license = await licenseService.getLicense(c.req.query("force") === "true");
    return c.json({
      expired_at: license?.expired_at,
      created_at: license?.created_at,
      site_url: license?.site_url,
      type: license?.type,
    });
  },
);

router.get(
  "/notify",
  describeRoute({
    summary: "通知 License",
    description: "强制从授权服务器刷新 License",
    tags: ["License"],
  }),
  async (c) => {
    await licenseService.getLicense(true);
    return c.body(null, 204);
  },
);

router.get(
  "/coupon",
  describeRoute({
    summary: "获取优惠码",
    description: "校验并获取优惠码信息",
    tags: ["License"],
    responses: { 200: { description: "成功" } },
  }),
  zValidator(
    "query",
    z.object({
      coupon: z.string().min(1, "优惠码不能为空"),
      type: z.nativeEnum(LicenseType),
      cycle: z.nativeEnum(CouponValidCycle),
    }),
  ),
  async (c) => {
    const { coupon, type, cycle } = c.req.valid("query");
    return c.json(await licenseService.getCoupon(coupon, type, cycle));
  },
);

export default router;
