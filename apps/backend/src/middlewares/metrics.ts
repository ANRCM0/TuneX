/**
 * HTTP metrics + request correlation.
 *
 * Every request gets an `x-request-id` (incoming value preserved, otherwise a UUID), a
 * duration observation on the latency histogram, and a completion log line carrying the
 * same id — a lightweight trace that needs no collector. Domain gauges are refreshed by the
 * cron jobs and by `/metrics` itself.
 */
import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { incr, observe } from "../services/metrics";
import type { AppEnv } from "../types";

export const REQUEST_ID_HEADER = "x-request-id";

/** The matched route pattern (low cardinality) rather than the concrete path. */
function routeLabel(c: Context<AppEnv>): string {
  const routePath = (c.req as unknown as { routePath?: string }).routePath;
  return routePath || c.req.path;
}

function clientIp(c: Context<AppEnv>): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  }
}

export const requestMetrics = async (c: Context<AppEnv>, next: Next) => {
  const id = c.req.header(REQUEST_ID_HEADER) || randomUUID();
  c.header(REQUEST_ID_HEADER, id);
  const started = performance.now();
  try {
    await next();
  } finally {
    const seconds = (performance.now() - started) / 1000;
    const route = routeLabel(c);
    const status = String(c.res.status);
    incr("relayx_http_requests_total", { method: c.req.method, route, status });
    observe("relayx_http_request_duration_seconds", seconds, { method: c.req.method, route });
    // Request logs already exist in `request-logger`; this one carries the correlation id
    // and the duration so a slow route can be found without a tracer.
    c.set("requestId" as never, id as never);
    c.header("x-response-time-ms", (seconds * 1000).toFixed(1));
  }
};

export const requestContext = { clientIp };
