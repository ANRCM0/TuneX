/**
 * Operational surfaces that had no assertion: health probes, the sysinfo
 * heartbeat, topup creation, and the observer's per-node stats branch.
 */
import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { Hono } from "hono";
import type { PrismaClient } from "../../apps/backend/src/db";

const temp: TempDatabase = createTempDatabase("ops-gaps");
const DIAG = "diag-secret";
const USER_KEY = "user-key";

let db: PrismaClient;
let app: Hono;
let client: { keys(pattern: string): Promise<string[]> };
let gateway: http.Server;
let paymentId = 0;
const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env as never,
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "silent";
  process.env.REDIS_URL = "";
  process.env.DIAG_TOKEN = DIAG;
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;

  gateway = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/mapi.php")) {
      res.end(JSON.stringify({ code: 1, payurl: "https://pay.example.test/1", trade_no: "TR-NEW" }));
      return;
    }
    res.end(JSON.stringify({ code: 1 }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const port = (gateway.address() as { port: number }).port;

  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const appModule = await import("../../apps/backend/src/app");
  app = appModule.default as unknown as Hono;
  const redisModule = await import("../../apps/backend/src/services/redis");
  client = redisModule.client as unknown as { keys(pattern: string): Promise<string[]> };
  const { register, TOKENS } = await import("../../apps/backend/src/container");
  register(TOKENS.License, () => ({ getLicense: async () => null }) as never);

  const payment = await db.payment.create({
    data: {
      name: "epay",
      url: `http://127.0.0.1:${port}`,
      method: "epay",
      config: { api_key: "k", pid: "1" },
    },
  });
  paymentId = payment.id;
  await db.user.create({
    data: { email: "ops@example.test", api_key: USER_KEY, balance: 7 },
  });
}, 60_000);

afterAll(async () => {
  gateway?.close();
  await db?.$disconnect();
  temp.cleanup();
});

