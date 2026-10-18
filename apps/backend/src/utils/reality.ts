import crypto from "crypto";

/**
 * Upstream: src/utils/reality.ts (49 lines) — ported 1:1 (the VLESS/REALITY helpers).
 */

export const DEFAULT_REALITY_DEST = "www.apple.com:443";
export const DEFAULT_VLESS_USER = "user";
export const VLESS_FLOW = "xtls-rprx-vision";
export const VLESS_FINGERPRINT = "chrome";

export interface RealityListenProtocol {
  type?: string | null;
  uuid?: string | null;
  username?: string | null;
  publicKey?: string | null;
  privateKey?: string | null;
  dest?: string | null;
  shortId?: string | null;
  [key: string]: unknown;
}

export function generateRealityKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const privKeyDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: privKeyDer.subarray(privKeyDer.length - 32).toString("base64url"),
    publicKey: pubKeyDer.subarray(pubKeyDer.length - 32).toString("base64url"),
  };
}

export function generateRealityShortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function normalizeRealityDest(dest?: string | null): string {
  const value = dest?.trim();
  if (!value) {
    return DEFAULT_REALITY_DEST;
  }
  return value.includes(":") ? value : `${value}:443`;
}

export function realityServerName(dest?: string | null): string {
  const value = normalizeRealityDest(dest);
  return value.slice(0, value.lastIndexOf(":"));
}

export function buildVlessRealityUrl(
  lp: RealityListenProtocol,
  server: string,
  port: number,
  name: string,
): string | null {
  if (!lp.uuid || !lp.publicKey) {
    return null;
  }
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const params = [
    "type=tcp",
    "encryption=none",
    "security=reality",
    `flow=${VLESS_FLOW}`,
    `fp=${VLESS_FINGERPRINT}`,
    `sni=${encodeURIComponent(realityServerName(lp.dest))}`,
    `pbk=${encodeURIComponent(lp.publicKey)}`,
  ];
  if (lp.shortId) {
    params.push(`sid=${encodeURIComponent(lp.shortId)}`);
  }
  return `vless://${lp.uuid}@${host}:${port}?${params.join("&")}#${encodeURIComponent(name)}`;
}
