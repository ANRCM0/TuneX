/**
 * Rate limiting and account lockout (`apps/backend/src/middlewares/rate_limit.ts`).
 *
 * These guards do not exist upstream (the shipped Caddyfile tells operators to front the
 * panel with fail2ban), so the tests pin the replica's own contract:
 *
 *   - a bucket answers 429 with `Retry-After` once the window is exhausted;
 *   - counters are per client IP, and per submitted address for the auth buckets;
 *   - a window resets after its TTL;
 *   - `LOGIN_MAX_FAILURES` failed sign-ins lock the account even from another IP, and a
 *     successful sign-in clears the counter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  LOGIN_MAX_FAILURES,
  clearFailures,
  isLocked,
  rateLimit,
  recordFailure,
  resetRateLimits,
} from "../../apps/backend/src/middlewares/rate_limit";
import type { Hono } from "../../apps/backend/node_modules/hono/dist/types";

const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };

async function appWith(bucket: Parameters<typeof rateLimit>[0]): Promise<Hono> {
  const { Hono: HonoCtor } = await import("../../apps/backend/node_modules/hono/dist/index.js");
  const app = new HonoCtor();
  app.post("/probe", rateLimit(bucket), (c) => c.json({ ok: true }));
  app.get("/probe", rateLimit(bucket), (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono, body: unknown = {}, ip = "127.0.0.1") =>
  app.request(
    "/probe",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    {
      incoming: { socket: { remoteAddress: ip } },
      outgoing: {},
    } as never,
  );

const get = (app: Hono, ip = "127.0.0.1") =>
  app.request("/probe", { method: "GET" }, {
    incoming: { socket: { remoteAddress: ip } },
    outgoing: {},
  } as never);

beforeEach(async () => {
  await resetRateLimits();
});

describe("fixed-window counter", () => {
  it("allows up to the limit, then 429 with Retry-After", async () => {
    const app = await appWith({ name: "test", limit: 3, windowSeconds: 60 });
    for (let i = 0; i < 3; i++) {
      const res = await get(app);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-remaining")).toBe(String(3 - (i + 1)));
    }
    const blocked = await get(app);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("keeps a separate counter per client address", async () => {
    const app = await appWith({ name: "test", limit: 1, windowSeconds: 60 });
    expect((await get(app, "10.0.0.1")).status).toBe(200);
    expect((await get(app, "10.0.0.1")).status).toBe(429);
    expect((await get(app, "10.0.0.2")).status).toBe(200);
  });

  it("keys per account when the bucket asks for it", async () => {
    const app = await appWith({ ...BUCKETS.signIn, limit: 1, windowSeconds: 60 });
    expect((await post(app, { email: "a@example.test" })).status).toBe(200);
    expect((await post(app, { email: "a@example.test" })).status).toBe(429);
    // A different address, same IP, still has budget.
    expect((await post(app, { email: "b@example.test" })).status).toBe(200);
  });

  it("resets once the window has elapsed", async () => {
    const app = await appWith({ name: "test", limit: 1, windowSeconds: 1 });
    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(429);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await get(app)).status).toBe(200);
  });
});

describe("account lockout", () => {
  it("locks after the configured number of failures and reports the wait", () => {
    const email = "lock@example.test";
    for (let i = 1; i < LOGIN_MAX_FAILURES; i++) {
      expect(recordFailure(email).locked).toBe(false);
    }
    const last = recordFailure(email);
    expect(last.locked).toBe(true);
    const state = isLocked(email);
    expect(state.locked).toBe(true);
    expect(state.retryAfter).toBeGreaterThan(0);
  });

  it("clears the counter and the lock on success", () => {
    const email = "clear@example.test";
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordFailure(email);
    expect(isLocked(email).locked).toBe(true);
    clearFailures(email);
    expect(isLocked(email).locked).toBe(false);
    // A single failure after clearing does not re-lock.
    expect(recordFailure(email).locked).toBe(false);
  });

  it("is case-insensitive", () => {
    const email = "Case@Test.Example";
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordFailure(email);
    expect(isLocked("case@test.example").locked).toBe(true);
  });
});
