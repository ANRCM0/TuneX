/**
 * In-node config generation (`TunnelService.getInNodeConfig`) against a throwaway
 * database.
 *
 * The panel turns a tunnel row into the gost document an agent applies: services,
 * chains, limiters, bypasses, admissions and the observer. `scripts/e2e-local.sh`
 * proves one TCP forward end to end; this suite pins the document itself for the
 * shapes that are easy to break — WAIT_LISTEN ports, weighted forward nodes, the
 * paired tcp/udp services, protocol handlers, and limit/bypass/admission wiring.
 *
 * Only `db.nodeGroup.findUnique` is hit (for bypass/admission settings), so the
 * fixtures are plain objects passed as `allTunnels`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { TunnelService } from "../../apps/backend/src/services/tunnel";

const temp: TempDatabase = createTempDatabase("tunnel-config");

let db: PrismaClient;
let service: TunnelService;
let groupId = 0;

type Json = Record<string, unknown>;

function makeTunnel(overrides: Json = {}): never {
  return {
    id: 1,
    user_id: 1,
    in_node_group_id: groupId,
    in_node_group: { block_protocols: [], user_id: 1 },
    out_node_group_id: null,
    out_node_group: null,
    category: "port_forward",
    tunnel_type: "tcp",
    listen_ip: "0.0.0.0",
    listen_port: 1234,
    ip_type: "ipv4",
    listen_protocol: null,
    forward_addresses: [
      { address: "10.0.0.2:80", weight: 1, host: null },
      { address: "10.0.0.1:80", weight: 5 },
    ],
    forward_addresses_protocol: null,
    load_balance_type: "round",
    proxy_protocol: false,
    user: {
      id: 1,
      user_plan: { whitelist_ips: [], traffic_used: 0, max_tunnels: 10, plan: {} },
    },
    tunnel_chains: [],
    ...overrides,
  } as never;
}

async function inConfig(tunnels: unknown[], portRange: string | null = null, allowListen = false) {
  return (await service.getInNodeConfig(
    groupId,
    portRange,
    allowListen,
    tunnels as never,
    {},
    new Map(),
  )) as {
    log: Json;
    tls: Json;
    services: Json[];
    chains: Json[];
    climiters: Json[];
    limiters: Json[];
    bypasses: Json[];
    admissions: Json[];
    observers: Json[];
  };
}

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { TunnelService: Service } = await import("../../apps/backend/src/services/tunnel");
  service = new Service(
    {} as never,
    {} as never,
    {} as never,
    {
      getConfig: async () => 30,
    } as never,
  );
  const group = await db.nodeGroup.create({
    data: {
      name: "in-group",
      node_type: "in",
      user_id: (await db.user.create({ data: { email: "t@example.test" } })).id,
    },
  });
  groupId = group.id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

describe("getInNodeConfig", () => {
  it("emits the document header, observer and both service families", async () => {
    const config = await inConfig([makeTunnel()]);

    expect(config.log).toEqual({ level: "fatal" });
    expect(config.tls).toMatchObject({
      validity: "8760h",
      commonName: "panel.example.test",
      organization: "panel.example.test",
    });
    expect(config.observers).toEqual([
      { name: "observer", plugin: { type: "http", addr: "https://panel.example.test/api/tunnel/observer" } },
    ]);

    expect(config.services.map((s) => s.name)).toEqual(["tcp-1", "udp-1"]);
    const tcp = config.services[0];
    expect(tcp.addr).toBe("0.0.0.0:1234");
    expect(tcp.handler).toMatchObject({ type: "tcp" });
    expect(tcp.listener).toEqual({ type: "tcp" });
    expect(tcp.observer).toBe("observer");
    expect(tcp.metadata).toMatchObject({
      enableStats: true,
      "observer.resetTraffic": true,
      "observer.period": "30s",
    });
    const udp = config.services[1];
    expect(udp.listener).toEqual({ type: "udp", metadata: { keepalive: true } });
    expect(udp.handler).toMatchObject({ type: "udp" });
  });

  it("sorts weighted forward nodes into the service forwarder by descending weight", async () => {
    const config = await inConfig([makeTunnel()]);
    // Without an out-node group or chain the forward addresses live on the
    // service forwarder; the chain exists but has no hops yet.
    expect(config.chains).toEqual([{ name: "1", hops: [] }]);
    expect(config.services[0].forwarder).toEqual({
      nodes: [
        { name: "10.0.0.1:80", addr: "10.0.0.1:80", metadata: { weight: "5" } },
        { name: "10.0.0.2:80", addr: "10.0.0.2:80", metadata: { weight: "1" } },
      ],
      selector: { strategy: "round" },
    });
  });

  it("uses WAIT_LISTEN when the tunnel has no fixed port", async () => {
    const config = await inConfig([makeTunnel({ listen_port: null })], ":10000-20000");
    expect(config.services[0].addr).toBe("0.0.0.0:WAIT_LISTEN:10000-20000");
  });

  it("carries the listen protocol handler and auth onto both services", async () => {
    const config = await inConfig(
      [
        makeTunnel({
          listen_protocol: { type: "ss", username: "user-1", password: "pass-1" },
        }),
      ],
      null,
      true,
    );
    const [tcp, udp] = config.services;
    expect(tcp.handler).toMatchObject({
      type: "ss",
      auth: { username: "user-1", password: "pass-1" },
    });
    expect(udp.handler).toMatchObject({
      type: "ssu",
      auth: { username: "user-1", password: "pass-1" },
    });
  });

  it("ignores the listen protocol when the node group disallows it", async () => {
    const config = await inConfig(
      [makeTunnel({ listen_protocol: { type: "ss", username: "u", password: "p" } })],
      null,
      false,
    );
    expect(config.services[0].handler).toMatchObject({ type: "tcp" });
    expect(config.services[0].handler.auth).toBeUndefined();
  });

  it("maps tunnel limits to gost limiters and climiters", async () => {
    const limits = new Map([
      [1, { ip_limit: 5, bandwidth_limit: 8, client_limit: 10, climiter_name: "c-1", limiter_name: "l-1" }],
    ]);
    const config = (await service.getInNodeConfig(
      groupId,
      null,
      false,
      [makeTunnel()] as never,
      {},
      limits as never,
    )) as { services: Json[]; climiters: Json[]; limiters: Json[] };

    expect(config.climiters).toEqual([{ name: "c-1", limits: ["$ 5"] }]);
    // bandwidth_limit is bits/s; gost wants MB/s.
    expect(config.limiters).toEqual([{ name: "l-1", limits: ["$ 1MB 1MB"] }]);
    expect(config.services[0].climiter).toBe("c-1");
    expect(config.services[0].limiter).toBe("l-1");
    expect(config.services[0].metadata).toMatchObject({ maxClients: "10" });
  });

  it("wires bypass and admission from the node group row", async () => {
    await db.nodeGroup.update({
      where: { id: groupId },
      data: { bypass_type: "whitelist", bypass_list: ["1.2.3.4"], admission: true },
    });
    const config = await inConfig([
      makeTunnel({ user: { id: 1, user_plan: { whitelist_ips: ["9.9.9.9"], plan: {} } } }),
    ]);

    expect(config.bypasses).toEqual([{ name: `bypass-${groupId}`, whitelist: true, matchers: ["1.2.3.4"] }]);
    expect(config.admissions).toEqual([{ name: "admission-1", whitelist: true, matchers: ["9.9.9.9"] }]);
    expect(config.services[0].bypass).toBe(`bypass-${groupId}`);
    expect(config.services[0].admission).toBe("admission-1");

    await db.nodeGroup.update({
      where: { id: groupId },
      data: { bypass_list: [], admission: false },
    });
  });

  it("adds the shared relay listener for remote port forwards", async () => {
    const config = await inConfig(
      [makeTunnel({ id: 3, category: "remote_port_forward", listen_port: null })],
      ":20000-30000",
    );
    expect(config.services).toEqual([
      expect.objectContaining({
        name: "tcp",
        addr: ":WAIT_LISTEN:20000-30000",
        listener: { type: "tcp", metadata: { keepalive: undefined } },
        handler: { type: "relay", metadata: { bind: true, nodelay: true } },
      }),
    ]);
  });

  it("emits only the udp service for a udp tunnel type", async () => {
    const config = await inConfig([makeTunnel({ tunnel_type: "udp" })]);
    expect(config.services.map((s) => s.name)).toEqual(["udp-1"]);
    expect(config.services[0].handler).toMatchObject({ type: "udp" });
  });

  it("wires wireguard listeners through the tungo handler", async () => {
    const config = await inConfig(
      [
        makeTunnel({
          listen_protocol: {
            type: "wireguard",
            privateKey: "priv-key",
            mtu: 1300,
            peers: [{ publicKey: "pub-1", allowedIPs: "0.0.0.0/0" }, { publicKey: "pub-2" }],
          },
        }),
      ],
      null,
      true,
    );
    const wg = config.services[0];
    expect(wg.name).toBe("wg-1");
    expect(wg.handler).toMatchObject({ type: "tungo" });
    expect(wg.listener).toMatchObject({
      type: "wireguard",
      metadata: {
        privateKey: "priv-key",
        mtu: "1300",
        peers: [
          { publicKey: "pub-1", allowedIPs: ["10.66.0.2/32"] },
          { publicKey: "pub-2", allowedIPs: ["10.66.0.3/32"] },
        ],
      },
    });
  });

  it("wires a vless listener through reality with the user map", async () => {
    const config = await inConfig(
      [
        makeTunnel({
          listen_protocol: {
            type: "vless",
            uuid: "uuid-1",
            privateKey: "reality-priv",
            dest: "www.example.com",
            shortId: "abcd",
          },
        }),
      ],
      null,
      true,
    );
    const svc = config.services[0];
    expect(svc.name).toBe("tcp-1");
    expect(svc.handler).toMatchObject({
      type: "vless",
      metadata: { users: { user: "uuid-1" } },
    });
    expect(svc.listener).toMatchObject({
      type: "reality",
      metadata: {
        privateKey: "reality-priv",
        dest: "www.example.com:443",
        shortId: "abcd",
      },
    });
  });

  it("uses the protocol username as the vless user key when present", async () => {
    const config = await inConfig(
      [makeTunnel({ listen_protocol: { type: "vless", username: "alice", uuid: "uuid-2" } })],
      null,
      true,
    );
    expect(config.services[0].handler).toMatchObject({
      metadata: { users: { alice: "uuid-2" } },
    });
    expect(config.services[0].listener).toMatchObject({ metadata: { dest: "www.apple.com:443" } });
  });

  it("wires a mieru listener with its user map and defaults", async () => {
    const config = await inConfig(
      [makeTunnel({ listen_protocol: { type: "mieru", username: "mu", password: "mp" } })],
      null,
      true,
    );
    const svc = config.services[0];
    expect(svc.name).toBe("mieru-1");
    expect(svc.handler).toMatchObject({ type: "mieru" });
    expect(svc.listener).toEqual({
      type: "mieru",
      metadata: { users: { mu: "mp" }, mtu: 1400, protocol: "tcp" },
    });
  });

  it("drops a mieru tunnel without credentials", async () => {
    const config = await inConfig(
      [makeTunnel({ listen_protocol: { type: "mieru", username: "mu" } })],
      null,
      true,
    );
    expect(config.services).toEqual([]);
  });

  it("wires an openvpn listener through tungo with its PKI material", async () => {
    const config = await inConfig(
      [
        makeTunnel({
          listen_protocol: {
            type: "openvpn",
            udp: true,
            ca: "CA-PEM",
            cert: "CERT-PEM",
            key: "KEY-PEM",
            tlsCrypt: "TC-KEY",
            server: "10.9.0.0/24",
            cipher: "AES-128-GCM",
            auth: "SHA1",
            mtu: 1400,
          },
        }),
      ],
      null,
      true,
    );
    const svc = config.services[0];
    expect(svc.name).toBe("ovpn-1");
    expect(svc.handler).toMatchObject({ type: "tungo" });
    expect(svc.listener).toEqual({
      type: "openvpn",
      metadata: {
        udp: true,
        ca: "CA-PEM",
        cert: "CERT-PEM",
        key: "KEY-PEM",
        tlsCrypt: "TC-KEY",
        server: "10.9.0.0/24",
        cipher: "AES-128-GCM",
        auth: "SHA1",
        mtu: "1400",
      },
    });
  });

  it("includes only tunnels that belong to the requested in-node-group", async () => {
    const config = await inConfig([
      makeTunnel({ id: 7, in_node_group_id: groupId + 1 }),
      makeTunnel({ id: 8, listen_port: 8080 }),
    ]);
    expect(config.services.map((s) => s.name)).toEqual(["tcp-8", "udp-8"]);
    expect(config.chains.map((c) => c.name)).toEqual(["8"]);
  });
});

describe("pure helpers", () => {
  it("picks a connect IP by family", () => {
    expect(service.getConnectIP("1.2.3.4,::1", "ipv4" as never)).toBe("1.2.3.4");
    expect(service.getConnectIP("1.2.3.4,::1", "ipv6" as never)).toBe("::1");
    expect(service.getConnectIP("1.2.3.4,::1", "auto" as never)).toBe("1.2.3.4");
    // The split does not trim, so a spaced entry matches only via "auto".
    expect(service.getConnectIP("1.2.3.4, ::1", "ipv6" as never)).toBeUndefined();
    expect(service.getConnectIP("::1", "ipv4" as never)).toBeUndefined();
    // An empty value is returned verbatim for "auto", but never for a family.
    expect(service.getConnectIP("", "auto" as never)).toBe("");
    expect(service.getConnectIP("", "ipv4" as never)).toBeUndefined();
  });

  it("takes the smaller of two optional limits", () => {
    expect(service.minLimit(5, 3)).toBe(3);
    expect(service.minLimit(5, null)).toBe(5);
    expect(service.minLimit(null, 7)).toBe(7);
    expect(service.minLimit(null, null)).toBeUndefined();
    // `a ?? b` keeps a deliberate 0 (recovered behaviour).
    expect(service.minLimit(0, 4)).toBe(0);
  });

  it("strips private keys from a listen protocol", () => {
    expect(
      service.sanitizeListenProtocol({
        type: "wireguard",
        privateKey: "secret",
        key: "secret2",
        mtu: 1420,
        peers: [],
      }),
    ).toEqual({ type: "wireguard", mtu: 1420, peers: [] });
    expect(service.sanitizeListenProtocol(null)).toBeNull();
    expect(service.sanitizeListenProtocol([1, 2])).toBeNull();
  });
});

describe("getTunnelChainsFromTunnel", () => {
  const nodes = [
    { id: 1, node_id: "node-1", connect_ip: "10.0.0.1", weight: 1, backup: false },
    { id: 2, node_id: "node-2", connect_ip: "10.0.0.2", weight: 9, backup: true },
    { id: 3, node_id: "node-3", connect_ip: "", weight: 5, backup: false },
  ];
  const tunnel = {
    ip_type: "ipv4",
    tunnel_chains: [
      {
        id: 10,
        node_type: "in",
        node_group_id: 1,
        node_group: { load_balance_type: "round", nodes },
      },
      {
        id: 11,
        node_type: "out",
        node_group_id: 2,
        node_group: { load_balance_type: "hash", nodes },
      },
    ],
  };

  it("splits in and out hops, sorts by weight and skips unusable nodes", () => {
    const { in_hops, out_hops } = service.getTunnelChainsFromTunnel(tunnel as never, {
      "1:tcp": "1001",
      "2:tcp": "1002",
      "3:tcp": "1003",
    });
    expect(in_hops).toHaveLength(1);
    expect(in_hops[0]).toMatchObject({ name: "hop-10", selector: { strategy: "round" } });
    expect((in_hops[0].nodes as unknown[]).map((n) => (n as { name: string }).name)).toEqual([
      "node-2",
      "node-1",
    ]);
    expect((in_hops[0].nodes as { addr: string }[])[0].addr).toBe("10.0.0.2:1002");
    expect(out_hops[0]).toMatchObject({ name: "hop-11", selector: { strategy: "hash" } });
  });

  it("drops nodes without a cached port", () => {
    const { in_hops } = service.getTunnelChainsFromTunnel(tunnel as never, { "1:tcp": "1001" });
    expect((in_hops[0].nodes as unknown[]).length).toBe(1);
  });
});

describe("getOutNodeConfig", () => {
  async function outConfig(tunnels: unknown[], portRange: string | null = null) {
    return (await service.getOutNodeConfig(groupId, portRange, tunnels as never, {}, new Map())) as {
      services: Json[];
    };
  }

  it("emits one WAIT_LISTEN service per tunnel type", async () => {
    const config = await outConfig(
      [
        makeTunnel({
          id: 1,
          out_node_group_id: groupId,
          out_node_group: { user_id: 1, load_balance_type: "round", nodes: [] },
        }),
        makeTunnel({
          id: 2,
          tunnel_type: "udp",
          out_node_group_id: groupId,
          out_node_group: { user_id: 1, load_balance_type: "round", nodes: [] },
        }),
      ],
      ":30000-40000",
    );
    expect(config.services.map((s) => s.name).sort()).toEqual(["tcp", "udp"]);
    const tcp = config.services.find((s) => s.name === "tcp")!;
    expect(tcp).toMatchObject({
      addr: ":WAIT_LISTEN:30000-40000",
      listener: { type: "tcp", metadata: {} },
      handler: { type: "relay", metadata: { nodelay: true } },
    });
    const udp = config.services.find((s) => s.name === "udp")!;
    expect(udp).toMatchObject({
      listener: { type: "udp", metadata: { keepalive: true } },
      handler: { type: "ssu" },
    });
  });

  it("adds the relayx listener key", async () => {
    const config = await outConfig([
      makeTunnel({
        tunnel_type: "relayx",
        out_node_group_id: groupId,
        out_node_group: { user_id: 1, load_balance_type: "round", nodes: [] },
      }),
    ]);
    const relayx = config.services.find((s) => s.name === "relayx")!;
    expect(relayx.listener).toMatchObject({ type: "relayx" });
    expect((relayx.listener as { metadata: { key: string } }).metadata.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("adds a tcp service when a chain references the out group", async () => {
    const config = await outConfig([
      makeTunnel({
        category: "remote_port_forward",
        out_node_group_id: groupId,
        out_node_group: { user_id: 1, load_balance_type: "round", nodes: [] },
        tunnel_chains: [
          { id: 5, node_type: "out", node_group_id: groupId, node_group: { node_type: "out", nodes: [] } },
        ],
      }),
    ]);
    expect(config.services.map((s) => s.name)).toContain("tcp");
  });
});
