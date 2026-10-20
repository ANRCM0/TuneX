/**
 * Money-path behaviours that previously had no assertion:
 * payment-callback short-circuit, stacked topup bonuses, the renewal scanner,
 * and observer traffic priced as bytes times the sum of group rates.
 */
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { Hono } from "hono";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { LicenseService } from "../../apps/backend/src/services/license";
import type { PlanCouponService } from "../../apps/backend/src/services/plan_coupon";
import type { PlanService } from "../../apps/backend/src/services/plan";
import type { SystemConfigService } from "../../apps/backend/src/services/system_config";
const temp: TempDatabase = createTempDatabase("money-gaps");
const API_KEY = "pay-secret";
const PID = "1001";

let db: PrismaClient;
let app: Hono;
let plans: PlanService;
let gateway: http.Server;
let gatewayMode: "paid" | "unpaid" = "paid";
const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };

function epaySign(fields: Record<string, string>): string {
  const content =
    Object.entries(fields)
      .filter(([key, value]) => value !== "" && key !== "sign" && key !== "sign_type")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("&") + API_KEY;
  return crypto.createHash("md5").update(content).digest("hex");
}

function callbackBody(orderId: string, tradeId: string, money = "10.00") {
  const fields: Record<string, string> = {
    pid: PID,
    out_trade_no: orderId,
    trade_no: tradeId,
    trade_status: "TRADE_SUCCESS",
    money,
  };
  fields.sign = epaySign(fields);
  fields.sign_type = "MD5";
  return fields;
}

beforeAll(async () => {
  // These suites force production; the config layer then requires a secret.
  // Use the recovered key so a checkout without a .env still runs.
  process.env.CONFIG_SECRET ??= "KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4=";
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "silent";
  process.env.REDIS_URL = "";
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;

  gateway = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (gatewayMode === "unpaid") {
      res.end(JSON.stringify({ code: 0, status: 0 }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const trade = url.searchParams.get("trade_no") ?? "";
    res.end(
      JSON.stringify({
        code: 1,
        status: 1,
        pid: PID,
        out_trade_no: trade.replace("TR-", "ORD-"),
        trade_no: trade,
        money: "10.00",
      }),
    );
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const port = (gateway.address() as { port: number }).port;

  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const appModule = await import("../../apps/backend/src/app");
  app = appModule.default as unknown as Hono;
  const { register, TOKENS } = await import("../../apps/backend/src/container");
  register(TOKENS.License, () => ({ getLicense: async () => null }) as unknown as LicenseService);

  const { PlanService: Service } = await import("../../apps/backend/src/services/plan");
  const { TopupService } = await import("../../apps/backend/src/services/topup");
  plans = new Service(
    { getCoupon: async () => null } as unknown as PlanCouponService,
    { lockUserSubscribe: async (_id: number, fn: () => Promise<void>) => fn() } as never,
    { notifyRenewPlanFailed: async () => {}, notifySubscribePlan: async () => {} } as never,
    { getConfig: async () => undefined } as unknown as SystemConfigService,
    new TopupService(
      { getLicense: async () => null } as unknown as LicenseService,
      { getConfig: async () => undefined } as unknown as SystemConfigService,
    ),
  );

  await db.payment.create({
    data: {
      name: "epay",
      url: `http://127.0.0.1:${port}`,
      method: "epay",
      config: { api_key: API_KEY, pid: PID },
    },
  });
}, 60_000);

afterAll(async () => {
  gateway?.close();
  await db?.$disconnect();
  temp.cleanup();
});

describe("payment callback", () => {
  it("credits a pending order once and repeats success without a second credit", async () => {
    const payment = await db.payment.findFirstOrThrow();
    const user = await db.user.create({ data: { email: "payer@example.test", balance: 1 } });
    await db.topupOrder.create({
      data: {
        user_id: user.id,
        payment_id: payment.id,
        price: 10,
        bonus: 2,
        pay_url: "https://pay.example.test",
        order_id: "ORD-OK",
        trade_id: "TR-OK",
      },
    });
    gatewayMode = "paid";
    const first = await app.request(
      `/pay/${payment.id}/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackBody("ORD-OK", "TR-OK")),
      },
      env as never,
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("success");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance).toBe(13);
    expect((await db.topupOrder.findUniqueOrThrow({ where: { order_id: "ORD-OK" } })).status).toBe("success");

    const second = await app.request(
      `/pay/${payment.id}/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackBody("ORD-OK", "TR-OK")),
      },
      env as never,
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("success");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance).toBe(13);
  });

  it("rejects a non-pending order with 409 and an unconfirmed gateway with 502", async () => {
    const payment = await db.payment.findFirstOrThrow();
    const user = await db.user.create({ data: { email: "payer2@example.test", balance: 5 } });
    await db.topupOrder.create({
      data: {
        user_id: user.id,
        payment_id: payment.id,
        price: 10,
        pay_url: "u",
        order_id: "ORD-CANCEL",
        trade_id: "TR-CANCEL",
        status: "cancelled",
      },
    });
    const cancelled = await app.request(
      `/pay/${payment.id}/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackBody("ORD-CANCEL", "TR-CANCEL")),
      },
      env as never,
    );
    expect(cancelled.status).toBe(409);

    await db.topupOrder.create({
      data: {
        user_id: user.id,
        payment_id: payment.id,
        price: 10,
        pay_url: "u",
        order_id: "ORD-QUERY",
        trade_id: "TR-QUERY",
      },
    });
    gatewayMode = "unpaid";
    const unconfirmed = await app.request(
      `/pay/${payment.id}/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackBody("ORD-QUERY", "TR-QUERY")),
      },
      env as never,
    );
    expect(unconfirmed.status).toBe(502);
    expect((await db.topupOrder.findUniqueOrThrow({ where: { order_id: "ORD-QUERY" } })).status).toBe(
      "pending",
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance).toBe(5);
  });
});

