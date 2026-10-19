/**
 * Route-level error payloads, exercised through the real Hono app in-process.
 *
 * The guard and validation wiring is covered structurally elsewhere; this suite
 * checks what a client actually receives: the 401 from the bearer guard, the 403
 * from the admin licence/role guards, the 400 body a zod validator produces, the
 * 409 the payment delete surfaces when a topup order still references the row, and
 * the plain 404 for an unknown path.
 *
 * The app is imported with DATABASE_URL pointing at a throwaway SQLite file and a
 * stubbed licence service; requests are made with `app.request` (no listener) and a
 * fake node-server env so `getRequestIP` has a peer address.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { Hono } from "hono";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { LicenseService } from "../../apps/backend/src/services/license";

const temp: TempDatabase = createTempDatabase("route-errors");

let db: PrismaClient;
let app: Hono;
let adminKey = "";
let userKey = "";
let paymentId = 0;

const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };

function request(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return app.request(
    path,
    {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    env as never,
  );
}

beforeAll(async () => {
  // Keep `showRoutes` from dumping the table into the test output.
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "silent";
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;

  const appModule = await import("../../apps/backend/src/app");
  app = appModule.default as unknown as Hono;

  // Register after importing the app: the real licence service registers its
  // factory at module load, and the container is last-wins.
  const { register, TOKENS } = await import("../../apps/backend/src/container");
  register(TOKENS.License, () => ({
    getLicense: async () => ({ type: "business", expired_at: new Date(Date.now() + 86400_000) }),
  }) as unknown as LicenseService);

  adminKey = "admin-api-key";
  userKey = "user-api-key";
  await db.user.create({ data: { email: "admin@example.test", api_key: adminKey, super_admin: true } });
  await db.user.create({ data: { email: "user@example.test", api_key: userKey, super_admin: false } });

  const payment = await db.payment.create({
    data: { name: "in-use", url: "https://pay.example.test", config: {}, method: "epay" },
  });
  paymentId = payment.id;
  const payer = await db.user.findFirstOrThrow({ where: { api_key: userKey } });
  await db.topupOrder.create({
    data: { user_id: payer.id, payment_id: payment.id, price: 10, pay_url: "u", order_id: "ERR-1" },
  });
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

describe("authentication and authorization", () => {
  it("rejects a protected route without a token", async () => {
    const res = await request("GET", "/admin/node");
    expect(res.status).toBe(401);
    // `bearerAuth` throws an HTTPException with no message, so `app.onError`
    // takes the `{error: err}` branch and serialises the exception itself — the
    // recovered upstream behaviour.
    expect(await res.json()).toEqual({ error: { res: {}, status: 401 } });
  });

  it("lets a super admin through", async () => {
    const res = await request("GET", "/admin/node", { token: adminKey });
    expect(res.status).toBe(200);
  }, 20_000);

  it("rejects a non-admin with the adminRequired payload", async () => {
    const res = await request("GET", "/admin/node", { token: userKey });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("rejects an unknown token", async () => {
    const res = await request("GET", "/admin/node", { token: "nope" });
    expect(res.status).toBe(401);
  });
});

describe("validation and handler errors", () => {
  it("returns the zod 400 body for an invalid payload", async () => {
    const res = await request("POST", "/admin/pay", {
      token: adminKey,
      body: { name: "incomplete" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { issues: unknown[] } };
    expect(body.success).toBe(false);
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.length).toBeGreaterThan(0);
  });

  it("returns 400 for a missing required body field", async () => {
    const res = await request("PUT", "/admin/license", { token: adminKey, body: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
  });

  it("surfaces the 409 when a payment is still referenced", async () => {
    const res = await request("DELETE", `/admin/pay/${paymentId}`, { token: adminKey });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "该支付配置正在被使用，无法删除" });
  });

  it("maps a missing entity to the same 409 as an in-use row (upstream catch-all)", async () => {
    const res = await request("DELETE", "/admin/pay/999999", { token: adminKey });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "该支付配置正在被使用，无法删除" });
  });

  it("answers 404 for an unknown path", async () => {
    const res = await request("GET", "/definitely-not-a-route", { token: adminKey });
    expect(res.status).toBe(404);
  });
});
