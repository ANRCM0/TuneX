#!/usr/bin/env node
/**
 * MySQL HTTP smoke for the aggregate endpoints.
 *
 * `mysql-smoke.mjs` proves the schema and the generated client; `tests/unit/*` proves the SQL
 * the routes build. Neither proves the panel answers on MySQL, which is what this script does:
 * it seeds a real MySQL database with instants on both sides of a Shanghai midnight, boots the
 * backend in-process (tsx) against that database, and calls every endpoint whose SQL used to be
 * SQLite dialect:
 *
 *   GET /admin/stats                                   counts by status / node type
 *   GET /admin/stats/user?aggregate_by=day|month|year   DATE_FORMAT buckets + text bounds
 *   GET /admin/stats/traffic                           joined traffic buckets
 *   GET /admin/plan/stats                              plan dashboard
 *   GET /admin/topup/stats                             top-up dashboard (success only)
 *   GET /tunnel/traffic/stats                          user traffic buckets
 *   GET /user/referral/stats                           referral counts + commission earnings
 *
 * The dated requests pass explicit bounds and assert exact bucketed values, so a wrong
 * timezone or a truncation difference fails here. The undated requests (one per router) are
 * the ones that exercise the `NOW() - INTERVAL n DAY` equivalents — a MySQL syntax error in
 * `localNowMinusDays` / `utcNowMinusDays` shows up there and nowhere else.
 *
 * Auth: the seeded super admin gets a fixed, deliberately non-UUID API key. `authRequired`
 * only consults the license server for UUID-shaped bearer tokens, and CI has no license
 * server; a non-UUID key keeps the smoke focused on SQL.
 *
 * Redis is empty, so the "today" merge in the traffic endpoints contributes zero/absent rows;
 * the fixture range is in 2024, so those branches stay out of the assertions.
 *
 * Usage (CI does this for you):
 *   DATABASE_URL="mysql://user:pass@host:3306/db" node apps/backend/scripts/mysql-endpoints-smoke.mjs
 * Requires a client generated from apps/backend/prisma/mysql/schema.prisma.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("mysql://")) {
  console.error("mysql-endpoints-smoke: DATABASE_URL must be a mysql:// URL (this script only proves MySQL)");
  process.exit(2);
}

const PORT = Number.parseInt(process.env.MYSQL_SMOKE_PORT ?? "3311", 10);
const BASE = `http://127.0.0.1:${PORT}`;
/** Non-UUID on purpose: see the header. */
const API_KEY = "ci-mysql-stats-key";
const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));

const db = new PrismaClient();
let child = null;
const childLog = [];

const log = (message) => console.log(`  ok  ${message}`);

/** Shanghai midnight rollover: 23:59:59 +08 vs 00:00:00 +08 on the next day. */
const LAST_SECOND_2024 = new Date("2024-12-31T15:59:59.000Z");
const FIRST_SECOND_2025 = new Date("2024-12-31T16:00:00.000Z");
const RANGE = "start_date=2024-12-31&end_date=2025-01-02";

/** Delete every row this script and `mysql-smoke.mjs` can create, in FK-safe order. */
async function reset() {
  // The user table references itself (`parent_id`); break the edges before deleting rows.
  await db.user.updateMany({ data: { parent_id: null } });
  await db.tunnelChain.deleteMany();
  await db.tunnelTraffic.deleteMany();
  await db.tunnel.deleteMany();
  await db.node.deleteMany();
  await db.inNodeGroupDNS.deleteMany();
  await db.dnsProvider.deleteMany();
  await db.planNodeGroup.deleteMany();
  await db.nodeGroup.deleteMany();
  await db.commissionLog.deleteMany();
  await db.balanceLog.deleteMany();
  await db.planOrder.deleteMany();
  await db.topupOrder.deleteMany();
  await db.userPlan.deleteMany();
  await db.withdrawRequest.deleteMany();
  await db.ticketReply.deleteMany();
  await db.ticket.deleteMany();
  await db.payment.deleteMany();
  await db.planCoupon.deleteMany();
  await db.plan.deleteMany();
  await db.topupActivity.deleteMany();
  await db.adminRole.deleteMany();
  await db.user.deleteMany();
}