describe("health", () => {
  it("reports db and redis checks", async () => {
    const response = await request("GET", "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { db: "ok", redis: "ok" } });
  });

  it("gates /diag and /heap behind DIAG_TOKEN", async () => {
    expect((await request("GET", "/health/diag")).status).toBe(404);
    expect((await request("GET", "/health/heap")).status).toBe(404);

    const diag = await request("GET", "/health/diag", undefined, { "x-diag-token": DIAG });
    expect(diag.status).toBe(200);
    const body = (await diag.json()) as { pid: number; memory: { rss: number } };
    expect(body.pid).toBe(process.pid);
    expect(body.memory.rss).toBeGreaterThan(0);

    const heap = await request("GET", `/health/heap?token=${DIAG}`);
    expect(heap.status).toBe(500);
    expect(await heap.json()).toEqual({ error: "Not running under Bun" });
  });
});

describe("sysinfo heartbeat", () => {
  it("joins the group room for an active node and stores the payload", async () => {
    const owner = await db.user.create({ data: { email: "hb-owner@example.test" } });
    const group = await db.nodeGroup.create({
      data: { name: "hb", node_type: "in", user_id: owner.id },
    });
    const node = await db.node.create({
      data: { node_id: "hb-node", connect_ip: "203.0.113.7", node_group_id: group.id },
    });
    const handlers = new Map<string, (data: Record<string, unknown>) => Promise<void>>();
    const rooms = new Set<string>();
    const socket = {
      data: {} as Record<string, unknown>,
      handshake: { address: "203.0.113.7", headers: {} as Record<string, string> },
      rooms,
      on(event: string, fn: (data: Record<string, unknown>) => Promise<void>) {
        handlers.set(event, fn);
      },
      async join(room: string) {
        rooms.add(room);
      },
      async leave(room: string) {
        rooms.delete(room);
      },
    };
    const { sysinfo } = await import("../../apps/backend/src/socket-io/handlers/sysinfo");
    sysinfo(socket as never);
    await handlers.get("sysinfo")!({
      node_id: "hb-node",
      sysinfo: { cpu: 0.5, mem: 0.25, last_active: new Date() },
    });
    expect(rooms.has(`node_group/${group.id}`)).toBe(true);

    const { redisService: redis } = await import("../../apps/backend/src/services/redis");
    const stored = (await redis.getNodeSysinfo(group.id, node.id)) as { cpu: number } | null;
    expect(stored?.cpu).toBe(0.5);

    await db.node.update({ where: { id: node.id }, data: { status: "inactive" } });
    // The handler trusts the 60s `node:info` cache; drop it so the DB row is re-read.
    await redis.delNodeInfo("hb-node");
    socket.data = {};
    await handlers.get("sysinfo")!({ node_id: "hb-node", sysinfo: { cpu: 0.1 } });
    expect(rooms.has(`node_group/${group.id}`)).toBe(false);
  });
});

describe("topup creation", () => {
  const auth = { authorization: `Bearer ${USER_KEY}` };

  it("rejects an amount below MIN_TOPUP_AMOUNT", async () => {
    const response = await request(
      "POST",
      "/topup",
      { price: 5, redirect_url: "https://panel.example.test/done", payment_id: paymentId },
      auth,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("充值金额不能小于 10 元");
  });

  it("freezes the bonus, snapshots the balance, and refuses a second pending order", async () => {
    await db.topupActivity.deleteMany();
    await db.topupActivity.create({ data: { type: "percentage", value: 10 } });
    const response = await request(
      "POST",
      "/topup",
      { price: 100, redirect_url: "https://panel.example.test/done", payment_id: paymentId },
      auth,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pay_url: "https://pay.example.test/1" });

    const order = await db.topupOrder.findFirstOrThrow();
    expect(order).toMatchObject({ price: 100, bonus: 10, balance: 7, status: "pending", trade_id: "TR-NEW" });
    expect(order.order_id).toMatch(/^\d{14}\d{4,5}$/);

    const again = await request(
      "POST",
      "/topup",
      { price: 100, redirect_url: "https://panel.example.test/done", payment_id: paymentId },
      auth,
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("存在未完成的充值订单");
    expect(await db.topupOrder.count()).toBe(1);
  });
});

describe("observer node stats", () => {
  async function seed() {
    const owner = await db.user.create({ data: { email: `obs-${Date.now()}@example.test` } });
    const buyer = await db.user.create({ data: { email: `buy-${Date.now()}@example.test` } });
    const plan = await db.plan.create({
      data: {
        name: "obs",
        price: 0,
        allow_custom_in_node_group: false,
        allow_custom_out_node_group: false,
        all_in_node_groups: false,
        all_out_node_groups: false,
      },
    });
    await db.userPlan.create({ data: { user_id: buyer.id, plan_id: plan.id } });
    const group = await db.nodeGroup.create({
      data: { name: "obs", node_type: "in", user_id: owner.id, traffic_rate: 1 },
    });
    const tunnel = await db.tunnel.create({
      data: {
        name: "obs",
        user_id: buyer.id,
        in_node_group_id: group.id,
        load_balance_type: "round",
        forward_addresses: [],
      },
    });
    return tunnel;
  }

  const event = (id: number) => ({
    events: [
      {
        kind: "service",
        service: `tcp-${id}`,
        type: "stats",
        stats: { totalConns: 1, currentConns: 0, inputBytes: 1024 * 1024 * 1024, outputBytes: 0, totalErrs: 0 },
      },
    ],
  });

  it("bills traffic without node_id and leaves per-node stats empty", async () => {
    const tunnel = await seed();
    const response = await request("POST", "/tunnel/observer", event(tunnel.id));
    expect(response.status).toBe(200);
    expect((await db.tunnel.findUniqueOrThrow({ where: { id: tunnel.id } })).traffic).toBe(1);
    expect(await client.keys("tunnel:node_stats:*")).toEqual([]);
  });

  it("records per-node stats when the agent sends node_id", async () => {
    const tunnel = await seed();
    const response = await request("POST", "/tunnel/observer?node_id=42", event(tunnel.id));
    expect(response.status).toBe(200);
    expect((await client.keys("tunnel:node_stats:*")).length).toBe(1);
  });
});
