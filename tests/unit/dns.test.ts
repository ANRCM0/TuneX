import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the DNS vertical (task-5).
 *
 * The Cloudflare/Huawei REST endpoints cannot be reached from this environment, so the
 * network-facing provider methods are not exercised here. Instead these tests cover the
 * record-synthesis logic that decides *what* would be sent: provider selection, the
 * A/AAAA mapping (with the `ipv6` flag), the `custom_line` mapping, the pair-wise
 * update/create/delete plan, and the alive/backup node semantics used by both the manual
 * sync and the cron reconciliation.
 *
 * NOTE: the original contains no CNAME record handling anywhere (only A/AAAA), so there
 * is nothing CNAME-shaped to assert.
 */

const mocks = vi.hoisted(() => ({
  db: {
    inNodeGroupDNS: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    node: { findMany: vi.fn(), update: vi.fn() },
    nodeGroup: { findFirst: vi.fn() },
    dNSProvider: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  nodeIsAlive: vi.fn(),
  tryLockSyncNodeDNS: vi.fn(),
  unlockSyncNodeDNS: vi.fn(),
  getDNSProvider: vi.fn(),
}));

vi.mock("../../apps/backend/src/db", () => ({ db: mocks.db, prisma: mocks.db }));

vi.mock("../../apps/backend/src/services/redis", () => ({
  redisService: {
    nodeIsAlive: mocks.nodeIsAlive,
    tryLockSyncNodeDNS: mocks.tryLockSyncNodeDNS,
    unlockSyncNodeDNS: mocks.unlockSyncNodeDNS,
  },
  RedisService: class RedisService {},
}));

vi.mock("../../apps/backend/src/services/dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/backend/src/services/dns")>();
  return { ...actual, getDNSProvider: mocks.getDNSProvider };
});

import type { RedisService } from "../../apps/backend/src/services/redis";
import type { DNSRecordType } from "../../apps/backend/src/services/dns/interface";
import { getRootDomain } from "../../apps/backend/src/services/dns/interface";
import {
  dnsRecordType,
  nodeCustomLine,
  InNodeGroupDNSService,
} from "../../apps/backend/src/services/in_node_group_dns";

function fakeProvider() {
  return {
    listRecords: vi.fn(async () => [] as { ip: string; type: string }[]),
    createRecord: vi.fn(async () => true),
    updateRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => true),
    deleteRecords: vi.fn(async () => undefined),
  };
}

function makeService() {
  const redis = {
    nodeIsAlive: mocks.nodeIsAlive,
    tryLockSyncNodeDNS: mocks.tryLockSyncNodeDNS,
    unlockSyncNodeDNS: mocks.unlockSyncNodeDNS,
  } as unknown as RedisService;
  return new InNodeGroupDNSService(redis);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRootDomain", () => {
  it("keeps the last two labels", () => {
    expect(getRootDomain("a.b.example.com")).toBe("example.com");
    expect(getRootDomain("example.com")).toBe("example.com");
  });

  it("matches the upstream quirk for multi-label public suffixes", () => {
    expect(getRootDomain("entry.example.com.cn")).toBe("com.cn");
  });
});

describe("dnsRecordType (A/AAAA synthesis)", () => {
  it("maps IPv4 to A regardless of the ipv6 flag", () => {
    expect(dnsRecordType("1.2.3.4", false)).toBe<DNSRecordType>("A");
    expect(dnsRecordType("1.2.3.4", true)).toBe<DNSRecordType>("A");
  });

  it("maps IPv6 to AAAA only when the binding enables ipv6", () => {
    expect(dnsRecordType("2001:db8::1", true)).toBe<DNSRecordType>("AAAA");
    expect(dnsRecordType("2001:db8::1", false)).toBeNull();
  });

  it("ignores values that are neither IPv4 nor IPv6", () => {
    expect(dnsRecordType("entry.example.com", true)).toBeNull();
    expect(dnsRecordType("", true)).toBeNull();
  });
});

describe("nodeCustomLine (custom_line mapping)", () => {
  it("looks the line up by stringified node id", () => {
    expect(nodeCustomLine({ "1": "电信", "2": "联通" }, 1)).toBe("电信");
    expect(nodeCustomLine({ "1": "电信", "2": "联通" }, 2)).toBe("联通");
  });

  it("returns null for missing keys and for a null/undefined mapping", () => {
    expect(nodeCustomLine({ "1": "电信" }, 3)).toBeNull();
    expect(nodeCustomLine(null, 1)).toBeNull();
    expect(nodeCustomLine(undefined, 1)).toBeNull();
  });
});