async function seed() {
  const admin = await db.user.create({
    data: {
      email: "mysql-endpoints-admin@example.test",
      api_key: API_KEY,
      subscription_key: "mysql-endpoints-admin-sub",
      super_admin: true,
      status: "active",
      created_at: LAST_SECOND_2024,
    },
  });
  await db.user.create({
    data: {
      email: "mysql-endpoints-child-a@example.test",
      parent_id: admin.id,
      created_at: LAST_SECOND_2024,
    },
  });
  await db.user.create({
    data: {
      email: "mysql-endpoints-child-b@example.test",
      parent_id: admin.id,
      created_at: FIRST_SECOND_2025,
    },
  });

  const inGroup = await db.nodeGroup.create({
    data: { name: "mysql-endpoints-in", node_type: "in", user_id: admin.id },
  });
  const outGroup = await db.nodeGroup.create({
    data: { name: "mysql-endpoints-out", node_type: "out", user_id: admin.id },
  });

  const tunnel = await db.tunnel.create({
    data: {
      name: "mysql-endpoints-tunnel",
      forward_addresses: [],
      load_balance_type: "round",
      user_id: admin.id,
      in_node_group_id: inGroup.id,
      out_node_group_id: outGroup.id,
    },
  });

  await db.tunnelTraffic.create({
    data: { tunnel_id: tunnel.id, traffic: 1.5, traffic_cost: 0.25, date: LAST_SECOND_2024 },
  });
  await db.tunnelTraffic.create({
    data: { tunnel_id: tunnel.id, traffic: 2.5, traffic_cost: 0.75, date: FIRST_SECOND_2025 },
  });

  const plan = await db.plan.create({
    data: {
      name: "mysql-endpoints-plan",
      price: 10,
      allow_custom_in_node_group: false,
      allow_custom_out_node_group: false,
      all_in_node_groups: false,
      all_out_node_groups: false,
    },
  });
  await db.planOrder.create({
    data: { user_id: admin.id, plan_id: plan.id, price: 10, balance: 0, created_at: LAST_SECOND_2024 },
  });
  await db.planOrder.create({
    data: { user_id: admin.id, plan_id: plan.id, price: 20, balance: 0, created_at: FIRST_SECOND_2025 },
  });

  const payment = await db.payment.create({
    data: { name: "mysql-endpoints-pay", url: "https://pay.example.test", config: {}, method: "epay" },
  });
  for (const [order_id, price, status, created_at] of [
    ["MYSQL-SMOKE-1", 5, "success", LAST_SECOND_2024],
    ["MYSQL-SMOKE-2", 5, "success", FIRST_SECOND_2025],
    // Must be filtered out by `status = 'success'`.
    ["MYSQL-SMOKE-3", 100, "pending", FIRST_SECOND_2025],
  ]) {
    await db.topupOrder.create({
      data: {
        user_id: admin.id,
        payment_id: payment.id,
        price,
        pay_url: "https://pay.example.test/order",
        order_id,
        status,
        created_at,
      },
    });
  }

  for (const [amount, type, created_at] of [
    [3, "referral", LAST_SECOND_2024],
    [4.5, "referral", FIRST_SECOND_2025],
    // Must be filtered out by `type = 'referral'`.
    [100, "transfer", FIRST_SECOND_2025],
  ]) {
    await db.commissionLog.create({
      data: { user_id: admin.id, balance: 0, amount, type, created_at },
    });
  }

  return admin;
}

/** Numeric-tolerant series assertion: rows must come back in date order, values must match. */
function expectSeries(label, body, expected) {
  assert.ok(Array.isArray(body), `${label}: expected an array, got ${JSON.stringify(body)}`);
  assert.equal(body.length, expected.length, `${label}: ${JSON.stringify(body)}`);
  expected.forEach((want, index) => {
    const got = body[index];
    assert.ok(got && typeof got === "object", `${label}[${index}]: ${JSON.stringify(got)}`);
    for (const [key, value] of Object.entries(want)) {
      if (typeof value === "number") {
        assert.ok(
          Math.abs(Number(got[key]) - value) < 1e-9,
          `${label}[${index}].${key}: got ${got[key]}, want ${value}`,
        );
      } else {
        assert.equal(got[key], value, `${label}[${index}].${key}: got ${got[key]}, want ${value}`);
      }
    }
  });
}

const countBy = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row.count]));

