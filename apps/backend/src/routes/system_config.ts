import { Hono } from "hono";
import { z } from "zod";
import { SystemConfigName } from "@prisma/client";
import { describeRoute, zValidator } from "../openapi";
import { systemConfigService } from "../services/system_config";
import type { AppEnv } from "../types";

const router = new Hono<AppEnv>();

router.get(
  "/site",
  describeRoute({
    summary: "获取站点配置",
    description: "获取站点公开配置",
    tags: ["System Config"],
    responses: { 200: { description: "成功获取站点配置" } },
  }),
  async (c) => {
    return c.json(
      await systemConfigService.getConfigs([
        SystemConfigName.SITE_NAME,
        SystemConfigName.SITE_DESCRIPTION,
        SystemConfigName.LOGO_URL,
        SystemConfigName.ALLOW_REGISTER,
        SystemConfigName.CHATWOOT_BASE_URL,
        SystemConfigName.CHATWOOT_TOKEN,
        SystemConfigName.HIDE_FOOTER,
        SystemConfigName.ENABLE_SUBSCRIPTION,
      ]),
    );
  },
);

router.get(
  "/",
  describeRoute({
    summary: "获取系统配置",
    description: "按名称获取系统配置，名称以逗号分隔",
    tags: ["System Config"],
    responses: { 200: { description: "成功获取系统配置" } },
  }),
  zValidator("query", z.object({ name: z.string() })),
  async (c) => {
    const name = c.req.valid("query").name.split(",") as SystemConfigName[];
    return c.json(await systemConfigService.getConfigs(name));
  },
);

export default router;