describe("DNS provider factory", () => {
  it("throws the upstream 400 for an unsupported provider type", async () => {
    const real = await vi.importActual<typeof import("../../apps/backend/src/services/dns")>(
      "../../apps/backend/src/services/dns",
    );
    let caught: { status?: number; message?: string } | undefined;
    try {
      real.getDNSProvider("route53" as never, "a.example.com", {});
    } catch (error) {
      caught = error as { status?: number; message?: string };
    }
    expect(caught?.status).toBe(400);
    expect(caught?.message).toBe("不支持的 DNS 服务商: route53");
  });

  it("caches by type:domain:sha1(config) and re-creates on config change", async () => {
    const real = await vi.importActual<typeof import("../../apps/backend/src/services/dns")>(
      "../../apps/backend/src/services/dns",
    );
    const first = real.getDNSProvider("cloudflare" as never, "cache-a.example.com", {
      api_token: "token-1",
    });
    const same = real.getDNSProvider("cloudflare" as never, "cache-a.example.com", {
      api_token: "token-1",
    });
    const otherConfig = real.getDNSProvider("cloudflare" as never, "cache-a.example.com", {
      api_token: "token-2",
    });
    const otherDomain = real.getDNSProvider("cloudflare" as never, "cache-b.example.com", {
      api_token: "token-1",
    });
    expect(same).toBe(first);
    expect(otherConfig).not.toBe(first);
    expect(otherDomain).not.toBe(first);
  });

  it("builds a Huawei provider for the huawei type", async () => {
    const real = await vi.importActual<typeof import("../../apps/backend/src/services/dns")>(
      "../../apps/backend/src/services/dns",
    );
    const { HuaweiDNSProvider } = await import("../../apps/backend/src/services/dns/huawei");
    const provider = real.getDNSProvider("huawei" as never, "hw.example.com", {
      access_key: "ak",
      secret_key: "sk",
      project_id: "project",
      region_id: "cn-north-4",
    });
    expect(provider).toBeInstanceOf(HuaweiDNSProvider);
  });
});

describe("InNodeGroupDNSService.syncIpSet", () => {
  it("reuses records pair-wise, then deletes and creates the leftovers", async () => {
    const service = makeService();
    const provider = fakeProvider();
    await service.syncIpSet(
      provider as never,
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"],
      ["3.3.3.3", "5.5.5.5"],
      "A",
      60,
      5,
      "电信",
    );
    expect(provider.updateRecord).toHaveBeenCalledTimes(1);
    expect(provider.updateRecord).toHaveBeenCalledWith("1.1.1.1", "5.5.5.5", "A", 60, 5, "电信");
    expect(provider.deleteRecord).toHaveBeenCalledTimes(2);
    expect(provider.deleteRecord).toHaveBeenNthCalledWith(1, "2.2.2.2");
    expect(provider.deleteRecord).toHaveBeenNthCalledWith(2, "4.4.4.4");
    expect(provider.createRecord).not.toHaveBeenCalled();
  });

  it("creates every record when there was nothing before", async () => {
    const service = makeService();
    const provider = fakeProvider();
    await service.syncIpSet(provider as never, [], ["1.1.1.1", "2.2.2.2"], "A", 60, 1);
    expect(provider.createRecord).toHaveBeenCalledTimes(2);
    expect(provider.createRecord).toHaveBeenNthCalledWith(1, "1.1.1.1", "A", 60, 1, undefined);
    expect(provider.createRecord).toHaveBeenNthCalledWith(2, "2.2.2.2", "A", 60, 1, undefined);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it("deletes every record when the new set is empty", async () => {
    const service = makeService();
    const provider = fakeProvider();
    await service.syncIpSet(provider as never, ["1.1.1.1", "2.2.2.2"], [], "A", 60, 1);
    expect(provider.deleteRecord).toHaveBeenCalledTimes(2);
    expect(provider.createRecord).not.toHaveBeenCalled();
  });
});

describe("InNodeGroupDNSService.updateNodeDnsRecords (register handshake)", () => {
  it("does nothing when the connect_ip is unchanged", async () => {
    const service = makeService();
    await service.updateNodeDnsRecords(
      { id: 1, connect_ip: "entry.example.com" },
      ["1.1.1.1"],
      ["1.1.1.1"],
      5,
      null,
    );
    expect(mocks.db.inNodeGroupDNS.findMany).not.toHaveBeenCalled();
    expect(mocks.getDNSProvider).not.toHaveBeenCalled();
  });

  it("skips the lookup when the node group has no connect_ip", async () => {
    const service = makeService();
    await service.updateNodeDnsRecords({ id: 1, connect_ip: null }, ["1.1.1.1"], ["2.2.2.2"], 5, null);
    expect(mocks.db.inNodeGroupDNS.findMany).not.toHaveBeenCalled();
  });

  it("splits IPv4/IPv6 and honours the per-binding ipv6 flag", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue([
      {
        id: 10,
        ttl: 120,
        ipv6: true,
        dns_provider: { type: "cloudflare", config: { api_token: "t1" } },
      },
      {
        id: 11,
        ttl: 60,
        ipv6: false,
        dns_provider: { type: "huawei", config: { access_key: "ak" } },
      },
    ]);
    const dualStack = fakeProvider();
    const v4Only = fakeProvider();
    mocks.getDNSProvider.mockReturnValueOnce(dualStack as never).mockReturnValueOnce(v4Only as never);

    await service.updateNodeDnsRecords(
      { id: 1, connect_ip: "entry.example.com" },
      ["1.1.1.1", "2001:db8::1"],
      ["2.2.2.2", "2001:db8::2"],
      7,
      "电信",
    );

    expect(mocks.getDNSProvider).toHaveBeenNthCalledWith(1, "cloudflare", "entry.example.com", {
      api_token: "t1",
    });
    expect(mocks.getDNSProvider).toHaveBeenNthCalledWith(2, "huawei", "entry.example.com", {
      access_key: "ak",
    });
    expect(dualStack.updateRecord).toHaveBeenCalledWith("1.1.1.1", "2.2.2.2", "A", 120, 7, "电信");
    expect(dualStack.updateRecord).toHaveBeenCalledWith("2001:db8::1", "2001:db8::2", "AAAA", 120, 7, "电信");
    expect(v4Only.updateRecord).toHaveBeenCalledTimes(1);
    expect(v4Only.updateRecord).toHaveBeenCalledWith("1.1.1.1", "2.2.2.2", "A", 60, 7, "电信");
  });

  it("returns without touching providers when no active binding exists", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue([]);
    await service.updateNodeDnsRecords(
      { id: 1, connect_ip: "entry.example.com" },
      ["1.1.1.1"],
      ["2.2.2.2"],
      5,
      null,
    );
    expect(mocks.getDNSProvider).not.toHaveBeenCalled();
  });
});

