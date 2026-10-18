import type { Context, Next } from "hono";
import { isProduction } from "../config";
import { logger, skipPaths } from "../services/logger";
import type { AppEnv } from "../types";

/**
 * Upstream: src/services/logger.ts:11-50 wires `hono-pino`'s `pinoLogger`. The replica
 * emits the same two records ("Request received" / "Response completed"), with the same
 * bindings and the same per-path level downgrade, directly against pino.
 *
 * Deviation recorded in docs/DEVIATIONS.md §6.
 */
export const requestLogger = async (c: Context<AppEnv>, next: Next) => {
  const path = c.req.path;
  const level: "debug" | "info" = skipPaths.includes(path) ? "debug" : "info";
  const startedAt = Date.now();

  logger[level](
    {
      url: path,
      query: c.req.query(),
      method: c.req.method,
      ip: c.get("ip") ?? "",
    },
    "Request received",
  );

  await next();

  logger[level]({ status: c.res.status, duration_ms: Date.now() - startedAt }, "Response completed");
};

export const logLevel = (): "debug" | "info" => (isProduction() ? "info" : "debug");
