/**
 * SQLite persistence — a direct port of `Store` in
 * `relayx-analysis/relayx_license_server.py`, including the exact DDL.
 *
 * Uses the built-in `node:sqlite` module (Node >= 22.5, unflagged since 23.4) so the app
 * needs no Prisma schema and no native addon. The schema is byte-for-byte the reference
 * one: timestamps are TEXT ISO strings (the license server is a standalone SQLite database,
 * *not* the panel's Prisma database whose DateTime columns are unix milliseconds).
 */

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import type { ContentMode } from "./config";
import { RELAYX_AGENT_LICENSE_SECRET } from "./config";
import { buildContent, licensePayload } from "./content";
import { isoInDays, unixSeconds, utcnow } from "./time";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS licenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_url    TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'business',
    content     TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL DEFAULT 'active',   -- active | revoked
    expired_at  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_site ON licenses(site_url, status);

CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT    NOT NULL UNIQUE,
    site_url    TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    cycle       TEXT    NOT NULL,
    pay_type    TEXT,
    amount      REAL    NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'success',
    created_at  TEXT    NOT NULL
);
`;

/** Shape the panel consumes (`GET /license`, `POST /license` → `license`). */
export interface LicenseContent {
  site_url: string;
  type: string;
  expired_at: string;
  created_at: string;
  content: string;
}

/** Full row as printed by the `list` CLI command. */
export interface LicenseRecord extends LicenseContent {
  id: number;
  status: string;
  updated_at: string;
}

/** One row of `GET /license/history` → `data[]`. */
export interface OrderSummary {
  order_id: string;
  site_url: string;
  type: string;
  cycle: string;
  pay_type: string | null;
  amount: number;
  status: string;
  created_at: string;
}

export interface HistoryPage {
  data: OrderSummary[];
  total: number;
}

export interface LicenseStoreOptions {
  contentMode?: ContentMode;
  fernetSecret?: string;
}

function asText(value: SQLOutputValue | undefined): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}

function asNullableText(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

export class LicenseStore {
  /** Mode used for `content` generation when `issue()` is not given an explicit one. */
  readonly contentMode: ContentMode;
  private readonly fernetSecret: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: LicenseStoreOptions = {}) {
    this.contentMode = options.contentMode ?? "plain";
    this.fernetSecret = options.fernetSecret ?? RELAYX_AGENT_LICENSE_SECRET;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  // ── licenses ────────────────────────────────────────────────────────────────

  /** Issue a new license or renew the active one for `siteUrl`. Idempotent per site. */
  issue(
    siteUrl: string,
    type: string,
    days: number,
    contentMode: ContentMode = this.contentMode,
    fernetSecret: string = this.fernetSecret,
  ): LicenseContent {
    const issued = new Date();
    const now = utcnow(issued);
    const expiredAt = isoInDays(days, issued);
    const expiredUnix = unixSeconds(new Date(issued.getTime() + days * 86_400_000));
    const content = buildContent(
      contentMode,
      licensePayload(siteUrl, type, expiredUnix, unixSeconds(issued)),
      fernetSecret,
    );

    const existing = this.db
      .prepare("SELECT * FROM licenses WHERE site_url=? AND status='active'")
      .get(siteUrl);
    if (existing) {
      // Python: renew an existing license — only type/expiry/updated_at change.
      this.db
        .prepare("UPDATE licenses SET type=?, expired_at=?, updated_at=? WHERE id=?")
        .run(type, expiredAt, now, asNumber(existing["id"]));
    } else {
      this.db
        .prepare(
          "INSERT INTO licenses (site_url,type,content,status,expired_at,created_at,updated_at)"
            + " VALUES (?,?,?,'active',?,?,?)",
        )
        .run(siteUrl, type, content, expiredAt, now, now);
    }

    const license = this.get(siteUrl);
    if (!license) {
      throw new Error(`签发授权失败: ${siteUrl}`);
    }
    return license;
  }

  /** Active license for `siteUrl`, or `null` when the panel is unlicensed (404). */
  get(siteUrl: string): LicenseContent | null {
    const row = this.db
      .prepare("SELECT * FROM licenses WHERE site_url=? AND status='active'")
      .get(siteUrl);
    if (!row) return null;
    return {
      site_url: asText(row["site_url"]),
      type: asText(row["type"]),
      expired_at: asText(row["expired_at"]),
      created_at: asText(row["created_at"]),
      content: asText(row["content"]),
    };
  }

  /** Re-bind a license (matched by its opaque `content`) to a new domain. */
  rebind(content: string, newSiteUrl: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE licenses SET site_url=?, updated_at=? WHERE content=? AND status='active'",
      )
      .run(newSiteUrl, utcnow(), content);
    return result.changes > 0;
  }

  /** Mark every active license for `siteUrl` as revoked. */
  revoke(siteUrl: string): number {
    const result = this.db
      .prepare(
        "UPDATE licenses SET status='revoked', updated_at=? WHERE site_url=? AND status='active'",
      )
      .run(utcnow(), siteUrl);
    return Number(result.changes);
  }

  /** Every license row, newest first — `list` CLI command. */
  all(): LicenseRecord[] {
    return this.db
      .prepare("SELECT * FROM licenses ORDER BY id DESC")
      .all()
      .map((row) => ({
        id: asNumber(row["id"]),
        site_url: asText(row["site_url"]),
        type: asText(row["type"]),
        content: asText(row["content"]),
        status: asText(row["status"]),
        expired_at: asText(row["expired_at"]),
        created_at: asText(row["created_at"]),
        updated_at: asText(row["updated_at"]),
      }));
  }

  // ── orders ──────────────────────────────────────────────────────────────────

  /** Record a successful order (`POST /license` behaves as "payment succeeded"). */
  addOrder(
    siteUrl: string,
    type: string,
    cycle: string,
    payType: string | null,
  ): string {
    // Python: secrets.token_hex(8) → 16 lowercase hex chars.
    const id = randomBytes(8).toString("hex");
    this.db
      .prepare(
        "INSERT INTO orders (order_id,site_url,type,cycle,pay_type,status,created_at)"
          + " VALUES (?,?,?,?,?,'success',?)",
      )
      .run(id, siteUrl, type, cycle, payType, utcnow());
    return id;
  }

  /** Paginated order history — `GET /license/history`. */
  history(siteUrl: string, page: number, limit: number): HistoryPage {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) c FROM orders WHERE site_url=?")
      .get(siteUrl);
    const total = asNumber(totalRow?.["c"]);
    const rows = this.db
      .prepare(
        "SELECT order_id,site_url,type,cycle,pay_type,amount,status,created_at FROM orders"
          + " WHERE site_url=? ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(siteUrl, limit, (page - 1) * limit);
    return {
      data: rows.map((row) => ({
        order_id: asText(row["order_id"]),
        site_url: asText(row["site_url"]),
        type: asText(row["type"]),
        cycle: asText(row["cycle"]),
        pay_type: asNullableText(row["pay_type"]),
        amount: asNumber(row["amount"]),
        status: asText(row["status"]),
        created_at: asText(row["created_at"]),
      })),
      total,
    };
  }

  close(): void {
    this.db.close();
  }
}