describe("InNodeGroupDNSService.nodeDnsRecords (node add/remove)", () => {
  it("creates an A and an AAAA record for a dual-stack binding", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue([
      {
        id: 10,
        ttl: 60,
        ipv6: true,
        dns_provider: { type: "cloudflare", config: { api_token: "t1" } },
      },
    ]);
    const provider = fakeProvider();
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.nodeDnsRecords(
      { id: 1, connect_ip: "entry.example.com" },
      ["1.1.1.1", "2001:db8::1"],
      "create",
      5,
      42,
      "电信",
    );

    expect(provider.createRecord).toHaveBeenCalledWith("1.1.1.1", "A", 60, 5, "电信");
    expect(provider.createRecord).toHaveBeenCalledWith("2001:db8::1", "AAAA", 60, 5, "电信");
    expect(mocks.db.node.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { dns_status: true },
    });
  });

  it("skips IPv6 for an IPv4-only binding and clears dns_status on delete", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue([
      {
        id: 10,
        ttl: 60,
        ipv6: false,
        dns_provider: { type: "cloudflare", config: { api_token: "t1" } },
      },
    ]);
    const provider = fakeProvider();
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.nodeDnsRecords(
      { id: 1, connect_ip: "entry.example.com" },
      ["1.1.1.1", "2001:db8::1"],
      "delete",
      5,
      42,
      null,
    );

    expect(provider.deleteRecord).toHaveBeenCalledTimes(1);
    expect(provider.deleteRecord).toHaveBeenCalledWith("1.1.1.1");
    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(mocks.db.node.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { dns_status: false },
    });
  });
});

