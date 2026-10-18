import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, resolver } from "../openapi";
import { redisService } from "../services/redis";
import { telegramService } from "../services/telegram";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/bot.ts (34 lines) — ported 1:1.
 *
 * Mounted at `/bot` by the frozen `src/app.ts`. The auth chain treats `/bot` as a public
 * path but still resolves the session, which is why the handler can read `c.get("user")`.
 */
const router = new Hono<AppEnv>();

router.get(
  "/",
  describeRoute({
    summary: "获取 Bot 信息",
    description: "获取 Bot 信息",
    tags: ["Bot"],
    responses: {
      200: {
        description: "Bot 信息",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                username: z.string(),
                bind_key: z.string(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const username = await telegramService.getBotInfo();
    const bind_key = await redisService.getOrCreateTgBindToken(user.id);
    return c.json({ username, bind_key });
  },
);

export default router;
