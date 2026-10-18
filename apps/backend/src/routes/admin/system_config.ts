import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { SystemConfigName } from "@prisma/client";
import { describeRoute, zValidator } from "../../openapi";
import { SystemConfigUpdateSchema } from "../../schemas/request";
import { systemConfigService } from "../../services/system_config";
import { emailService } from "../../services/email";
import type { AppEnv } from "../../types";

const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取全部系统配置",
    tags: ["Admin / System Config"],
    responses: { 200: { description: "成功获取全部系统配置" } },
  }),
  async (c) => {
    return c.json(await systemConfigService.getAllConfigs());
  },
);

router.patch(
  "/",
  describeRoute({
    summary: "更新系统配置",
    tags: ["Admin / System Config"],
    responses: { 204: { description: "更新成功" } },
  }),
  zValidator("json", SystemConfigUpdateSchema),
  async (c) => {
    await systemConfigService.setConfigs(c.req.valid("json"));
    return c.body(null, 204);
  },
);

router.post(
  "/test-email",
  describeRoute({
    summary: "发送测试邮件",
    tags: ["Admin / System Config"],
    responses: { 204: { description: "发送成功" } },
  }),
  zValidator("json", z.object({ email: z.string().email().optional() })),
  async (c) => {
    const { email } = c.req.valid("json");
    const to = email ?? "";
    const siteName =
      ((await systemConfigService.getConfig(
        SystemConfigName.SITE_NAME,
      )) as string) ?? "RelayX";

    const sent = await emailService.sendEmail(
      to,
      `${siteName} 测试邮件`,
      `这是一封来自 ${siteName} 的测试邮件。\n\n发送时间：${new Date().toLocaleString()}`,
    );

    if (!sent) {
      throw new HTTPException(400, {
        message: "测试邮件发送失败，请先检查邮件配置是否正确",
      });
    }
    return c.body(null, 204);
  },
);

export default router;
