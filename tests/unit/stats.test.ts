/**
 * `StatsService` aggregates against a throwaway SQLite database.
 *
 * The panel's admin dashboard reads three queries: `getOverview` (counts by status),
 * `getUserStats` (new users bucketed in Asia/Shanghai) and `getTrafficStats` (tunnel
 * traffic buckets plus today's live Redis counters). The date bucketing of the last two
 * depends on the fragments in `utils/date.ts` — this suite runs on SQLite, so it exercises
 * the `datetime(... '/1000', 'unixepoch', '+8 hours')` branch; the fixtures use instants
 * around a Shanghai midnight. `apps/backend/scripts/mysql-endpoints-smoke.mjs` runs the same
 * endpoints on the MySQL branch in CI.
 *
 * Redis is stubbed: the live-today path is the only Redis dependency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { StatsService } from "../../apps/backend/src/services/stats";

const temp: TempDatabase = createTempDatabase("stats");

let db: PrismaClient;
let service: StatsService;

let userSeq = 0;
let groupSeq = 0;

const redisValues: { traffic: Record<string, string>; cost: Record<string, string> } = {
  traffic: {},
  cost: {},
};

async function makeUser(status: "active" | "inactive" = "active", createdAt?: Date) {
  userSeq += 1;
  return db.user.create({
    data: {
      email: `stats-user-${userSeq}@example.test`,
      status,
      ...(createdAt ? { created_at: createdAt } : {}),
    },
  });
}

async function makeGroup(nodeType: "in" | "out", userId?: number) {
  groupSeq += 1;
  const owner = userId ?? (await makeUser()).id;
  return db.nodeGroup.create({ data: { name: `group-${groupSeq}`, node_type: nodeType, user_id: owner } });
}

async function makeTunnel(userId: number, inGroupId: number, overrides: Record<string, unknown> = {}) {
  return db.tunnel.create({
    data: {
      name: `tunnel-${Math.random().toString(36).slice(2, 8)}`,
      forward_addresses: [],
      load_balance_type: "round",
      user_id: userId,
      in_node_group_id: inGroupId,
      ...overrides,
    } as never,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { StatsService: Service } = await import("../../apps/backend/src/services/stats");
  service = new Service({
    getTunnelTraffic: async (cost: boolean) => (cost ? redisValues.cost : redisValues.traffic),
  } as never);
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

describe("getOverview", () => {
  it("counts every entity by its status or type", async () => {
    await db.topupOrder.deleteMany();
    await db.tunnel.deleteMany();
    await db.user.deleteMany();
    await db.nodeGroup.deleteMany();

    const owner = await makeUser("inactive");
    const inGroup = await makeGroup("in", owner.id);
    const outGroup = await makeGroup("out", owner.id);
    await makeUser("active");
    await makeUser("active");
    const inactive = owner;
    await makeTunnel(inactive.id, inGroup.id, { status: "active" });
    await makeTunnel(inactive.id, inGroup.id, { status: "active" });
    await makeTunnel(inactive.id, inGroup.id, { status: "inactive" });

    const payment = await db.payment.create({
      data: { name: "p", url: "https://pay.example.test", config: {}, method: "epay" },
    });
    await db.topupOrder.create({
      data: { user_id: inactive.id, payment_id: payment.id, price: 10, pay_url: "u", order_id: "S-1" },
    });
    await db.topupOrder.create({
      data: {
        user_id: inactive.id,
        payment_id: payment.id,
        price: 10,
        pay_url: "u",
        order_id: "S-2",
        status: "success",
      },
    });

    const overview = await service.getOverview();
    const sorted = (rows: { count: number }[]) => rows.map((r) => r.count).sort((a, b) => a - b);
    expect(sorted(overview.user)).toEqual([1, 2]);
    expect(overview.node_group.map((g) => g.node_type).sort()).toEqual(["in", "out"]);
    expect(sorted(overview.tunnel)).toEqual([1, 2]);
    expect(sorted(overview.topup_order)).toEqual([1, 1]);
    expect(overview.node).toEqual([]);
  });
});

describe("getUserStats", () => {
  // 2024-12-31T15:59:59Z is 2024-12-31 23:59:59 in Asia/Shanghai;
  // 2024-12-31T16:00:00Z is 2025-01-01 00:00:00 there.
  const beforeMidnight = new Date("2024-12-31T15:59:59Z");
  const afterMidnight = new Date("2024-12-31T16:00:00Z");

  beforeAll(async () => {
    await makeUser("active", beforeMidnight);
    await makeUser("active", beforeMidnight);
    await makeUser("active", afterMidnight);
  });

  it("buckets by Shanghai day", async () => {
    const rows = await service.getUserStats({
      start_date: new Date("2024-12-30T00:00:00Z"),
      end_date: new Date("2025-01-03T23:59:59Z"),
      aggregate_by: "day",
    });
    const byDate = Object.fromEntries(rows.map((row) => [row.date, row.total]));
    expect(byDate["2024-12-31"]).toBe(2);
    expect(byDate["2025-01-01"]).toBe(1);
  });

  it("buckets by month and year in local time", async () => {
    const months = await service.getUserStats({
      start_date: new Date("2024-12-30T00:00:00Z"),
      end_date: new Date("2025-01-03T23:59:59Z"),
      aggregate_by: "month",
    });
    const byMonth = Object.fromEntries(months.map((row) => [row.date, row.total]));
    expect(byMonth["2024-12"]).toBe(2);
    expect(byMonth["2025-01"]).toBe(1);

    const years = await service.getUserStats({
      start_date: new Date("2024-12-30T00:00:00Z"),
      end_date: new Date("2025-01-03T23:59:59Z"),
      aggregate_by: "year",
    });
    const byYear = Object.fromEntries(years.map((row) => [row.date, row.total]));
    expect(byYear["2024"]).toBe(2);
    expect(byYear["2025"]).toBe(1);
  });
});

describe("getTrafficStats", () => {
  let tunnelId = 0;
  let otherTunnelId = 0;
  let inGroupId = 0;
  let otherGroupId = 0;

  beforeAll(async () => {
    await db.tunnelTraffic.deleteMany();
    const user = await makeUser();
    inGroupId = (await makeGroup("in")).id;
    otherGroupId = (await makeGroup("in")).id;
    tunnelId = (await makeTunnel(user.id, inGroupId)).id;
    otherTunnelId = (await makeTunnel(user.id, otherGroupId)).id;

    await db.tunnelTraffic.createMany({
      data: [
        { tunnel_id: tunnelId, traffic: 1.5, traffic_cost: 1.2, date: new Date("2025-01-01T04:00:00Z") },
        { tunnel_id: tunnelId, traffic: 2.5, traffic_cost: 2.0, date: new Date("2025-01-02T04:00:00Z") },
        { tunnel_id: otherTunnelId, traffic: 10, traffic_cost: 9, date: new Date("2025-01-03T04:00:00Z") },
      ],
    });
  });

  it("sums traffic and cost per day", async () => {
    const rows = await service.getTrafficStats({
      start_date: new Date("2024-12-31T00:00:00Z"),
      end_date: new Date("2025-01-04T23:59:59Z"),
      aggregate_by: "day",
    });
    const byDate = Object.fromEntries(rows.map((row) => [row.date, row]));
    expect(byDate["2025-01-01"]).toMatchObject({ traffic: 1.5, traffic_cost: 1.2 });
    expect(byDate["2025-01-02"]).toMatchObject({ traffic: 2.5, traffic_cost: 2 });
    expect(byDate["2025-01-03"]).toMatchObject({ traffic: 10, traffic_cost: 9 });
  });

  it("filters by in-node-group", async () => {
    const rows = await service.getTrafficStats({
      start_date: new Date("2024-12-31T00:00:00Z"),
      end_date: new Date("2025-01-04T23:59:59Z"),
      aggregate_by: "day",
      in_node_group_id: inGroupId,
    });
    expect(rows.map((row) => row.date).sort()).toEqual(["2025-01-01", "2025-01-02"]);
  });

  it("appends today's live Redis counters for the day bucket", async () => {
    redisValues.traffic = { "1": "10", "2": "5" };
    redisValues.cost = { "1": "1", "2": "0.5" };

    const rows = await service.getTrafficStats({ aggregate_by: "day" });
    const last = rows[rows.length - 1];
    expect(last.traffic).toBe(15);
    expect(last.traffic_cost).toBe(1.5);

    redisValues.traffic = {};
    redisValues.cost = {};
  });

  it("does not append live traffic for month buckets", async () => {
    redisValues.traffic = { "1": "10" };
    redisValues.cost = { "1": "1" };
    const rows = await service.getTrafficStats({ aggregate_by: "month" });
    expect(rows.every((row) => row.date.length === 7)).toBe(true);
    redisValues.traffic = {};
    redisValues.cost = {};
  });
});