describe("topup bonus", () => {
  it("sums every activity whose window contains the price", { timeout: 30_000 }, async () => {
    const { TopupActivityService } = await import("../../apps/backend/src/services/topup_activity");
    const bonus = new TopupActivityService();
    await db.topupActivity.create({ data: { type: "percentage", value: 10, min_amount: 20 } });
    await db.topupActivity.create({ data: { type: "fixed", value: 3 } });
    await db.topupActivity.create({ data: { type: "fixed", value: 100, min_amount: 1000 } });
    expect(await bonus.calculateBonus(50)).toBe(8);
    expect(await bonus.calculateBonus(10)).toBe(3);
  });
});

describe("renewUsersPlan", () => {
  it(
    "renews an expiring plan when the balance covers it and skips the rest",
    { timeout: 30_000 },
    async () => {
      const plan = await db.plan.create({
        data: {
          name: "renew-me",
          price: 10,
          renewable: true,
          billing_cycle: "month",
          allow_custom_in_node_group: false,
          allow_custom_out_node_group: false,
          all_in_node_groups: false,
          all_out_node_groups: false,
        },
      });
      const due = await db.user.create({
        data: { email: "due@example.test", balance: 50, auto_renew: true },
      });
      const poor = await db.user.create({
        data: { email: "poor@example.test", balance: 1, auto_renew: true },
      });
      const later = await db.user.create({
        data: { email: "later@example.test", balance: 50, auto_renew: true },
      });
      const soon = new Date(Date.now() + 30_000);
      const far = new Date(Date.now() + 10 * 86400_000);
      await db.userPlan.create({ data: { user_id: due.id, plan_id: plan.id, expired_at: soon } });
      await db.userPlan.create({ data: { user_id: poor.id, plan_id: plan.id, expired_at: soon } });
      await db.userPlan.create({ data: { user_id: later.id, plan_id: plan.id, expired_at: far } });

      await plans.renewUsersPlan();

      expect((await db.user.findUniqueOrThrow({ where: { id: due.id } })).balance).toBe(40);
      const renewed = await db.userPlan.findUniqueOrThrow({ where: { user_id: due.id } });
      expect(renewed.expired_at!.getTime()).toBeGreaterThan(soon.getTime() + 29 * 86400_000);
      expect((await db.user.findUniqueOrThrow({ where: { id: poor.id } })).balance).toBe(1);
      expect((await db.user.findUniqueOrThrow({ where: { id: later.id } })).balance).toBe(50);
      expect(await db.planOrder.count({ where: { user_id: due.id } })).toBe(1);
      expect(await db.planOrder.count({ where: { user_id: { in: [poor.id, later.id] } } })).toBe(0);
    },
  );
});

describe("observer traffic cost", () => {
  it("adds GiB times the in, out and chain rates", { timeout: 30_000 }, async () => {
    const owner = await db.user.create({ data: { email: "node-owner@example.test" } });
    const buyer = await db.user.create({ data: { email: "buyer@example.test" } });
    const plan = await db.plan.create({
      data: {
        name: "meter",
        price: 0,
        allow_custom_in_node_group: false,
        allow_custom_out_node_group: false,
        all_in_node_groups: false,
        all_out_node_groups: false,
      },
    });
    await db.userPlan.create({ data: { user_id: buyer.id, plan_id: plan.id, traffic_used: 0 } });
    const inn = await db.nodeGroup.create({
      data: { name: "in", node_type: "in", user_id: owner.id, traffic_rate: 2 },
    });
    const out = await db.nodeGroup.create({
      data: { name: "out", node_type: "out", user_id: owner.id, traffic_rate: 3 },
    });
    const hop = await db.nodeGroup.create({
      data: { name: "hop", node_type: "in", user_id: owner.id, traffic_rate: 4 },
    });
    const tunnel = await db.tunnel.create({
      data: {
        name: "metered",
        user_id: buyer.id,
        in_node_group_id: inn.id,
        out_node_group_id: out.id,
        load_balance_type: "round",
        forward_addresses: [],
      },
    });
    await db.tunnelChain.create({ data: { tunnel_id: tunnel.id, node_type: "in", node_group_id: hop.id } });

    const gib = 1024 * 1024 * 1024;
    const response = await app.request(
      "/tunnel/observer",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              kind: "service",
              service: `tcp-${tunnel.id}`,
              type: "stats",
              stats: { totalConns: 1, currentConns: 0, inputBytes: gib, outputBytes: gib, totalErrs: 0 },
            },
          ],
        }),
      },
      env as never,
    );
    expect(response.status).toBe(200);
    const stored = await db.tunnel.findUniqueOrThrow({ where: { id: tunnel.id } });
    expect(stored.traffic).toBe(2);
    expect(stored.traffic_cost).toBe(18);
    expect((await db.userPlan.findUniqueOrThrow({ where: { user_id: buyer.id } })).traffic_used).toBe(18);
  });
});
