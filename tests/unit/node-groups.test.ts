/**
 * Node and node-group services against a throwaway SQLite database.
 *
 * These are the admin-side building blocks for the tunnel topology: group creation and
 * port-range validation, the plan-based visibility rule (`getUserNodeGroups`) that every
 * tunnel check depends on, and the node checks/cascade delete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { NodeGroupService } from "../../apps/backend/src/services/node_group";
import type { NodeService } from "../../apps/backend/src/services/node";

const temp: TempDatabase = createTempDatabase("node-groups");

let db: PrismaClient;
let groups: NodeGroupService;
let nodes: NodeService;
let ownerId = 0;
let outsiderId = 0;
let planId = 0;

const redisCalls: string[] = [];
const redisSysinfo = new Map<string, { last_active: string }>();
let dnsCalls = 0;

async function makePlan(overrides: Record<string, unknown> = {}) {
  return db.plan.create({
    data: {
      name: "plan",
      price: 0,
      allow_custom_in_node_group: false,
      allow_custom_out_node_group: false,
      all_in_node_groups: false,
      all_out_node_groups: false,
      ...overrides,
    } as never,
  });
}

async function makeGroup(userId: number, nodeType: "in" | "out", overrides: Record<string, unknown> = {}) {
  return db.nodeGroup.create({
    data: {
      name: `${nodeType}-${Math.random().toString(36).slice(2, 6)}`,
      node_type: nodeType,
      user_id: userId,
      ...overrides,
    } as never,
  });
}

async function subscribe(
  userId: number,
  plan: { id: number },
  options: { expiredAt?: Date | null; traffic?: number | null; used?: number } = {},
) {
  return db.userPlan.create({
    data: {
      user_id: userId,
      plan_id: plan.id,
      expired_at: options.expiredAt === undefined ? new Date(Date.now() + 86400_000) : options.expiredAt,
      traffic: options.traffic ?? null,
      traffic_used: options.used ?? 0,
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { NodeGroupService: Groups } = await import("../../apps/backend/src/services/node_group");
  const { NodeService: Nodes } = await import("../../apps/backend/src/services/node");
  groups = new Groups({} as never);
  nodes = new Nodes(
    {
      getNodeSysinfo: async (groupId: number, nodeId: number) =>
        redisSysinfo.get(`${groupId}:${nodeId}`) ?? null,
      delNodeSysinfo: async (groupId: number, nodeId: number) => {
        redisCalls.push(`del:${groupId}:${nodeId}`);
      },
    } as never,
    {
      nodeDnsRecords: async () => {
        dnsCalls += 1;
      },
    } as never,
  );

  const owner = await db.user.create({ data: { email: "owner@example.test" } });
  const outsider = await db.user.create({ data: { email: "outsider@example.test" } });
  ownerId = owner.id;
  outsiderId = outsider.id;
  planId = (await makePlan()).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.tunnelChain.deleteMany();
  await db.tunnel.deleteMany();
  await db.node.deleteMany();
  await db.planNodeGroup.deleteMany();
  await db.userPlan.deleteMany();
  await db.nodeGroup.deleteMany();
  redisCalls.length = 0;
  redisSysinfo.clear();
  dnsCalls = 0;
});

describe("checkPortRange", () => {
  it("accepts unset ranges", () => {
    expect(groups.checkPortRange(null)).toBeUndefined();
    expect(groups.checkPortRange("")).toBeUndefined();
  });

  it("parses lists and ranges", () => {
    expect(groups.checkPortRange("80,443", 443)).toBe(true);
    expect(groups.checkPortRange("80,443", 8080)).toBe(false);
    expect(groups.checkPortRange("1000-1005", 1003)).toBe(true);
    expect(groups.checkPortRange("1000-1005", 1006)).toBe(false);
    expect(groups.checkPortRange(" 80 , 90-92 ", 91)).toBe(true);
  });

  it("rejects malformed ranges", () => {
    expect(() => groups.checkPortRange("10-5")).toThrow();
    expect(() => groups.checkPortRange("abc,def")).toThrow();
    // A whitespace-only range parses to port 0 rather than failing (recovered quirk).
    expect(groups.checkPortRange(" ")).toBe(false);
  });
});

describe("createNodeGroup / updateNodeGroup", () => {
  it("creates a group with defaults and the next order_by", async () => {
    await groups.createNodeGroup(ownerId, {
      name: "g1",
      node_type: "in",
      load_balance_type: "round",
      connect_ip: "1.2.3.4",
      need_out_node_group: false,
      allow_tunnel_types: ["tcp"],
      bypass_list: ["10.0.0.0/8"],
    });
    await groups.createNodeGroup(ownerId, {
      name: "g2",
      node_type: "out",
      load_balance_type: "hash",
      need_out_node_group: false,
    });

    const rows = await db.nodeGroup.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "g1",
      node_type: "in",
      traffic_rate: 1,
      connect_ip: "1.2.3.4",
      order_by: 0,
      allow_tunnel_types: ["tcp"],
      bypass_list: ["10.0.0.0/8"],
      user_id: ownerId,
    });
    expect(rows[1].order_by).toBe(1000);
  });

  it("validates the port range before inserting", async () => {
    await expect(
      groups.createNodeGroup(ownerId, {
        name: "bad",
        node_type: "in",
        load_balance_type: "round",
        port_range: "10-5",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.nodeGroup.count()).toBe(0);
  });

  it("updates only the owner's group", async () => {
    const group = await makeGroup(ownerId, "in");
    await groups.updateNodeGroup(group.id, { name: "renamed", port_range: "1000-2000" }, ownerId);

    const after = await db.nodeGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(after.name).toBe("renamed");
    expect(after.port_range).toBe("1000-2000");

    await expect(groups.updateNodeGroup(group.id, { name: "hijack" }, outsiderId)).rejects.toBeTruthy();
    expect((await db.nodeGroup.findUniqueOrThrow({ where: { id: group.id } })).name).toBe("renamed");

    await groups.updateNodeGroupOrder(group.id, 9000, ownerId);
    expect((await db.nodeGroup.findUniqueOrThrow({ where: { id: group.id } })).order_by).toBe(9000);
  });
});

describe("getUserNodeGroups", () => {
  it("returns nothing without an active plan", async () => {
    await makeGroup(ownerId, "in");
    expect(await groups.getUserNodeGroups({ id: ownerId })).toEqual([]);

    const plan = await makePlan();
    await subscribe(ownerId, plan, { expiredAt: new Date(Date.now() - 1000) });
    expect(await groups.getUserNodeGroups({ id: ownerId })).toEqual([]);
  });

  it("returns nothing once the plan traffic is spent", async () => {
    const plan = await makePlan({ traffic: 100 });
    await subscribe(ownerId, plan, { traffic: 100, used: 100 });
    await makeGroup(ownerId, "in");
    expect(await groups.getUserNodeGroups({ id: ownerId })).toEqual([]);
  });

  it("shows every super-admin in-group when the plan covers all", async () => {
    const admin = await db.user.create({ data: { email: "admin@example.test", super_admin: true } });
    const adminGroup = await makeGroup(admin.id, "in");
    const otherGroup = await makeGroup(outsiderId, "in");
    const plan = await makePlan({ all_in_node_groups: true });
    await subscribe(ownerId, plan);

    const visible = await groups.getUserNodeGroups({ id: ownerId });
    expect(visible.map((g) => g.id)).toEqual([adminGroup.id]);
    expect(visible.map((g) => g.id)).not.toContain(otherGroup.id);
  });

  it("honours the plan's explicit node groups and custom groups", async () => {
    const listed = await makeGroup(outsiderId, "in");
    const unlisted = await makeGroup(outsiderId, "in");
    const own = await makeGroup(ownerId, "in");
    const plan = await makePlan({ allow_custom_in_node_group: true });
    await subscribe(ownerId, plan);
    await db.planNodeGroup.create({ data: { plan_id: plan.id, node_group_id: listed.id } });

    const visible = await groups.getUserNodeGroups({ id: ownerId });
    expect(visible.map((g) => g.id).sort()).toEqual([listed.id, own.id].sort());
    expect(visible.map((g) => g.id)).not.toContain(unlisted.id);
  });

  it("enforces the out-group allow-list in checkUserNodeGroup", async () => {
    const inGroup = await makeGroup(ownerId, "in", { allow_out_node_groups: [999] });
    const outGroup = await makeGroup(ownerId, "out");
    const plan = await makePlan({ allow_custom_in_node_group: true, allow_custom_out_node_group: true });
    await subscribe(ownerId, plan);

    await expect(groups.checkUserNodeGroup({ id: ownerId }, inGroup.id, outGroup.id)).rejects.toMatchObject({
      status: 403,
      message: "该入口节点组不允许使用此出口节点组",
    });

    await db.nodeGroup.update({ where: { id: inGroup.id }, data: { allow_out_node_groups: [outGroup.id] } });
    await expect(
      groups.checkUserNodeGroup({ id: ownerId }, inGroup.id, outGroup.id),
    ).resolves.toBeUndefined();

    await expect(groups.checkUserNodeGroup({ id: ownerId }, inGroup.id, 999999)).rejects.toMatchObject({
      status: 403,
      message: "节点组无权限",
    });
  });
});

describe("node service", () => {
  it("rejects a duplicate node id", async () => {
    const group = await makeGroup(ownerId, "in");
    await db.node.create({ data: { node_id: "n-1", connect_ip: "1.2.3.4", node_group_id: group.id } });

    await expect(nodes.checkNodeId("n-1")).rejects.toMatchObject({
      status: 400,
      message: "节点 ID 已存在",
    });
    await expect(nodes.checkNodeId("n-2")).resolves.toBeUndefined();
  });

  it("judges liveness from the last sysinfo sample", async () => {
    const group = await makeGroup(ownerId, "in");
    const node = await db.node.create({
      data: { node_id: "n-1", connect_ip: "1.2.3.4", node_group_id: group.id },
    });

    expect(await nodes.nodeIsAlive(group.id, node.id)).toBe(false);

    redisSysinfo.set(`${group.id}:${node.id}`, { last_active: new Date().toISOString() });
    expect(await nodes.nodeIsAlive(group.id, node.id)).toBe(true);

    redisSysinfo.set(`${group.id}:${node.id}`, {
      last_active: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(await nodes.nodeIsAlive(group.id, node.id)).toBe(false);
  });

  it("deletes only the owner's nodes, clearing sysinfo and DNS first", async () => {
    const inGroup = await makeGroup(ownerId, "in");
    const foreignGroup = await makeGroup(outsiderId, "in");
    const mine = await db.node.create({
      data: { node_id: "mine", connect_ip: "1.2.3.4,::1", node_group_id: inGroup.id },
    });
    const foreign = await db.node.create({
      data: { node_id: "foreign", connect_ip: "5.6.7.8", node_group_id: foreignGroup.id },
    });

    await nodes.deleteNodes([mine.id, foreign.id], ownerId);

    expect(await db.node.count()).toBe(1);
    expect((await db.node.findMany())[0].id).toBe(foreign.id);
    expect(dnsCalls).toBe(1);
    expect(redisCalls).toEqual([`del:${inGroup.id}:${mine.id}`]);
  });
});