async function get(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${path} -> ${response.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`GET ${path}: response is not JSON: ${text.slice(0, 400)}`);
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited with ${child.exitCode} before /health was ready`);
    }
    let body = null;
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) {
        body = await response.json();
      }
    } catch {
      // not listening yet
    }
    if (body) {
      // Outside the try/catch above: a "db: error" result must fail loudly, not be retried.
      if (body.checks?.db !== "ok") {
        throw new Error(`backend cannot query MySQL: ${JSON.stringify(body)}`);
      }
      return;
    }
    await sleep(250);
  }
  throw new Error("backend did not answer /health within 60s");
}

function startBackend() {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      // `test` keeps the development CONFIG_SECRET fallback and disables Sentry; the MySQL
      // URL is inherited and is what selects the dialect in utils/date.ts.
      NODE_ENV: "test",
      AUTH_MODE: "local",
      PORT: String(PORT),
      SITE_URL: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) childLog.push(line.trim());
      }
      if (childLog.length > 400) childLog.splice(0, childLog.length - 400);
    });
  }
}

async function stopBackend() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2000)]);
  }
}

try {
  console.log(`mysql-endpoints-smoke against ${new URL(url).host}${new URL(url).pathname}`);

  await reset();
  await seed();
  log("seeded users, node groups, tunnel traffic, plan/top-up orders, referrals");

  startBackend();
  await waitForHealth();
  log(`backend answered /health on ${BASE} with db=ok`);

  // ── Overview: no date SQL, proves the MySQL client + groupBy paths ─────────────
  const overview = await get("/admin/stats");
  assert.deepEqual(countBy(overview.user, "status"), { active: 3 }, "/admin/stats user");
  assert.deepEqual(countBy(overview.node_group, "node_type"), { in: 1, out: 1 }, "/admin/stats groups");
  assert.deepEqual(countBy(overview.tunnel, "status"), { active: 1 }, "/admin/stats tunnels");
  assert.deepEqual(
    countBy(overview.topup_order, "status"),
    { pending: 1, success: 2 },
    "/admin/stats topups",
  );
  assert.deepEqual(overview.node, [], "/admin/stats nodes");
  log("/admin/stats counts by status");

  // ── Bucketed user counts: day / month / year, both sides of Shanghai midnight ──
  expectSeries("/admin/stats/user day", await get(`/admin/stats/user?aggregate_by=day&${RANGE}`), [
    { date: "2024-12-31", total: 2 },
    { date: "2025-01-01", total: 1 },
  ]);
  expectSeries("/admin/stats/user month", await get(`/admin/stats/user?aggregate_by=month&${RANGE}`), [
    { date: "2024-12", total: 2 },
    { date: "2025-01", total: 1 },
  ]);
  expectSeries("/admin/stats/user year", await get(`/admin/stats/user?aggregate_by=year&${RANGE}`), [
    { date: "2024", total: 2 },
    { date: "2025", total: 1 },
  ]);
  log("/admin/stats/user buckets day/month/year in Asia/Shanghai");

  // ── Joined traffic buckets, day and month ─────────────────────────────────────
  expectSeries("/admin/stats/traffic day", await get(`/admin/stats/traffic?aggregate_by=day&${RANGE}`), [
    { date: "2024-12-31", traffic: 1.5, traffic_cost: 0.25 },
    { date: "2025-01-01", traffic: 2.5, traffic_cost: 0.75 },
  ]);
  expectSeries("/admin/stats/traffic month", await get(`/admin/stats/traffic?aggregate_by=month&${RANGE}`), [
    { date: "2024-12", traffic: 1.5, traffic_cost: 0.25 },
    { date: "2025-01", traffic: 2.5, traffic_cost: 0.75 },
  ]);
  log("/admin/stats/traffic buckets the joined tunnel_traffic rows");

  // ── Plan dashboard: explicit bounds, then the implicit NOW() - INTERVAL bound ──
  expectSeries("/admin/plan/stats", await get(`/admin/plan/stats?${RANGE}`), [
    { date: "2024-12-31", total: 10 },
    { date: "2025-01-01", total: 20 },
  ]);
  expectSeries("/admin/plan/stats (implicit window)", await get("/admin/plan/stats"), []);
  log("/admin/plan/stats sums by day; the undated window is valid SQL on MySQL");

  // ── Top-up dashboard: success only, then the implicit bound ────────────────────
  expectSeries("/admin/topup/stats", await get(`/admin/topup/stats?${RANGE}`), [
    { date: "2024-12-31", total: 5 },
    { date: "2025-01-01", total: 5 },
  ]);
  expectSeries("/admin/topup/stats (implicit window)", await get("/admin/topup/stats"), []);
  log("/admin/topup/stats excludes pending orders and accepts the undated window");

  // ── User-scoped tunnel traffic ────────────────────────────────────────────────
  expectSeries("/tunnel/traffic/stats", await get(`/tunnel/traffic/stats?aggregate_by=day&${RANGE}`), [
    { date: "2024-12-31", traffic: 1.5, traffic_cost: 0.25 },
    { date: "2025-01-01", traffic: 2.5, traffic_cost: 0.75 },
  ]);
  const undatedTunnel = await get("/tunnel/traffic/stats?aggregate_by=day");
  assert.ok(Array.isArray(undatedTunnel), "undated /tunnel/traffic/stats must return an array");
  log("/tunnel/traffic/stats buckets the caller's tunnels, dated and undated");

  // ── Referral dashboard: counts from `user`, earnings from `commission_log` ─────
  expectSeries("/user/referral/stats", await get(`/user/referral/stats?${RANGE}`), [
    { date: "2024-12-31", referral_count: 1, earnings: 3 },
    { date: "2025-01-01", referral_count: 1, earnings: 4.5 },
  ]);
  expectSeries("/user/referral/stats (implicit window)", await get("/user/referral/stats"), []);
  log("/user/referral/stats merges referrals and referral commissions");

  // ── The parameterised stats-service bounds (no interpolation) ─────────────────
  expectSeries("/admin/stats/user (implicit window)", await get("/admin/stats/user"), []);
  log("/admin/stats/user binds its bounds as parameters on MySQL");

  console.log("\nmysql-endpoints-smoke: all aggregate endpoints answered on MySQL");
  await stopBackend();
  await db.$disconnect();
} catch (error) {
  console.error(`\nmysql-endpoints-smoke FAILED: ${error?.stack ?? error}`);
  if (childLog.length > 0) {
    console.error("\n--- backend log (tail) ---");
    console.error(childLog.slice(-80).join("\n"));
  }
  await stopBackend();
  await db.$disconnect().catch(() => {});
  process.exitCode = 1;
}