describe("InNodeGroupDNSService.syncNodeCustomLines", () => {
  it("writes the mapped line to every node, clearing unmapped ones", async () => {
    const service = makeService();
    mocks.db.node.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await service.syncNodeCustomLines(9, { "1": "电信", "2": "联通" });

    expect(mocks.db.node.findMany).toHaveBeenCalledWith({
      where: { node_group_id: 9 },
      select: { id: true },
    });
    expect(mocks.db.node.update).toHaveBeenNthCalledWith(1, {
      where: { id: 1 },
      data: { custom_line: "电信" },
    });
    expect(mocks.db.node.update).toHaveBeenNthCalledWith(2, {
      where: { id: 2 },
      data: { custom_line: "联通" },
    });
    expect(mocks.db.node.update).toHaveBeenNthCalledWith(3, {
      where: { id: 3 },
      data: { custom_line: null },
    });
  });

  it("clears every node when the mapping is null", async () => {
    const service = makeService();
    mocks.db.node.findMany.mockResolvedValue([{ id: 1 }]);
    await service.syncNodeCustomLines(9, null);
    expect(mocks.db.node.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { custom_line: null },
    });
  });
});

describe("InNodeGroupDNSService.getInNodeGroupDNSList", () => {
  it("applies paging, sort and filters", async () => {
    const service = makeService();
    const findMany = vi.fn().mockResolvedValue([{ id: 1 }]);
    const count = vi.fn().mockResolvedValue(1);
    mocks.db.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({ inNodeGroupDNS: { findMany, count } }),
    );

    const result = await service.getInNodeGroupDNSList(7, {
      page: 2,
      perPage: 20,
      sort: [{ id: "id", desc: true }],
      in_node_group_id: 3,
      dns_provider_id: 4,
      status: "inactive",
    } as never);

    expect(result).toEqual({ data: [{ id: 1 }], total: 1 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          in_node_group: { user_id: 7 },
          in_node_group_id: 3,
          dns_provider_id: 4,
          status: "inactive",
        },
        skip: 20,
        take: 20,
        orderBy: [{ id: "desc" }],
      }),
    );
    expect(count).toHaveBeenCalledWith({
      where: {
        in_node_group: { user_id: 7 },
        in_node_group_id: 3,
        dns_provider_id: 4,
        status: "inactive",
      },
    });
  });
});

describe("InNodeGroupDNSService.syncDNSRecords (manual sync)", () => {
  function groupFixture(): unknown {
    return {
      ipv6: true,
      ttl: 60,
      dns_provider: { type: "cloudflare", config: { api_token: "t1" } },
      in_node_group: {
        connect_ip: "entry.example.com",
        nodes: [
          {
            id: 1,
            node_group_id: 9,
            backup: false,
            connect_ip: "1.1.1.1,2001:db8::1",
            custom_line: "电信",
            weight: 5,
          },
          {
            id: 2,
            node_group_id: 9,
            backup: true,
            connect_ip: "2.2.2.2",
            custom_line: null,
            weight: 1,
          },
        ],
      },
    };
  }

  it("wipes existing records and re-creates them for alive normal nodes only", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findFirst.mockResolvedValue(groupFixture());
    mocks.nodeIsAlive.mockResolvedValue(true);
    const provider = fakeProvider();
    mocks.getDNSProvider.mockReturnValue(provider as never);

    const result = await service.syncDNSRecords(3, 77);

    expect(provider.deleteRecords).toHaveBeenCalledTimes(1);
    expect(provider.createRecord).toHaveBeenCalledWith("1.1.1.1", "A", 60, 5, "电信");
    expect(provider.createRecord).toHaveBeenCalledWith("2001:db8::1", "AAAA", 60, 5, "电信");
    // The backup node stays out while a normal node is alive.
    expect(provider.createRecord).not.toHaveBeenCalledWith(
      "2.2.2.2",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // Upstream reports the node count, not the number of records written.
    expect(result).toEqual({ synced: 2 });
  });

  it("falls back to backup nodes when no normal node is alive", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findFirst.mockResolvedValue(groupFixture());
    mocks.nodeIsAlive.mockImplementation(async (_groupId: number, nodeId: number) => nodeId === 2);
    const provider = fakeProvider();
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.syncDNSRecords(3, 77);

    expect(provider.createRecord).toHaveBeenCalledTimes(1);
    expect(provider.createRecord).toHaveBeenCalledWith("2.2.2.2", "A", 60, 1, undefined);
  });

  it("throws 404 when the binding is missing or disabled", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findFirst.mockResolvedValue(null);
    await expect(service.syncDNSRecords(3, 77)).rejects.toMatchObject({
      status: 404,
      message: "入口保活配置不存在或未启用",
    });
  });

  it("throws 400 when the node group has no connect_ip", async () => {
    const service = makeService();
    const fixture = groupFixture() as { in_node_group: { connect_ip: string | null } };
    fixture.in_node_group.connect_ip = null;
    mocks.db.inNodeGroupDNS.findFirst.mockResolvedValue(fixture);
    await expect(service.syncDNSRecords(3, 77)).rejects.toMatchObject({
      status: 400,
      message: "入口节点组未配置连接域名",
    });
  });
});

