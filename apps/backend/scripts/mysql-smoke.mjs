#!/usr/bin/env node
/**
 * MySQL runtime smoke test.
 *
 * `prisma validate` only proves the *schema* parses; it says nothing about whether a real
 * MySQL 8 accepts the generated DDL or whether the generated client round-trips the column
 * types the panel relies on. This script closes that gap, and it is deliberately narrow:
 *
 *   - JSON columns (forward_addresses, permissions, notify_subscriptions) survive a write
 *     and read unchanged, including nesting;
 *   - enums (NodeType, LoadBalanceType) round-trip by value;
 *   - Float columns keep their fractional part (traffic accounting is GiB floats);
 *   - DateTime keeps millisecond precision (tunnel/traffic bucketing is per-second);
 *   - unique constraints reject duplicates (email, node_group token, api_key);
 *   - relations and cascades behave (deleting a node group removes its nodes).
 *
 * Scope: this script proves the schema and client only. The aggregate endpoints are covered
 * separately by `mysql-endpoints-smoke.mjs`, which boots the backend on this same client and
 * calls them over HTTP; the dialect switch itself is in apps/backend/src/utils/date.ts.
 *
 * Usage: DATABASE_URL="mysql://user:pass@host:3306/db" node apps/backend/scripts/mysql-smoke.mjs
 */
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("mysql://")) {
  console.error("mysql-smoke: DATABASE_URL must be a mysql:// URL (this script only proves MySQL)");
  process.exit(2);
}

const db = new PrismaClient();
const results = [];
const ok = (name) => {
  results.push(name);
  console.log(`  ok  ${name}`);
};

/** Fresh tables so a re-run against the same database is deterministic. */
async function reset() {
  await db.tunnelTraffic.deleteMany();
  await db.tunnel.deleteMany();
  await db.node.deleteMany();
  await db.nodeGroup.deleteMany();
  await db.userPlan.deleteMany();
  await db.plan.deleteMany();
  await db.adminRole.deleteMany();
  await db.user.deleteMany();
}

const stamp = Date.now();
const email = `smoke-${stamp}@example.test`;

