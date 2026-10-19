/**
 * DNS orchestration: provider CRUD and the in-node-group keep-alive configuration.
 *
 * These two services are what actually drive DNS records for `in` node groups. The
 * provider clients themselves are covered by `dns.test.ts`; here the database,
 * validation and the record-pairing logic are exercised, with a fake provider for the
 * API calls so no network is touched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { DNSProviderService } from "../../apps/backend/src/services/dns_provider";
import type { InNodeGroupDNSService } from "../../apps/backend/src/services/in_node_group_dns";

const temp: TempDatabase = createTempDatabase("dns-orchestration");

let db: PrismaClient;
let providers: DNSProviderService;
let inGroupDns: InNodeGroupDNSService;
let nodeGroupService: typeof import("../../apps/backend/src/services/in_node_group_dns");

let userId = 0;
let outsiderId = 0;
let groupId = 0;
let providerId = 0;

async function makeGroup(overrides: Record<string, unknown> = {}) {
  return db.nodeGroup.create({
    data: {
      name: `in-${Math.random().toString(36).slice(2, 6)}`,
      node_type: "in",
      user_id: userId,
      connect_ip: "node.example.test",
      ...overrides,
    } as never,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { DNSProviderService: Providers } = await import("../../apps/backend/src/services/dns_provider");
  const dnsModule = await import("../../apps/backend/src/services/in_node_group_dns");
  nodeGroupService = dnsModule;
  const { InNodeGroupDNSService: InGroup } = dnsModule;

  providers = new Providers();
  inGroupDns = new InGroup({} as never);

  userId = (await db.user.create({ data: { email: "dns@example.test" } })).id;
  outsiderId = (await db.user.create({ data: { email: "outsider@example.test" } })).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.inNodeGroupDNS.deleteMany();
  await db.dNSProvider.deleteMany();
  await db.node.deleteMany();
  await db.nodeGroup.deleteMany();

  groupId = (await makeGroup()).id;
  providerId = (
    await db.dNSProvider.create({
      data: {
        name: "cf",
        type: "cloudflare",
        config: { api_token: "t", zone_id: "z" },
        user_id: userId,
      },
    })
  ).id;
});

describe("dnsRecordType / nodeCustomLine", () => {
  it("picks A and AAAA by family and the ipv6 flag", () => {
    expect(nodeGroupService.dnsRecordType("1.2.3.4", false)).toBe("A");
    expect(nodeGroupService.dnsRecordType("1.2.3.4", true)).toBe("A");
    expect(nodeGroupService.dnsRecordType("2001:db8::1", true)).toBe("AAAA");
    expect(nodeGroupService.dnsRecordType("2001:db8::1", false)).toBeNull();
    expect(nodeGroupService.dnsRecordType("not-an-ip", true)).toBeNull();
  });

  it("reads a node's custom line by id", () => {
    expect(nodeGroupService.nodeCustomLine({ "7": "telecom" }, 7)).toBe("telecom");
    expect(nodeGroupService.nodeCustomLine({ "7": "telecom" }, 8)).toBeNull();
    expect(nodeGroupService.nodeCustomLine(null, 1)).toBeNull();
    expect(nodeGroupService.nodeCustomLine({ "1": "" }, 1)).toBe("");
  });
});

describe("DNSProviderService", () => {
  it("creates, lists, filters and summarises providers", async () => {
    const created = await providers.createDNSProvider(userId, {
      name: "huawei",
      type: "huawei",
      config: { ak: "a", sk: "s" },
    } as never);
    expect(created).toMatchObject({ name: "huawei", type: "huawei", user_id: userId });

    const all = await providers.getDNSProviders(userId, { page: 1, perPage: 10 } as never);
    expect(all.total).toBe(2);

    const filtered = await providers.getDNSProviders(userId, {
      page: 1,
      perPage: 10,
      name: "cf",
    } as never);
    expect(filtered.data.map((p) => p.name)).toEqual(["cf"]);

    const byType = await providers.getDNSProviders(userId, {
      page: 1,
      perPage: 10,
      type: "huawei",
    } as never);
    expect(byType.data.map((p) => p.name)).toEqual(["huawei"]);

    const summary = await providers.getDNSProviderSummary(userId);
    expect(summary.map((p) => p.name).sort()).toEqual(["cf", "huawei"]);
    expect(await providers.getDNSProviderById(providerId)).toMatchObject({ name: "cf" });
  });

  it("updates only the owner's provider", async () => {
    const updated = await providers.updateDNSProvider(userId, providerId, {
      name: "cf2",
      type: "cloudflare",
      config: { api_token: "t2", zone_id: "z" },
    } as never);
    expect(updated.name).toBe("cf2");

    await expect(
      providers.updateDNSProvider(outsiderId, providerId, {
        name: "hijack",
        type: "cloudflare",
        config: {},
      } as never),
    ).rejects.toBeTruthy();
  });

  it("deletes the provider and its in-group links, but not someone else's", async () => {
    const keep = await db.dNSProvider.create({
      data: { name: "keep", type: "cloudflare", config: {}, user_id: outsiderId },
    });
    const foreignGroup = await makeGroup({ user_id: outsiderId });
    await db.inNodeGroupDNS.create({
      data: { in_node_group_id: foreignGroup.id, dns_provider_id: keep.id },
    });
    await db.inNodeGroupDNS.create({
      data: { in_node_group_id: groupId, dns_provider_id: providerId },
    });

    await providers.deleteDNSProviders(userId, [providerId, keep.id]);

    expect(await db.dNSProvider.count()).toBe(1);
    expect((await db.dNSProvider.findMany())[0].id).toBe(keep.id);
    expect(await db.inNodeGroupDNS.count()).toBe(1);
  });
});

describe("InNodeGroupDNSService", () => {
  it("validates the group and the provider before creating", async () => {
    await expect(
      inGroupDns.createInNodeGroupDNS(userId, {
        in_node_group_id: 999999,
        dns_provider_id: providerId,
        ttl: 60,
        ipv6: false,
      } as never),
    ).rejects.toMatchObject({ status: 404, message: "入口节点组不存在" });

    const noIp = await makeGroup({ connect_ip: null });
    await expect(
      inGroupDns.createInNodeGroupDNS(userId, {
        in_node_group_id: noIp.id,
        dns_provider_id: providerId,
        ttl: 60,
        ipv6: false,
      } as never),
    ).rejects.toMatchObject({ status: 400, message: "入口节点组未设置连接域名" });

    await expect(
      inGroupDns.createInNodeGroupDNS(userId, {
        in_node_group_id: groupId,
        dns_provider_id: 999999,
        ttl: 60,
        ipv6: false,
      } as never),
    ).rejects.toMatchObject({ status: 404, message: "DNS 授权配置不存在" });
  });

  it("creates the keep-alive row and applies custom lines to the nodes", async () => {
    const node = await db.node.create({
      data: { node_id: "n-1", connect_ip: "1.2.3.4", node_group_id: groupId },
    });
    const other = await db.node.create({
      data: { node_id: "n-2", connect_ip: "5.6.7.8", node_group_id: groupId },
    });

    const created = await inGroupDns.createInNodeGroupDNS(userId, {
      in_node_group_id: groupId,
      dns_provider_id: providerId,
      ttl: 120,
      ipv6: true,
      status: "active",
      custom_line: { [node.id]: "telecom" },
    } as never);

    expect(created).toMatchObject({ in_node_group_id: groupId, ttl: 120, ipv6: true });
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).custom_line).toBe("telecom");
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).custom_line).toBeNull();
  });

  it("updates, lists and deletes only the owner's configuration", async () => {
    const created = await db.inNodeGroupDNS.create({
      data: { in_node_group_id: groupId, dns_provider_id: providerId, ttl: 60 },
    });

    const updated = await inGroupDns.updateInNodeGroupDNS(userId, created.id, {
      in_node_group_id: groupId,
      dns_provider_id: providerId,
      ttl: 300,
      ipv6: false,
      status: "inactive",
    } as never);
    expect(updated).toMatchObject({ ttl: 300, status: "inactive" });

    const list = await inGroupDns.getInNodeGroupDNSList(userId, {
      page: 1,
      perPage: 10,
    } as never);
    expect(list.total).toBe(1);
    expect(list.data[0].dns_provider.name).toBe("cf");
    expect(list.data[0].in_node_group.id).toBe(groupId);

    await expect(
      inGroupDns.updateInNodeGroupDNS(outsiderId, created.id, {
        in_node_group_id: groupId,
        dns_provider_id: providerId,
        ttl: 60,
        ipv6: false,
        status: "active",
      } as never),
    ).rejects.toMatchObject({ status: 404, message: "入口保活配置不存在" });

    await inGroupDns.deleteInNodeGroupDNS(outsiderId, [created.id]);
    expect(await db.inNodeGroupDNS.count()).toBe(1);
    await inGroupDns.deleteInNodeGroupDNS(userId, [created.id]);
    expect(await db.inNodeGroupDNS.count()).toBe(0);
  });

  it("pairs record updates then creates and deletes the leftovers", async () => {
    const calls: string[] = [];
    const provider = {
      updateRecord: async (oldIp: string, newIp: string, type: string) => {
        calls.push(`update:${oldIp}->${newIp}:${type}`);
      },
      createRecord: async (ip: string, type: string) => {
        calls.push(`create:${ip}:${type}`);
      },
      deleteRecord: async (ip: string) => {
        calls.push(`delete:${ip}`);
      },
    };

    await inGroupDns.syncIpSet(
      provider as never,
      ["1.1.1.1", "2.2.2.2", "3.3.3.3"],
      ["4.4.4.4", "5.5.5.5"],
      "A",
      60,
      10,
      "line",
    );

    // Two paired updates, then the leftover delete.
    expect(calls).toEqual([
      "update:1.1.1.1->4.4.4.4:A",
      "update:2.2.2.2->5.5.5.5:A",
      "delete:3.3.3.3",
    ]);

    calls.length = 0;
    await inGroupDns.syncIpSet(provider as never, ["1.1.1.1"], ["2.2.2.2", "3.3.3.3"], "A", 60, 10);
    expect(calls).toEqual(["update:1.1.1.1->2.2.2.2:A", "create:3.3.3.3:A"]);
  });
});
