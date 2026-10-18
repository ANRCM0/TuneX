import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { describeRoute, zValidator } from "../../openapi";
import { CouponValidCycle, LicenseType, licenseService } from "../../services/license";
import { getRequestIP } from "../../middlewares/ip";
import { logger } from "../../logger";
import type { AppEnv } from "../../types";

const router = new Hono<AppEnv>();

/**
 * Upstream: src/routes/admin/license.ts (82 lines) — ported 1:1, adapted to the frozen
 * `LicenseService` shape: the replica service returns the unwrapped `response.data`
 * rather than the `{ ok, status, data, error }` envelope the decompiled original used,
 * so `getPay` / `payLicense` are unwrapped here and a pay failure is detected through the
 * `{ error }` body the license server returns.
 */
router.get(
  "/pay",
  describeRoute({
    summary: "管理员获取 License 支付信息",
    description: "管理员获取 License 支付信息",
    tags: ["管理员 License"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  async (c) => {
    const payInfo = (await licenseService.getPay()) as Record<string, unknown>;
    return c.json(payInfo);
  },
);

router.put(
  "/",
  describeRoute({
    summary: "管理员更新 License",
    description: "管理员更新 License",
    tags: ["管理员 License"],
    responses: {
      204: {
        description: "成功",
      },
    },
  }),
  zValidator(
    "json",
    z.object({
      site_url: z.string(),
    }),
  ),
  async (c) => {
    const { site_url } = c.req.valid("json");
    await licenseService.updateLicense(site_url);
    return c.body(null, 204);
  },
);

router.post(
  "/",
  describeRoute({
    summary: "管理员订购 License",
    description: "管理员订购 License",
    tags: ["管理员 License"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  zValidator(
    "json",
    z.object({
      payment_id: z.number(),
      cycle: z.nativeEnum(CouponValidCycle),
      pay_type: z.string().nullable(),
      redirect_url: z.string(),
      type: z.nativeEnum(LicenseType),
      coupon: z.string().optional(),
    }),
  ),
  getRequestIP,
  async (c) => {
    const { payment_id, cycle, pay_type, redirect_url, type, coupon } = c.req.valid("json");
    const client_ip = c.get("ip");
    // `payment_id` is a number in the request contract; the frozen service narrows its
    // parameter to `string`, so the runtime value is passed through unchanged.
    const response = (await licenseService.payLicense(
      payment_id as unknown as string,
      pay_type as unknown as string,
      cycle,
      redirect_url,
      client_ip,
      type,
      coupon,
    )) as Record<string, unknown> | null;
    const error =
      response && typeof response === "object"
        ? (response as { error?: unknown }).error
        : undefined;
    if (typeof error === "string") {
      logger.error(`license pay error: ${JSON.stringify(response)}`);
      throw new HTTPException(400, {
        message: error,
        cause: response,
      });
    }
    return c.json(response);
  },
);

router.get(
  "/history",
  describeRoute({
    summary: "管理员获取 License 历史订单",
    description: "管理员获取 License 历史订单",
    tags: ["管理员 License"],
    responses: {
      200: {
        description: "成功",
      },
    },
  }),
  zValidator(
    "query",
    z.object({
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(200).default(10),
      sort: z.string().optional(),
      status: z.string().optional(),
      order_id: z.string().optional(),
    }),
  ),
  async (c) => {
    const { page, limit, sort, status, order_id } = c.req.valid("query");
    const history = (await licenseService.getHistory(page, limit, sort, status, order_id)) as Record<
      string,
      unknown
    >;
    return c.json(history);
  },
);

export default router;