describe("InNodeGroupDNSService.cronSyncNodeDNS (Redis lock)", () => {
  it("skips the round when the lock is already held", async () => {
    const service = makeService();
    mocks.tryLockSyncNodeDNS.mockResolvedValue(false);
    await service.cronSyncNodeDNS();
    expect(mocks.db.inNodeGroupDNS.findMany).not.toHaveBeenCalled();
    expect(mocks.unlockSyncNodeDNS).not.toHaveBeenCalled();
  });

  it("reconciles and always releases the lock", async () => {
    const service = makeService();
    mocks.tryLockSyncNodeDNS.mockResolvedValue(true);
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue([]);
    await service.cronSyncNodeDNS();
    expect(mocks.db.inNodeGroupDNS.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.unlockSyncNodeDNS).toHaveBeenCalledTimes(1);
  });
});

describe("InNodeGroupDNSService.reconcileNodeDNS", () => {
  function reconcileFixture(): unknown {
    return [
      {
        id: 9,
        ipv6: false,
        ttl: 60,
        dns_provider: { type: "cloudflare", config: { api_token: "t1" } },
        in_node_group: {
          connect_ip: "entry.example.com",
          nodes: [
            {
              id: 1,
              node_group_id: 5,
              status: "active",
              backup: false,
              connect_ip: "1.1.1.1",
              custom_line: null,
              weight: 5,
              dns_status: true,
            },
            {
              id: 2,
              node_group_id: 5,
              status: "active",
              backup: true,
              connect_ip: "2.2.2.2",
              custom_line: "联通",
              weight: 1,
              dns_status: false,
            },
          ],
        },
      },
    ];
  }

  it("keeps live normal records, removes the backup and leaves statuses alone", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue(reconcileFixture());
    mocks.nodeIsAlive.mockResolvedValue(true);
    const provider = fakeProvider();
    provider.listRecords.mockResolvedValue([
      { ip: "1.1.1.1", type: "A" },
      { ip: "2.2.2.2", type: "A" },
    ]);
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.reconcileNodeDNS();

    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(provider.deleteRecord).toHaveBeenCalledTimes(1);
    expect(provider.deleteRecord).toHaveBeenCalledWith("2.2.2.2");
    // Statuses were already correct (1 -> true, 2 -> false), so no writes happen.
    expect(mocks.db.node.update).not.toHaveBeenCalled();
  });

  it("creates records for an alive normal node whose IP is missing", async () => {
    const service = makeService();
    const fixture = reconcileFixture() as {
      in_node_group: { nodes: { dns_status: boolean }[] };
    }[];
    fixture[0].in_node_group.nodes[0].dns_status = false;
    fixture[0].in_node_group.nodes[1].dns_status = true;
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue(fixture);
    mocks.nodeIsAlive.mockResolvedValue(true);
    const provider = fakeProvider();
    provider.listRecords.mockResolvedValue([]);
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.reconcileNodeDNS();

    expect(provider.createRecord).toHaveBeenCalledTimes(1);
    expect(provider.createRecord).toHaveBeenCalledWith("1.1.1.1", "A", 60, 5, undefined);
    // Node 1 becomes healthy (true), the backup node 2 leaves the DNS (false).
    expect(mocks.db.node.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { dns_status: true },
    });
    expect(mocks.db.node.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { dns_status: false },
    });
  });

  it("leaves node statuses untouched when the provider listing fails", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue(reconcileFixture());
    mocks.nodeIsAlive.mockResolvedValue(true);
    const provider = fakeProvider();
    provider.listRecords.mockRejectedValue(new Error("cloudflare unavailable"));
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.reconcileNodeDNS();

    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(provider.deleteRecord).not.toHaveBeenCalled();
    expect(mocks.db.node.update).not.toHaveBeenCalled();
  });

  it("cleans up records that no longer belong to any node in the group", async () => {
    const service = makeService();
    mocks.db.inNodeGroupDNS.findMany.mockResolvedValue(reconcileFixture());
    mocks.nodeIsAlive.mockResolvedValue(false);
    const provider = fakeProvider();
    provider.listRecords.mockResolvedValue([{ ip: "9.9.9.9", type: "A" }]);
    mocks.getDNSProvider.mockReturnValue(provider as never);

    await service.reconcileNodeDNS();

    expect(provider.deleteRecord).toHaveBeenCalledWith("9.9.9.9");
  });
});
