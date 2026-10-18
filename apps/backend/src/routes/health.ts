import { Hono } from "hono";
import type { EventEmitter } from "node:events";
import { DIAG_TOKEN } from "../config";
import { db } from "../db";
import { getIo } from "../services/io-registry";
import { client } from "../services/redis";

/** Upstream: src/routes/health.ts (98 lines) — ported verbatim. */
const app = new Hono();

function eventNamesToObj(emitter: { eventNames(): (string | symbol)[]; listenerCount(e: string | symbol): number }) {
  return Object.fromEntries(emitter.eventNames().map((e) => [String(e), emitter.listenerCount(e)]));
}

app.get("/", async (c) => {
  const checks: { db?: string; redis?: string } = {};
  try {
    await db.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }
  try {
    await client.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "error";
  }
  const status = Object.values(checks).every((v) => v === "ok") ? "ok" : "error";
  return c.json({ status, checks }, status === "ok" ? 200 : 503);
});

function diagAuthorized(c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }) {
  const token = c.req.header("x-diag-token") ?? c.req.query("token");
  return Boolean(DIAG_TOKEN) && token === DIAG_TOKEN;
}

app.get("/diag", async (c) => {
  if (!diagAuthorized(c)) {
    return c.json({ error: "Not Found" }, 404);
  }
  const mem = process.memoryUsage();
  let socketio: Record<string, unknown>;
  try {
    const io = getIo();
    const adapter = io.of("/").adapter;
    const rooms: { name: string; size: number }[] = [];
    for (const [name, sids] of adapter.rooms.entries()) {
      rooms.push({ name, size: sids.size });
    }
    rooms.sort((a, b) => b.size - a.size);
    socketio = {
      clientsCount: io.engine.clientsCount,
      localSockets: io.sockets.sockets.size,
      roomCount: adapter.rooms.size,
      sidCount: adapter.sids.size,
      topRooms: rooms.slice(0, 15),
      ioListeners: eventNamesToObj(io as unknown as EventEmitter),
      ...(c.req.query("gc") === "1" ? { gc: "skipped (not running under Bun)" } : {}),
    };
  } catch (err) {
    socketio = { error: (err as Error).message };
  }
  return c.json({
    pid: process.pid,
    uptime_sec: Math.round(process.uptime()),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    socketio,
    process_listeners: eventNamesToObj(process),
    redis_listeners: eventNamesToObj(client as unknown as EventEmitter),
  });
});

app.get("/heap", async (c) => {
  if (!diagAuthorized(c)) {
    return c.json({ error: "Not Found" }, 404);
  }
  return c.json({ error: "Not running under Bun" }, 500);
});

export default app;
