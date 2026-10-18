import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { AdminStatsQuerySchema } from "../../schemas/request";
import { AdminStatsResponseSchema } from "../../schemas/response";
import { statsService } from "../../services/stats";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/stats.ts (206 lines) — ported 1:1.
 *
 * Mounted at `/admin/stats` by the frozen `src/app.ts`. The aggregation SQL lives in
 * `services/stats.ts` (replica-side split; see that module's header) and the route keeps
 * upstream's method+path+describeRoute metadata.
 *
 * DEVIATION (for docs/DEVIATIONS.md): upstream declares inline `z.string()` query schemas
 * for `/user` and `/traffic`; the replica reuses the frozen `AdminStatsQuerySchema`
 * (`z.coerce.date()` bounds, `aggregate_by` defaulting to `day`) because request schemas
 * are frozen kernel files. The SQL bounds are therefore formatted from `Date` objects.
 */
const router = new Hono<AppEnv>();

const TrafficStatsQuerySchema = AdminStatsQuerySchema.extend({
  in_node_group_id: z.coerce.number().optional(),
  out_node_group_id: z.coerce.number().optional(),
});

router.get(
  "/",
  describeRoute({
    summary: "获取首页统计数据",
    tags: ["管理员统计"],
    responses: {
      200: {
        description: "成功",
        content: {
          "application/json": { schema: resolver(AdminStatsResponseSchema) },
        },
      },
    },
  }),
  zValidator("query", AdminStatsQuerySchema),
  async (c) => {
    const data = await statsService.getOverview();
    return c.json(data);
  },
);

router.get(
  "/user",
  describeRoute({
    summary: "获取新增用户统计",
    tags: ["管理员统计"],
    responses: {
      200: { description: "成功" },
    },
  }),
  zValidator("query", AdminStatsQuerySchema),
  async (c) => {
    const stats = await statsService.getUserStats(c.req.valid("query"));
    return c.json(stats);
  },
);

router.get(
  "/traffic",
  describeRoute({
    summary: "获取流量统计",
    tags: ["管理员统计"],
    responses: {
      200: { description: "成功" },
    },
  }),
  zValidator("query", TrafficStatsQuerySchema),
  async (c) => {
    const stats = await statsService.getTrafficStats(c.req.valid("query"));
    return c.json(stats);
  },
);

export default router;
