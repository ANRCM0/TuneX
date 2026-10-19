#!/usr/bin/env tsx
/**
 * Deterministic fixtures for the live agent E2E (`scripts/e2e-local.sh`).
 *
 * The panel only exports a tunnel to an agent when every gate in
 * `apps/backend/src/services/tunnel.ts` passes:
 *
 *   - the node-group token is valid and the group is `node_type = in`;
 *   - the node-group owner has an unexpired `UserPlan` whose plan allows the
 *     in/out node groups and custom group selection (`all_*_node_groups` or
 *     `allow_custom_*_node_group`), otherwise `filterAvailableTunnels`
 *     (tunnel.ts:915) silently drops the tunnel and the agent receives
 *     `0 service(s)`;
 *   - `allow_listen_protocol` is true when the tunnel carries a custom
 *     `listen_protocol`.
 *
 * `setup` creates that minimal world idempotently: an `e2e-plan`, its
 * `UserPlan` for the super admin, the in node group keyed by `E2E_TOKEN`, and
 * one TCP port-forward tunnel. It must run after `pnpm seed` (the seed creates
 * the admin).
 *
 * `traffic` prints the tunnel/user-plan counters as JSON so the shell harness
 * can assert that the observer path actually increments them.
 *
 * Usage (from apps/backend, so `@prisma/client` resolves):
 *
 *   DATABASE_URL="file:./e2e.db" pnpm exec tsx scripts/e2e-fixtures.ts setup
 *   DATABASE_URL="file:./e2e.db" pnpm exec tsx scripts/e2e-fixtures.ts traffic
 *
 * Environment:
 *   DATABASE_URL      Prisma datasource (required; relative paths resolve
 *                     against apps/backend/prisma, like the app)
 *   E2E_TOKEN         node-group token (default `e2e-node-group-token`)
 *   E2E_LISTEN_PORT   tunnel listen port (default 18080)
 *   E2E_ECHO_PORT     forward target port on 127.0.0.1 (default 19081)
 */

import { PrismaClient } from "@prisma/client";

const DEFAULT_TOKEN = "e2e-node-group-token";
const DEFAULT_LISTEN_PORT = 18080;
const DEFAULT_ECHO_PORT = 19081;

const prisma = new PrismaClient();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function token(): string {
  return process.env.E2E_TOKEN || DEFAULT_TOKEN;
}

async function superAdmin() {
  const admin = await prisma.user.findFirst({ where: { super_admin: true } });
  if (!admin) {
    throw new Error(
      "no super admin in the database; run `pnpm seed` before the fixtures",
    );
  }
  return admin;
}

/**
 * A plan that unlocks the tunnel export gates. `price: 0` keeps it out of the
 * storefront; the super admin is the only user bound to it.
 */
async function ensurePlan() {
  const existing = await prisma.plan.findFirst({ where: { name: "e2e-plan" } });
  if (existing) return existing;
  return prisma.plan.create({
    data: {
      name: "e2e-plan",
      price: 0,
      allow_custom_in_node_group: true,
      allow_custom_out_node_group: true,
      all_in_node_groups: true,
      all_out_node_groups: true,
    },
  });
}

async function setup() {
  const admin = await superAdmin();
  const plan = await ensurePlan();
  await prisma.userPlan.upsert({
    where: { user_id: admin.id },
    update: { plan_id: plan.id, expired_at: new Date(Date.now() + 86_400_000) },
    create: {
      user_id: admin.id,
      plan_id: plan.id,
      expired_at: new Date(Date.now() + 86_400_000),
    },
  });

  const groupToken = token();
  const group = await prisma.nodeGroup.upsert({
    where: { token: groupToken },
    update: {
      name: "e2e-in",
      node_type: "in",
      user_id: admin.id,
      allow_listen_protocol: true,
    },
    create: {
      name: "e2e-in",
      token: groupToken,
      node_type: "in",
      user_id: admin.id,
      allow_listen_protocol: true,
    },
  });

  // Re-runs start from zero so the traffic assertion is exact.
  await prisma.tunnel.deleteMany({ where: { in_node_group_id: group.id } });
  const listenPort = intEnv("E2E_LISTEN_PORT", DEFAULT_LISTEN_PORT);
  const echoPort = intEnv("E2E_ECHO_PORT", DEFAULT_ECHO_PORT);
  const tunnel = await prisma.tunnel.create({
    data: {
      name: "e2e-tcp",
      tunnel_type: "tcp",
      category: "port_forward",
      listen_ip: "127.0.0.1",
      listen_port: listenPort,
      forward_addresses: [{ address: `127.0.0.1:${echoPort}`, weight: 1 }],
      load_balance_type: "round",
      in_node_group_id: group.id,
      user_id: admin.id,
      traffic: 0,
      traffic_cost: 0,
    },
  });

  console.log(
    JSON.stringify({
      admin_id: admin.id,
      api_key: admin.api_key,
      plan_id: plan.id,
      group_id: group.id,
      tunnel_id: tunnel.id,
      token: groupToken,
      listen_port: listenPort,
      echo_port: echoPort,
    }),
  );
}

async function traffic() {
  const group = await prisma.nodeGroup.findUnique({
    where: { token: token() },
  });
  if (!group) throw new Error(`node group ${token()} not found`);
  const tunnel = await prisma.tunnel.findFirst({
    where: { in_node_group_id: group.id },
    orderBy: { id: "desc" },
  });
  if (!tunnel) throw new Error("no tunnel in the e2e node group");
  const userPlan = await prisma.userPlan.findFirst({
    where: { user_id: tunnel.user_id },
  });
  console.log(
    JSON.stringify({
      tunnel_id: tunnel.id,
      traffic: tunnel.traffic,
      traffic_cost: tunnel.traffic_cost,
      user_plan_traffic_used: userPlan?.traffic_used ?? 0,
    }),
  );
}

const command = process.argv[2];
try {
  if (command === "setup") {
    await setup();
  } else if (command === "traffic") {
    await traffic();
  } else {
    throw new Error(`unknown command ${command ?? "(none)"}; use setup|traffic`);
  }
} finally {
  await prisma.$disconnect();
}
