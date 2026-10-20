/**
 * Backend socket handlers that previously had no vitest coverage:
 * register rejection, the 60s register block, and listen_error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";

const temp: TempDatabase = createTempDatabase("socket-handlers");

type Handler = (
  data: Record<string, unknown>,
  callback?: (result: { error?: string }) => void,
) => Promise<void>;

let db: PrismaClient;
let register: (socket: unknown) => void;
let listenError: (socket: unknown) => void;
let redis: {
  setLicense: (license: unknown) => Promise<void>;
  delLicense: () => Promise<void>;
  delRegisterBlock: (token: string) => Promise<void>;
};

function capture(token: string) {
  const handlers = new Map<string, Handler>();
  const socket = {
    data: { token },
    handshake: { address: "203.0.113.8", headers: {} as Record<string, string> },
    on(event: string, fn: Handler) {
      handlers.set(event, fn);
    },
  };
  return { socket, handlers };
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  process.env.REDIS_URL = "";
  process.env.SITE_URL = "https://panel.test";
  process.env.LICENSE_URL = "http://127.0.0.1:9";
  vi.stubGlobal(
    "fetch",
    async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
  );
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const registerModule = await import("../../apps/backend/src/socket-io/handlers/register");
  const listenModule = await import("../../apps/backend/src/socket-io/handlers/listen");
  const redisModule = await import("../../apps/backend/src/services/redis");
  register = registerModule.register as (socket: unknown) => void;
  listenError = listenModule.listenError as (socket: unknown) => void;
  redis = redisModule.redisService;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.tunnel.deleteMany();
  await db.nodeGroup.deleteMany();
  await db.user.deleteMany();
  await redis.delLicense();
  await redis.delRegisterBlock("tok");
});

describe("register", () => {
  it("rejects a missing license and then repeats the block", async () => {
    const { socket, handlers } = capture("tok");
    register(socket);
    const first = await call(handlers, "register", {});
    expect(first).toEqual({ error: "无有效授权，请联系管理员" });
    await redis.setLicense({
      expired_at: "2099-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
      site_url: "https://panel.test",
      type: "business",
      content: "ok",
    });
    const second = await call(handlers, "register", {});
    expect(second).toEqual({ error: "无有效授权，请联系管理员" });
  });

  it("rejects an expired ISO license timestamp", async () => {
    await redis.setLicense({
      expired_at: "2000-01-01T00:00:00.000Z",
      created_at: "1999-01-01T00:00:00.000Z",
      site_url: "https://panel.test",
      type: "business",
      content: "old",
    });
    const { socket, handlers } = capture("tok");
    register(socket);
    await expect(call(handlers, "register", {})).resolves.toEqual({ error: "License 已过期，请联系管理员" });
  });
});

describe("listen_error", () => {
  it("marks the tunnel inactive only for ERR_PORT_IN_USE", async () => {
    const user = await db.user.create({ data: { email: "owner@example.test" } });
    const group = await db.nodeGroup.create({
      data: { name: "in", node_type: "in", user_id: user.id },
    });
    const tunnel = await db.tunnel.create({
      data: {
        name: "t",
        user_id: user.id,
        in_node_group_id: group.id,
        load_balance_type: "round",
        forward_addresses: [],
        status: "active",
      },
    });
    const { socket, handlers } = capture("tok");
    listenError(socket);
    await handlers.get("listen_error")!({ name: "not-a-tunnel", error: "ERR_PORT_IN_USE" });
    await handlers.get("listen_error")!({ name: `tcp-${tunnel.id}`, error: "ERR_OTHER" });
    expect((await db.tunnel.findUnique({ where: { id: tunnel.id } }))?.status).toBe("active");
    await handlers.get("listen_error")!({ name: `udp-${tunnel.id}`, error: "ERR_PORT_IN_USE" });
    const updated = await db.tunnel.findUnique({ where: { id: tunnel.id } });
    expect(updated?.status).toBe("inactive");
    expect(updated?.port_conflict_at).toBeInstanceOf(Date);
  });
});

async function call(
  handlers: Map<string, Handler>,
  event: string,
  data: Record<string, unknown>,
): Promise<{ error?: string }> {
  let result: { error?: string } = {};
  await handlers.get(event)!(data, (value) => {
    result = value;
  });
  return result;
}
