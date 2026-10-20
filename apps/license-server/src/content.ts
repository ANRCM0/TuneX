/**
 * `content` generation — ported from `Store.content_for()` in
 * `relayx-analysis/relayx_license_server.py`.
 *
 * The backend never parses `content` (it only forwards it to the Agent on registration,
 * see LICENSE_SERVER_GUIDE.md §7), so all three modes are wire-compatible with the panel:
 *
 *   plain  → `selfhosted-<24 random bytes as urlsafe base64>`
 *   base64 → urlsafe base64 of the JSON payload               (human-inspectable)
 *   fernet → Fernet token of the JSON payload, keyed with the agent-only
 *            license secret (upstream key2). The panel forwards `content`
 *            unchanged; the agent decrypts it and checks `site_url` / `expired_at`.
 */

import { randomBytes } from "node:crypto";
import type { ContentMode } from "./config";
import { fernetEncrypt, urlSafeBase64Encode } from "./fernet";
import { unixSeconds } from "./time";

/** Payload embedded in `base64` / `fernet` content modes. */
export interface LicensePayload {
  v: 1;
  type: string;
  site_url: string;
  /** Unix seconds. The agent compares this with the register ack's `now`. */
  expired_at: number;
  edition: "self-hosted";
  iat: number;
}

export function licensePayload(
  siteUrl: string,
  type: string,
  expiredAt: number,
  issuedAt: number = unixSeconds(),
): LicensePayload {
  return {
    v: 1,
    type,
    site_url: siteUrl,
    expired_at: expiredAt,
    edition: "self-hosted",
    iat: issuedAt,
  };
}

/** Compact JSON (no spaces) — identical to Python's `json.dumps(..., separators=(",", ":"))`. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Build the opaque `content` string for the given mode. */
export function buildContent(mode: ContentMode, payload: LicensePayload, fernetSecret: string): string {
  switch (mode) {
    case "fernet":
      return fernetEncrypt(fernetSecret, Buffer.from(compactJson(payload), "utf8"));
    case "base64":
      return urlSafeBase64Encode(Buffer.from(compactJson(payload), "utf8"));
    case "plain":
    default:
      // Python: "selfhosted-" + secrets.token_urlsafe(24) — 24 random bytes, urlsafe b64.
      return `selfhosted-${randomBytes(24).toString("base64url")}`;
  }
}
