/**
 * `TunnelService.createTunnel` and the listen-protocol preparation helpers.
 *
 * createTunnel is the write path users hit when they add a tunnel: it runs the
 * node-group rules (`checkTunnel`), the per-user cap, the port-conflict check and the
 * insert (plus any chains) inside one user lock. The database and the node-group
 * service are the only collaborators besides Redis, so both are stubbed or driven by
 * fixtures here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { TunnelService } from "../../apps/backend/src/services/tunnel";

const temp: TempDatabase = createTempDatabase("tunnel-create");

let db: PrismaClient;
let service: TunnelService;
let userId = 0;
let inGroupId = 0;
let outGroupId = 0;

const groupChecks: { user: number; inId: number; outId: number | null }[] = [];
let portRangeAllowed = true;

const baseTunnel = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "t",
    listen_ip: "0.0.0.0",
    listen_port: 30001,
    forward_addresses: [{ address: "10.0.0.1:80", weight: 1 }],
    in_node_group_id: inGroupId,
    out_node_group_id: null,
    status: "active",
    load_balance_type: "round",
    tunnel_type: "tcp",
    ip_type: "ipv4",
    category: "port_forward",
    listen_protocol: null,
    proxy_protocol: false,
    ...overrides,
  }) as Record<string, unknown>;

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { TunnelService: Service } = await import("../../apps/backend/src/services/tunnel");

  const user = await db.user.create({ data: { email: "creator@example.test" } });
  userId = user.id;
  const inGroup = await db.nodeGroup.create({
    data: { name: "in", node_type: "in", user_id: userId, need_out_node_group: false },
  });
  inGroupId = inGroup.id;
  const outGroup = await db.nodeGroup.create({
    data: { name: "out", node_type: "out", user_id: userId },
  });
  outGroupId = outGroup.id;

  const nodeGroupService = {
    checkUserNodeGroup: async (user: { id: number }, inId: number, outId: number | null) => {
      groupChecks.push({ user: user.id, inId, outId });
    },
    checkPortRange: () => portRangeAllowed,
  };

  service = new Service(
    { lockUserTunnel: async (_id: number, fn: () => Promise<void>) => fn() } as never,
    nodeGroupService as never,
    {} as never,
    {} as never,
  );
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.tunnelChain.deleteMany();
  await db.tunnel.deleteMany();
  groupChecks.length = 0;
  portRangeAllowed = true;
  await db.nodeGroup.update({
    where: { id: inGroupId },
    data: {
      need_out_node_group: false,
      port_range: null,
      allow_tunnel_types: null,
      allow_listen_protocol: false,
      allow_listen_protocols: null,
      allow_out_node_groups: null,
    },
  });
  await db.nodeGroup.update({
    where: { id: outGroupId },
    data: { allow_in_node_groups: null, allow_tunnel_types: null },
  });
});

describe("createTunnel", () => {
  it("inserts the tunnel with its chains and the next order_by", async () => {
    await service.createTunnel(userId, baseTunnel());
    await service.createTunnel(userId, baseTunnel({ name: "second", listen_port: 30002 }));

    const rows = await db.tunnel.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "t",
      listen_port: 30001,
      user_id: userId,
      proxy_protocol: false,
      order_by: 0,
    });
    expect(rows[1].order_by).toBe(1000);
    expect(groupChecks).toEqual([
      { user: userId, inId: inGroupId, outId: null },
      { user: userId, inId: inGroupId, outId: null },
    ]);
  });

  it("stores chains for a chained tunnel", async () => {
    await service.createTunnel(
      userId,
      baseTunnel({ tunnel_chains: [{ node_group_id: outGroupId, node_type: "out" }] }),
    );
    const chains = await db.tunnelChain.findMany();
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ node_group_id: outGroupId, node_type: "out" });
  });

  it("enforces the per-user tunnel cap", async () => {
    await service.createTunnel(userId, baseTunnel());
    await expect(
      service.createTunnel(userId, baseTunnel({ name: "over", listen_port: 30002 }), 1),
    ).rejects.toMatchObject({ status: 409, message: "已达到最大隧道数量，请升级套餐" });
    expect(await db.tunnel.count()).toBe(1);
  });

  it("rejects a port that is already used in the node group", async () => {
    await service.createTunnel(userId, baseTunnel());
    await expect(
      service.createTunnel(userId, baseTunnel({ name: "dup", listen_port: 30001 })),
    ).rejects.toMatchObject({ status: 409, message: "隧道端口已存在" });
    expect(await db.tunnel.count()).toBe(1);
  });

  it("rejects a port outside the node group's range", async () => {
    await db.nodeGroup.update({ where: { id: inGroupId }, data: { port_range: "30000-30010" } });
    portRangeAllowed = false;
    await expect(service.createTunnel(userId, baseTunnel())).rejects.toMatchObject({
      status: 400,
      message: "端口不在允许范围内",
    });
  });

  it("requires an out-node-group when the in-group needs one", async () => {
    await db.nodeGroup.update({ where: { id: inGroupId }, data: { need_out_node_group: true } });
    await expect(service.createTunnel(userId, baseTunnel())).rejects.toMatchObject({
      status: 400,
      message: "出口节点组不能为空",
    });
  });

  it("rejects a tunnel type the in-group does not allow", async () => {
    await db.nodeGroup.update({ where: { id: inGroupId }, data: { allow_tunnel_types: ["wss"] } });
    await expect(service.createTunnel(userId, baseTunnel())).rejects.toMatchObject({
      status: 403,
      message: "入口节点组不允许使用此隧道类型",
    });
  });

  it("rejects a listen protocol the in-group does not allow", async () => {
    await db.nodeGroup.update({
      where: { id: inGroupId },
      data: { allow_listen_protocol: true, allow_listen_protocols: ["vless"] },
    });
    await expect(
      service.createTunnel(
        userId,
        baseTunnel({ listen_protocol: { type: "ss", username: "u", password: "p" } }),
      ),
    ).rejects.toMatchObject({ status: 403, message: "入口节点组不允许使用此入口代理协议" });
  });

  it("rejects an out-group that the in-group does not allow", async () => {
    await db.nodeGroup.update({
      where: { id: inGroupId },
      data: { allow_out_node_groups: [outGroupId + 1] },
    });
    await expect(
      service.createTunnel(userId, baseTunnel({ out_node_group_id: outGroupId })),
    ).rejects.toMatchObject({ status: 403, message: "该入口节点组不允许使用此出口节点组" });
  });

  it("rejects an unknown node group and an unknown user", async () => {
    await expect(
      service.createTunnel(userId, baseTunnel({ in_node_group_id: 999999 })),
    ).rejects.toMatchObject({ status: 404, message: "节点组不存在" });

    await expect(service.createTunnel(999999, baseTunnel({ listen_port: 30009 }))).rejects.toMatchObject({
      status: 404,
      message: "用户不存在",
    });
  });

  it("persists a prepared wireguard listen protocol", async () => {
    await service.createTunnel(
      userId,
      baseTunnel({
        listen_port: 30010,
        listen_protocol: { type: "wireguard" },
      }),
    );
    const row = await db.tunnel.findFirstOrThrow();
    const protocol = row.listen_protocol as Record<string, unknown>;
    expect(protocol.type).toBe("wireguard");
    expect(String(protocol.privateKey)).toMatch(/.+/);
    expect(String(protocol.publicKey)).toMatch(/.+/);
    expect(protocol.mtu).toBe(1420);
    expect(Array.isArray(protocol.peers)).toBe(true);
  });
});

describe("getTunnels", () => {
  async function seed() {
    const other = await db.user.create({ data: { email: `other-${Date.now()}@example.test` } });
    const make = (data: Record<string, unknown>) =>
      db.tunnel.create({
        data: {
          user_id: userId,
          in_node_group_id: inGroupId,
          name: "t",
          forward_addresses: [],
          load_balance_type: "round",
          listen_port: 31000 + Math.floor(Math.random() * 10000),
          ...data,
        } as never,
      });
    const low = await make({ name: "alpha-low", order_by: 100 });
    const high = await make({ name: "alpha-high", order_by: 9000, status: "inactive" });
    const foreign = await make({ name: "alpha-foreign", user_id: other.id, order_by: 500 });
    return { low, high, foreign };
  }

  it("scopes to the user and filters by name and status", async () => {
    await seed();
    const all = await service.getTunnels({ page: 1, perPage: 10 }, userId);
    expect(all.total).toBe(2);
    expect(all.data.map((t) => t.name).sort()).toEqual(["alpha-high", "alpha-low"]);
    expect(all.data[0].user).toEqual({ email: "creator@example.test" });

    const alpha = await service.getTunnels({ page: 1, perPage: 10, name: "alpha" }, userId);
    expect(alpha.total).toBe(2);

    const active = await service.getTunnels({ page: 1, perPage: 10, status: ["active"] }, userId);
    expect(active.data.map((t) => t.name)).toEqual(["alpha-low"]);
  });

  it("paginates and reports the unfiltered total", async () => {
    await seed();
    const first = await service.getTunnels({ page: 1, perPage: 1 }, userId);
    expect(first.total).toBe(2);
    expect(first.data).toHaveLength(1);
    const second = await service.getTunnels({ page: 2, perPage: 1 }, userId);
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
  });

  it("orders by order_by desc by default and honours an explicit sort", async () => {
    await seed();
    const desc = await service.getTunnels({ page: 1, perPage: 10 }, userId);
    expect(desc.data.map((t) => t.name)).toEqual(["alpha-high", "alpha-low"]);

    const asc = await service.getTunnels(
      { page: 1, perPage: 10, sort: [{ id: "order_by", desc: false }] },
      userId,
    );
    expect(asc.data.map((t) => t.name)).toEqual(["alpha-low", "alpha-high"]);
  });

  it("filters by tunnel chain node group and type", async () => {
    const seeded = await seed();
    await db.tunnelChain.create({
      data: { tunnel_id: seeded.low.id, node_group_id: outGroupId, node_type: "out" },
    });

    const viaOut = await service.getTunnels(
      { page: 1, perPage: 10, out_tunnel_chain_id: [outGroupId] },
      userId,
    );
    expect(viaOut.data.map((t) => t.id)).toEqual([seeded.low.id]);

    const viaIn = await service.getTunnels(
      { page: 1, perPage: 10, in_tunnel_chain_id: [outGroupId] },
      userId,
    );
    expect(viaIn.data).toEqual([]);
  });
});

describe("prepareListenProtocol", () => {
  it("normalises a plain ss protocol to type/user/password", () => {
    expect(service.prepareListenProtocol({ type: "ss", username: "u" })).toEqual({
      type: "ss",
      username: "u",
      password: null,
    });
    expect(service.prepareListenProtocol(null)).toBeNull();
  });

  it("generates and preserves vless material", () => {
    const first = service.prepareListenProtocol({ type: "vless" })!;
    expect(first.type).toBe("vless");
    expect(first.username).toBe("user");
    expect(first.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.dest).toBe("www.apple.com:443");
    expect(String(first.shortId)).toMatch(/^[0-9a-f]+$/);

    const reused = service.prepareListenProtocol({ type: "vless" }, first)!;
    expect(reused.uuid).toBe(first.uuid);
    expect(reused.privateKey).toBe(first.privateKey);
    expect(reused.shortId).toBe(first.shortId);
  });

  it("generates mieru credentials and reuses them on update", () => {
    const first = service.prepareListenProtocol({ type: "mieru" })!;
    expect(String(first.username).length).toBeGreaterThan(0);
    expect(String(first.password).length).toBeGreaterThan(0);
    expect(first.transportProtocol).toBe("tcp");
    expect(first.mtu).toBe(1400);

    const udp = service.prepareListenProtocol({ type: "mieru", transportProtocol: "UDP" }, first)!;
    expect(udp.username).toBe(first.username);
    expect(udp.password).toBe(first.password);
    expect(udp.transportProtocol).toBe("udp");
  });

  it("keeps an existing openvpn PKI and applies the defaults", () => {
    const prev = {
      type: "openvpn",
      ca: "CA",
      cert: "CERT",
      key: "KEY",
      clientCert: "CC",
      clientKey: "CK",
      tlsCrypt: "TC",
    };
    const next = service.prepareListenProtocol({ type: "openvpn" }, prev)!;
    expect(next).toMatchObject({
      ca: "CA",
      cert: "CERT",
      key: "KEY",
      clientCert: "CC",
      clientKey: "CK",
      tlsCrypt: "TC",
      udp: false,
      cipher: "AES-256-GCM",
      auth: "SHA256",
      mtu: 1500,
      server: "10.8.0.0/24",
    });
  });

  it("fills wireguard defaults and keeps a previous key pair", () => {
    const first = service.prepareListenProtocol({ type: "wireguard" })!;
    expect(String(first.privateKey)).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(String(first.publicKey)).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(first.mtu).toBe(1420);
    expect(Array.isArray(first.clientAllowedIPs)).toBe(true);
    expect(Array.isArray(first.dns)).toBe(true);
    expect(first.peers).toHaveLength(1);
    expect(first.clientPrivateKey).toMatch(/^[A-Za-z0-9+/=]+$/);

    const reused = service.prepareListenProtocol({ type: "wireguard" }, first)!;
    expect(reused.privateKey).toBe(first.privateKey);
    expect(reused.publicKey).toBe(first.publicKey);
    expect(reused.clientPrivateKey).toBe(first.clientPrivateKey);
  });
});
