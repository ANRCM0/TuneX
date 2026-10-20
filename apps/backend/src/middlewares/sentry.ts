import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { SENTRY_DSN, NODE_ENV } from "../config";
import { logger } from "../logger";

/**
 * Error-reporting middleware.
 *
 * Upstream mounts `hono/sentry`'s `sentry()` with the DSN/environment and a `beforeSend`
 * that drops `HTTPException`s with `status < 500` (expected client errors are not
 * incidents). Hono 4.13 no longer ships `hono/sentry` — the middleware moved to the
 * `toucan-js`-backed `@sentry/*` SDKs — so the replica keeps the same option shape and
 * the same filtering behaviour, but reports through the process logger instead of the
 * Sentry transport. `enabled` is false unless the build is a production build with a DSN
 * configured, exactly as upstream's `enabled: isProduction()` (plus a DSN presence check,
 * which upstream's `sentry()` did implicitly by no-oping on an empty DSN).
 *
 * See docs/DEVIATIONS.md §5.
 */

export interface SentryOptions {
  dsn: string;
  environment: string;
  enabled: boolean;
  beforeSend?: (event: unknown, hint?: { originalException?: unknown }) => unknown | null;
}

export function sentry(options: SentryOptions): MiddlewareHandler {
  const active = options.enabled && Boolean(options.dsn);
  if (!active) {
    return async (_c, next) => next();
  }
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const hint = { originalException: err };
      const keep = options.beforeSend ? options.beforeSend({}, hint) : {};
      if (keep) {
        logger.error({ err, environment: options.environment ?? NODE_ENV, path: c.req.path }, "sentry event");
      }
      throw err;
    }
  };
}

/** Re-exported so route modules can filter without depending on hono/http-exception. */
export { HTTPException };
