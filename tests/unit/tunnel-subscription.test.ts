/**
 * Subscription output (`generateSubscription` / `generateClashSubscription`).
 *
 * These are the client-facing strings users paste into Shadowrocket/v2rayN/Clash, so a
 * regression is immediately visible. The suite uses the temp database for the plan and
 * tunnel rows and compares the generated text for the four protocol families plus the
 * gating rules (no plan, expired plan, exhausted traffic, inactive or portless tunnels).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { TunnelService } from "../../apps/backend/src/services/tunnel";

const temp: TempDatabase = createTempDatabase("subscription");

let db: PrismaClient;
let service: TunnelService;
let planId = 0;
let groupId = 0;
let userSeq = 0;
let tunnelSeq = 0;

const config: Record<string, unknown> = { SITE_NAME: "RelayX Test" };

async function makeUserWithPlan(options: { expiredAt?: Date | null; traffic?: number | null; used?: number } = {}) {
  userSeq += 1;
  const user = await db.user.create({ data: { email: `sub-${userSeq}@example.test` } });
  await db.userPlan.create({
    data: {
      user_id: user.id,
      plan_id: planId,
      expired_at: options.expiredAt === undefined ? new Date(Date.now() + 86400_000) : options.expiredAt,
      traffic: options.traffic ?? null,
      traffic_used: options.used ?? 0,
    },
  });
  return user;
}

async function makeTunnel(
  userId: number,
  overrides: Record<string, unknown> = {},
) {
  tunnelSeq += 1;
  return db.tunnel.create({
    data: {
      name: `Tunnel ${tunnelSeq}`,
      user_id: userId,
      in_node_group_id: groupId,
      listen_port: 20000 + tunnelSeq,
      listen_protocol: { type: "ss", username: "ssuser", password: "sspass" },
      forward_addresses: [],
      load_balance_type: "round",
      ...overrides,
    } as never,
  });
}

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.example.test";
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { TunnelService: Service } = await import("../../apps/backend/src/services/tunnel");
  service = new Service({} as never, {} as never, {} as never, {
    getConfig: async (name: string) => config[name],
  } as never);

  planId = (
    await db.plan.create({
      data: {
        name: "sub-plan",
        price: 0,
        allow_custom_in_node_group: false,
        allow_custom_out_node_group: false,
        all_in_node_groups: false,
        all_out_node_groups: false,
      },
    })
  ).id;

  const owner = await db.user.create({ data: { email: "owner@example.test" } });
  groupId = (
    await db.nodeGroup.create({
      data: { name: "in-group", node_type: "in", connect_ip: "203.0.113.9", user_id: owner.id },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

describe("generateSubscription", () => {
  it("returns an empty string without a plan", async () => {
    const user = await db.user.create({ data: { email: "no-plan@example.test" } });
    expect(await service.generateSubscription(user.id)).toBe("");
  });

  it("returns an empty string for an expired plan", async () => {
    const user = await makeUserWithPlan({ expiredAt: new Date(Date.now() - 1000) });
    await makeTunnel(user.id);
    expect(await service.generateSubscription(user.id)).toBe("");
  });

  it("returns an empty string when the traffic quota is spent", async () => {
    const user = await makeUserWithPlan({ traffic: 100, used: 100 });
    await makeTunnel(user.id);
    expect(await service.generateSubscription(user.id)).toBe("");
  });

  it("emits the shadowsocks line and the site intro", async () => {
    const user = await makeUserWithPlan();
    const tunnel = await makeTunnel(user.id, { name: "Tunnel A", listen_port: 21001 });

    const lines = (await service.generateSubscription(user.id)).split("\n");
    expect(lines).toHaveLength(2);
    const expected = `ss://${Buffer.from("ssuser:sspass").toString("base64")}@203.0.113.9:21001#${encodeURIComponent("Tunnel A")}`;
    expect(lines[1]).toBe(expected);
    expect(lines[0]).toBe(
      `${expected.split("#")[0]}#${encodeURIComponent("RelayX Test https://panel.example.test")}`,
    );
    expect(tunnel.listen_port).toBe(21001);
  });

  it("skips inactive tunnels and tunnels without a listen port", async () => {
    const user = await makeUserWithPlan();
    await makeTunnel(user.id, { status: "inactive", name: "off" });
    await makeTunnel(user.id, { listen_port: null, name: "no-port" });
    await makeTunnel(user.id, { name: "live" });

    const lines = (await service.generateSubscription(user.id)).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(encodeURIComponent("live"));
  });

  it("renders vless/reality, wireguard and mieru share links", async () => {
    const user = await makeUserWithPlan();
    await makeTunnel(user.id, {
      name: "vless",
      listen_protocol: {
        type: "vless",
        uuid: "11111111-2222-4333-8444-555555555555",
        publicKey: "pub-key",
        shortId: "abcd",
        dest: "www.example.com:443",
      },
    });
    await makeTunnel(user.id, {
      name: "wg",
      listen_protocol: {
        type: "wireguard",
        clientPrivateKey: "client-priv",
        publicKey: "server-pub",
        peers: [{ allowedIPs: ["10.66.0.2/32"] }],
      },
    });
    await makeTunnel(user.id, {
      name: "mieru",
      listen_protocol: { type: "mieru", username: "mu", password: "mp", mtu: 1400 },
    });

    const lines = (await service.generateSubscription(user.id)).split("\n");
    const vless = lines.find((line) => line.startsWith("vless://"))!;
    expect(vless).toContain("security=reality");
    expect(vless).toContain("pbk=pub-key");
    expect(vless).toContain("sid=abcd");
    expect(vless).toContain("sni=www.example.com");

    const wg = lines.find((line) => line.startsWith("wg://"))!;
    expect(wg).toContain("publicKey=server-pub");
    expect(wg).toContain("privateKey=client-priv");
    expect(wg).toContain("ip=10.66.0.2");

    const mieru = lines.find((line) => line.startsWith("mierus://"))!;
    expect(mieru).toContain("mu:mp@");
    expect(mieru).toContain("mtu=1400");

    const v2rayN = await service.generateSubscription(user.id, "v2rayn");
    expect(v2rayN).toContain("wireguard://client-priv@");
  });

  it("orders tunnels by order_by descending and then id", async () => {
    const user = await makeUserWithPlan();
    await makeTunnel(user.id, { name: "low", order_by: 10 });
    await makeTunnel(user.id, { name: "high", order_by: 9000 });

    const lines = (await service.generateSubscription(user.id)).split("\n");
    expect(lines[1]).toContain(encodeURIComponent("high"));
    expect(lines[2]).toContain(encodeURIComponent("low"));
  });
});

describe("generateClashSubscription", () => {
  it("emits proxies and a select group, deduplicating names", async () => {
    const user = await makeUserWithPlan();
    await makeTunnel(user.id, { name: "dup" });
    await makeTunnel(user.id, { name: "dup" });

    const clash = await service.generateClashSubscription(user.id);
    expect(clash).toContain("proxies:");
    expect(clash).toContain("proxy-groups:");
    expect(clash).toContain("type: ss");
    expect(clash).toContain("server: 203.0.113.9");
    expect(clash).toContain("cipher: ssuser");
    expect(clash).toContain("password: sspass");
    expect(clash).toMatch(/name: dup\n/);
    expect(clash).toMatch(/name: "dup#\d+"/);
    expect(clash).toContain("type: select");
  });
});
