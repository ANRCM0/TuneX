/**
 * HTTP surface — a route-for-route port of `Handler` in
 * `relayx-analysis/relayx_license_server.py`.
 *
 * Endpoint table (identical status codes / bodies / content types to the Python reference):
 *
 *   GET  /health                       200 {"ok":true,"ts":<ISO>}
 *   GET  /license?site_url=…           200 LicenseContent | 400 {"error":"site_url is required"}
 *                                      | 404 {"error":"license not found"}
 *   POST /license                      200 {"url","trade_id","order_id","license","status"}
 *                                      | 400 {"error":"site_url is required"}
 *   PUT  /license                      200 {"ok":true,"site_url"} | 400 | 404
 *   GET  /license/history?site_url=…   200 {"data":[…],"total":n}
 *   GET  /pay                          200 []
 *   GET  /coupon?…                     404 {"error":"coupon not supported by self-hosted license server"}
 *   *    everything else               404 {"error":"not found"}
 *
 * Trailing slashes are ignored (`/license/` == `/license`), mirroring the Python
 * `urlparse(path).rstrip("/")`.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentMode } from "./config";
import { RELAYX_AGENT_LICENSE_SECRET } from "./config";
import type { LicenseStore } from "./store";
import { utcnow } from "./time";

/** `CYCLE_DAYS` from the Python reference: license length per payment cycle. */
export const CYCLE_DAYS: Record<string, number> = {
  month: 30,
  quarter: 91,
  half_year: 182,
  year: 365,
  lifetime: 36_500,
};
const DEFAULT_CYCLE = "year";
const DEFAULT_CYCLE_DAYS = 365;
const DEFAULT_LICENSE_TYPE = "business";

/** Statuses this server ever produces with a JSON error body. */
type JsonErrorStatus = 400 | 404;

export interface LicenseServerAppOptions {
  /** Content encoding used for newly issued licenses. */
  contentMode?: ContentMode;
  /** Fernet key for `content-mode=fernet`; defaults to the shared backend secret. */
  fernetSecret?: string;
  /** Log requests to stderr (Python `--verbose`, the default). */
  verbose?: boolean;
  /** Sink for request log lines; defaults to stderr. */
  logger?: (line: string) => void;
}

/** `_err(code, msg)` from the Python reference: `{"error": msg}` + status. */
function jsonError(c: Context, status: JsonErrorStatus, message: string): Response {
  return c.json({ error: message }, status);
}

/** Query-string value or `""` — Python's `(q.get(key) or [""])[0]`. */
function queryValue(c: Context, key: string): string {
  return c.req.query(key) ?? "";
}

/**
 * Python `int()` over the query string, but falling back instead of raising:
 * the reference answers 500 on a non-numeric `page`/`limit`.
 */
function queryInteger(c: Context, key: string, fallback: number): number {
  const raw = queryValue(c, key).trim();
  if (raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Request body as a plain object. Mirrors `_read_json()`:
 * empty / malformed / non-dict bodies all collapse to `{}`.
 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return {};
  }
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/**
 * String field with Python truthiness: strings pass through, numbers/booleans are
 * stringified only when truthy, missing/null/object values become `null`.
 */
function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return value === 0 ? null : String(value);
  if (typeof value === "boolean") return value ? "true" : null;
  return null;
}

export function createApp(store: LicenseStore, options: LicenseServerAppOptions = {}): Hono {
  const contentMode = options.contentMode ?? store.contentMode;
  const fernetSecret = options.fernetSecret ?? RELAYX_AGENT_LICENSE_SECRET;
  const app = new Hono({ strict: false });

  if (options.verbose) {
    const sink = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
    app.use("*", async (c, next) => {
      const startedAt = Date.now();
      await next();
      const elapsed = Date.now() - startedAt;
      const url = new URL(c.req.url);
      sink(`${utcnow()} ${c.req.method} ${url.pathname}${url.search} -> ${c.res.status} (${elapsed}ms)`);
    });
  }

  // ── health ─────────────────────────────────────────────────────────────────

  app.get("/health", (c) => c.json({ ok: true, ts: utcnow() }));

  // ── GET /license ───────────────────────────────────────────────────────────

  app.get("/license", (c) => {
    const siteUrl = queryValue(c, "site_url");
    if (!siteUrl) return jsonError(c, 400, "site_url is required");
    const license = store.get(siteUrl);
    if (!license) return jsonError(c, 404, "license not found");
    return c.json(license);
  });

  // ── GET /license/history ───────────────────────────────────────────────────

  app.get("/license/history", (c) => {
    const siteUrl = queryValue(c, "site_url");
    const page = Math.max(1, queryInteger(c, "page", 1));
    const limit = Math.min(200, Math.max(1, queryInteger(c, "limit", 10)));
    return c.json(store.history(siteUrl, page, limit));
  });

  // ── GET /pay ───────────────────────────────────────────────────────────────

  // The self-hosted server has no payment gateways; the panel renders an empty list.
  app.get("/pay", (c) => c.json([]));

  // ── GET /coupon ────────────────────────────────────────────────────────────

  app.get("/coupon", (c) => jsonError(c, 404, "coupon not supported by self-hosted license server"));

  // ── POST /license ──────────────────────────────────────────────────────────

  app.post("/license", async (c) => {
    const body = await readJsonBody(c);
    const siteUrl = stringField(body, "site_url");
    if (!siteUrl) return jsonError(c, 400, "site_url is required");

    const type = stringField(body, "type") || DEFAULT_LICENSE_TYPE;
    const cycle = stringField(body, "cycle") || DEFAULT_CYCLE;
    const days = CYCLE_DAYS[cycle] ?? DEFAULT_CYCLE_DAYS;
    const payType = stringField(body, "pay_type");
    const redirectUrl = stringField(body, "redirect_url") || "/";

    // In self-hosted mode a paid order succeeds immediately: record it, then issue.
    const orderId = store.addOrder(siteUrl, type, cycle, payType);
    const license = store.issue(siteUrl, type, days, contentMode, fernetSecret);

    return c.json({
      url: redirectUrl,
      trade_id: orderId,
      order_id: orderId,
      license,
      status: "success",
    });
  });

  // ── PUT /license ───────────────────────────────────────────────────────────

  app.put("/license", async (c) => {
    const body = await readJsonBody(c);
    const siteUrl = stringField(body, "site_url");
    const content = stringField(body, "content");
    if (!siteUrl || !content) {
      return jsonError(c, 400, "site_url and content are required");
    }
    if (!store.rebind(content, siteUrl)) {
      return jsonError(c, 404, "license content not found");
    }
    return c.json({ ok: true, site_url: siteUrl });
  });

  // ── everything else ────────────────────────────────────────────────────────

  app.notFound((c) => jsonError(c, 404, "not found"));

  return app;
}
