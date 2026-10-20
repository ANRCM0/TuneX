/**
 * `GET /metrics` — Prometheus exposition.
 *
 * Gated exactly like the other diagnostics: `DIAG_TOKEN` (Bearer) when configured, loopback
 * otherwise, so an exposed panel does not publish its traffic shape to the internet.
 */
import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "@hono/node-server/conninfo";
import { DIAG_TOKEN } from "../config";
import { render, setGauge } from "../services/metrics";
import { db } from "../db";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

function isLoopback(c: Parameters<typeof getConnInfo>[0]): boolean {
  try {
    const address = getConnInfo(c).remote.address ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  } catch {
    return false;
  }
}

/** Refresh the cheap domain gauges before exposition so a scrape reflects the current DB. */
async function refreshGauges(): Promise<void> {
  try {
    const [users, nodes, nodesOnline, tunnels, tunnelsActive, ticketsOpen] = await Promise.all([
      db.user.count(),
      db.node.count(),
      db.node.count({ where: { status: "active" } }),
      db.tunnel.count(),
      db.tunnel.count({ where: { status: "active" } }),
      db.ticket.count({ where: { status: "open" } }),
    ]);
    setGauge("relayx_users_total", users);
    setGauge("relayx_nodes_total", nodes);
    setGauge("relayx_nodes_active", nodesOnline);
    setGauge("relayx_tunnels_total", tunnels);
    setGauge("relayx_tunnels_active", tunnelsActive);
    setGauge("relayx_tickets_open", ticketsOpen);
    setGauge("relayx_db_up", 1);
  } catch {
    // The endpoint still answers when the database is mid-migration, but the scrape says so:
    // `relayx_db_up 0` makes the empty gauges explicit instead of silent.
    setGauge("relayx_db_up", 0);
  }
}

app.get("/", async (c) => {
  if (DIAG_TOKEN) {
    // `bearerAuth` declares its own env; cast so it can run inside `AppEnv`
    // (same pattern as the API-key fallback in middlewares/auth.ts).
    const auth = bearerAuth({ token: DIAG_TOKEN }) as unknown as (
      ctx: Context<AppEnv>,
      next: () => Promise<void>,
    ) => Promise<Response | void>;
    return auth(c, async () => {
      await refreshGauges();
      c.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      c.res = c.body(render()) as never;
    });
  }
  if (!isLoopback(c)) {
    throw new HTTPException(404, { message: "Not Found" });
  }
  await refreshGauges();
  c.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
  return c.body(render());
});

export default app;