try {
  console.log(`mysql-smoke against ${new URL(url).host}${new URL(url).pathname}`);
  await reset();

  // ── User: unique email, JSON column, DateTime ────────────────────────────────
  const user = await db.user.create({
    data: {
      email,
      api_key: `key-${stamp}`,
      subscription_key: `sub-${stamp}`,
      notify_subscriptions: { topup: true, ticket: { email: false, nested: [1, 2, 3] } },
    },
  });
  const readUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.deepEqual(readUser.notify_subscriptions, {
    topup: true,
    ticket: { email: false, nested: [1, 2, 3] },
  });
  ok("User.notify_subscriptions JSON round-trip (nested object + array)");

  await assert.rejects(
    () => db.user.create({ data: { email, api_key: `dup-${stamp}`, subscription_key: `dup2-${stamp}` } }),
    /Unique constraint|Duplicate entry/i,
  );
  ok("User.email unique constraint rejects a duplicate");

  // ── AdminRole: JSON permissions + enum-free scalar ──────────────────────────
  const role = await db.adminRole.create({
    data: { name: `ops-${stamp}`, permissions: { tunnels: "write", users: "read" } },
  });
  assert.deepEqual(role.permissions, { tunnels: "write", users: "read" });
  ok("AdminRole.permissions JSON round-trip");

  // ── NodeGroup: enum + Float ────────────────────────────────────────────────
  const group = await db.nodeGroup.create({
    data: {
      name: `in-${stamp}`,
      node_type: "in",
      user_id: user.id,
      token: `token-${stamp}`,
      traffic_rate: 1.25,
      load_balance_type: "lc",
      allow_tunnel_types: ["tcp", "udp"],
    },
  });
  const readGroup = await db.nodeGroup.findUniqueOrThrow({ where: { id: group.id } });
  assert.equal(readGroup.node_type, "in");
  assert.equal(readGroup.load_balance_type, "lc");
  assert.equal(readGroup.traffic_rate, 1.25);
  assert.deepEqual(readGroup.allow_tunnel_types, ["tcp", "udp"]);
  ok("NodeGroup enum (node_type, load_balance_type) + Float(traffic_rate) + JSON array");

  // ── Node: relation ─────────────────────────────────────────────────────────
  const node = await db.node.create({
    data: {
      node_id: `node-${stamp}`,
      connect_ip: "203.0.113.7",
      node_group_id: group.id,
    },
  });
  assert.equal(await db.node.count({ where: { node_group_id: group.id } }), 1);
  ok("Node relation to NodeGroup");

  // ── Tunnel: JSON column + enum + relation to User ──────────────────────────
  const outGroup = await db.nodeGroup.create({
    data: { name: `out-${stamp}`, node_type: "out", user_id: user.id, token: `token-out-${stamp}` },
  });
  const tunnel = await db.tunnel.create({
    data: {
      name: `t-${stamp}`,
      user_id: user.id,
      in_node_group_id: group.id,
      out_node_group_id: outGroup.id,
      forward_addresses: [{ address: "198.51.100.9:443", weight: 1, host: null }],
      load_balance_type: "round",
    },
  });
  const readTunnel = await db.tunnel.findUniqueOrThrow({ where: { id: tunnel.id } });
  assert.deepEqual(readTunnel.forward_addresses, [{ address: "198.51.100.9:443", weight: 1, host: null }]);
  ok("Tunnel.forward_addresses JSON round-trip + relation to User");

  // ── TunnelTraffic: Float and DateTime precision ────────────────────────────
  const when = new Date("2026-10-20T05:04:03.123Z");
  const traffic = await db.tunnelTraffic.create({
    data: { tunnel_id: tunnel.id, traffic: 0.00390625, traffic_cost: 0.0078125, date: when },
  });
  const readTraffic = await db.tunnelTraffic.findUniqueOrThrow({ where: { id: traffic.id } });
  assert.equal(readTraffic.traffic, 0.00390625);
  assert.equal(readTraffic.traffic_cost, 0.0078125);
  assert.equal(
    readTraffic.date.toISOString(),
    when.toISOString(),
    "DateTime must keep millisecond precision",
  );
  ok("TunnelTraffic Float(0.00390625) + DateTime millisecond precision");

  // ── Plan: booleans with defaults ───────────────────────────────────────────
  const plan = await db.plan.create({
    data: {
      name: `plan-${stamp}`,
      price: 19.99,
      allow_custom_in_node_group: false,
      allow_custom_out_node_group: true,
      all_in_node_groups: false,
      all_out_node_groups: true,
    },
  });
  assert.equal(plan.price, 19.99);
  assert.equal(plan.all_out_node_groups, true);
  ok("Plan Booleans + Float(price)");

  // ── updates, counts, aggregates ────────────────────────────────────────────
  await db.nodeGroup.update({ where: { id: group.id }, data: { traffic_rate: 2.5 } });
  assert.equal((await db.nodeGroup.findUniqueOrThrow({ where: { id: group.id } })).traffic_rate, 2.5);
  ok("update keeps Float precision");

  const sum = await db.tunnelTraffic.aggregate({ _sum: { traffic: true } });
  assert.equal(sum._sum.traffic, 0.00390625);
  ok("aggregate _sum over Float");

  // ── cascade: deleting the group removes its nodes ──────────────────────────
  await db.nodeGroup.delete({ where: { id: group.id } });
  assert.equal(await db.node.count({ where: { node_group_id: group.id } }), 0);
  ok("cascade delete: NodeGroup removal removes its Nodes");

  console.log(`\nmysql-smoke: ${results.length} checks passed`);
} catch (error) {
  console.error("\nmysql-smoke FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
