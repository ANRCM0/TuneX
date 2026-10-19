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
  service = new Service({} as never, {} as never, {} as never, {
    getConfig: async () => 30,
  } as never);
  const group = await db.nodeGroup.create({
    data: { name: "in-group", node_type: "in", user_id: (await db.user.create({ data: { email: "t@example.test" } })).id },
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

    expect(config.bypasses).toEqual([
      { name: `bypass-${groupId}`, whitelist: true, matchers: ["1.2.3.4"] },
    ]);
    expect(config.admissions).toEqual([
      { name: "admission-1", whitelist: true, matchers: ["9.9.9.9"] },
    ]);
    expect(config.services[0].bypass).toBe(`bypass-${groupId}`);
    expect(config.services[0].admission).toBe("admission-1");

    await db.nodeGroup.update({
      where: { id: groupId },
      data: { bypass_list: [], admission: false },
    });
  });

  it("adds the shared relay listener for remote port forwards", async () => {
    const config = await inConfig([
      makeTunnel({ id: 3, category: "remote_port_forward", listen_port: null }),
    ], ":20000-30000");
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

  it("includes only tunnels that belong to the requested in-node-group", async () => {
    const config = await inConfig([
      makeTunnel({ id: 7, in_node_group_id: groupId + 1 }),
      makeTunnel({ id: 8, listen_port: 8080 }),
    ]);
    expect(config.services.map((s) => s.name)).toEqual(["tcp-8", "udp-8"]);
    expect(config.chains.map((c) => c.name)).toEqual(["8"]);
  });
});
