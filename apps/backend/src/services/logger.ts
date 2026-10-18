import { pino } from "pino";
import { isProduction } from "../config";

/**
 * Upstream: src/services/logger.ts (53 lines). Upstream wires pino through
 * `hono-pino`'s `pinoLogger`; the replica keeps the same logger options and the same
 * request/response bindings but implements the middleware directly, because
 * `hono-pino` is one more moving part on a runtime this environment cannot fully match.
 *
 * Deviation recorded in docs/DEVIATIONS.md §6.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction() ? "info" : "debug"),
});

/** Paths the original deliberately logs at debug level (observer polling). */
export const skipPaths = ["/tunnel/observer", "/tunnel/in/observer"];

export default logger;
