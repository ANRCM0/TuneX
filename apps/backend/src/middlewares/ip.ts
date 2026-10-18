import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import type { AppEnv } from "../types";

/**
 * Upstream: src/middlewares/ip.ts (7 lines).
 *
 * `getConnInfo` comes from @hono/node-server because the replica runs on Node rather
 * than Bun. Behaviour is identical: X-Forwarded-For wins, first entry wins.
 */
export const getRequestIP = async (c: Context<AppEnv>, next: Next) => {
  const info = getConnInfo(c);
  const ip = c.req.header("x-forwarded-for") ?? info.remote.address;
  c.set("ip", ip?.split(",")[0] ?? "");
  return next();
};
