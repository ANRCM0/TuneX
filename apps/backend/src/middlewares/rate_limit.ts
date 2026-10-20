/**
 * Request rate limiting and login lockout.
 *
 * Upstream has none: the Caddyfile comment in the shipped deployment tells operators to put
 * fail2ban / a WAF in front. A deployable panel needs the guard in-process, so this module
 * adds two bounds without changing any upstream response shape it does not have to:
 *
 *   1. fixed-window counters per (bucket, key), where the key is the client IP for the
 *      coarse buckets and the client IP **plus the submitted address** for sign-in. Counters
 *      live in Redis when `REDIS_URL` is set (shared across replicas) and in process memory
 *      otherwise, so single-process deployments still get protection.
 *   2. a per-account lockout: after `LOGIN_MAX_FAILURES` failed sign-ins inside
 *      `LOGIN_WINDOW_SECONDS`, the account is locked for `LOGIN_LOCK_SECONDS` regardless of
 *      the source IP. Only a successful sign-in clears the failure counter.
 *
 * Exceeding a limit answers `429` with `Retry-After`; lockout answers `429` with a message
 * that names the remaining time. Both are logged at `warn` with the bucket and key.
 */
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "@hono/node-server/conninfo";
import { client as redisClient } from "../services/redis";
import { logger } from "../logger";
import type { AppEnv } from "../types";

export type Bucket = {
  name: string;
  /** Maximum requests per window. */
  limit: number;
  windowSeconds: number;
  /** Include the submitted `email` in the key (sign-in / sign-up / verification). */
  perAccount?: boolean;
};

export const BUCKETS = {
  signIn: { name: "auth:sign-in", limit: 10, windowSeconds: 60, perAccount: true },
  signUp: { name: "auth:sign-up", limit: 5, windowSeconds: 60, perAccount: true },
  verifyMail: { name: "auth:verify-mail", limit: 5, windowSeconds: 300, perAccount: true },
  callback: { name: "pay:callback", limit: 60, windowSeconds: 60 },
  observer: { name: "tunnel:observer", limit: 240, windowSeconds: 60 },
  api: { name: "api", limit: 900, windowSeconds: 60 },
} as const satisfies Record<string, Bucket>;

/** Failed sign-ins allowed before the account is locked. */
export const LOGIN_MAX_FAILURES = Number.parseInt(process.env.LOGIN_MAX_FAILURES || "8", 10);
export const LOGIN_WINDOW_SECONDS = Number.parseInt(process.env.LOGIN_WINDOW_SECONDS || "900", 10);
export const LOGIN_LOCK_SECONDS = Number.parseInt(process.env.LOGIN_LOCK_SECONDS || "900", 10);

type Counter = { count: number; resetAt: number };

/**
 * In-process fallback store. Redis is preferred (multi-replica), but a single container
 * deployment must not be unprotected, so the same interface is implemented locally.
 */
const memory = new Map<string, Counter>();

function memoryIncr(key: string, windowSeconds: number): Counter {
  const now = Date.now();
  const existing = memory.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
    memory.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

/** Rounded seconds until `resetAt`, at least 1 so `Retry-After` is never 0. */
const retryAfter = (resetAt: number) => Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

function clientIp(c: Context<AppEnv>): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  }
}

/** Read the account identifier from an already-parsed JSON body, without consuming it. */
async function accountKey(c: Context<AppEnv>): Promise<string | undefined> {
  if (c.req.method !== "POST") return undefined;
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown };
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function incr(key: string, windowSeconds: number): Promise<Counter> {
  // The shared client is either ioredis (multi-replica counters) or the in-process
  // substitute. Both expose `incr`/`ttl`, so the same code path is exercised in tests.
  const redisKey = `ratelimit:${key}`;
  const count = await redisClient.incr!(redisKey);
  if (count === 1) await redisClient.expire(redisKey, windowSeconds);
  const ttl = await redisClient.ttl!(redisKey);
  return { count, resetAt: Date.now() + Math.max(ttl > 0 ? ttl : windowSeconds, 1) * 1000 };
}

/** Middleware factory for one bucket. */
export function rateLimit(bucket: Bucket) {
  return async (c: Context<AppEnv>, next: Next) => {
    const ip = clientIp(c);
    const account = bucket.perAccount ? await accountKey(c) : undefined;
    const key = account ? `${bucket.name}:${ip}:${account}` : `${bucket.name}:${ip}`;
    const counter = await incr(key, bucket.windowSeconds);
    c.header("X-RateLimit-Limit", String(bucket.limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, bucket.limit - counter.count)));
    if (counter.count > bucket.limit) {
      c.header("Retry-After", String(retryAfter(counter.resetAt)));
      logger.warn({ bucket: bucket.name, key, count: counter.count }, "rate limit exceeded");
      throw new HTTPException(429, { message: "请求过于频繁，请稍后再试" });
    }
    await next();
  };
}

// ── account lockout ────────────────────────────────────────────────────────────

const failures = new Map<string, Counter>();
const locks = new Map<string, number>();

const failKey = (email: string) => `login-fail:${email.toLowerCase()}`;

export function isLocked(email: string): { locked: boolean; retryAfter: number } {
  const until = locks.get(email.toLowerCase());
  if (!until) return { locked: false, retryAfter: 0 };
  if (until <= Date.now()) {
    locks.delete(email.toLowerCase());
    return { locked: false, retryAfter: 0 };
  }
  return { locked: true, retryAfter: Math.ceil((until - Date.now()) / 1000) };
}

export function recordFailure(email: string): { locked: boolean; failures: number } {
  const key = failKey(email);
  const now = Date.now();
  const existing = failures.get(key);
  const counter =
    !existing || existing.resetAt <= now
      ? { count: 1, resetAt: now + LOGIN_WINDOW_SECONDS * 1000 }
      : { ...existing, count: existing.count + 1 };
  failures.set(key, counter);
  if (counter.count >= LOGIN_MAX_FAILURES) {
    locks.set(email.toLowerCase(), now + LOGIN_LOCK_SECONDS * 1000);
    logger.warn({ email, failures: counter.count }, "account locked after repeated failures");
    return { locked: true, failures: counter.count };
  }
  return { locked: false, failures: counter.count };
}

export function clearFailures(email: string): void {
  failures.delete(failKey(email));
  locks.delete(email.toLowerCase());
}

/**
 * Test / ops helper: drop every counter and lock.
 *
 * Counters live in the shared Redis client (memory-backed when `REDIS_URL` is empty), so
 * they are deleted through it as well as from the local fallback map.
 */
export async function resetRateLimits(): Promise<void> {
  memory.clear();
  failures.clear();
  locks.clear();
  const keys = await redisClient.keys("ratelimit:*");
  if (keys.length) await redisClient.del(...keys);
}
