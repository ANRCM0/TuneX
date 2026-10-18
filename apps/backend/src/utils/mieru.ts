import crypto from "crypto";

/**
 * Upstream: src/utils/mieru.ts (29 lines) — ported 1:1.
 */

export const DEFAULT_MIERU_MTU = 1400;
export const DEFAULT_MIERU_TRANSPORT_PROTOCOL = "tcp";

export interface MieruPeer {
  username?: string | null;
  password?: string | null;
}

export interface MieruListenProtocol {
  type?: string | null;
  username?: string | null;
  password?: string | null;
  mtu?: number | null;
  transportProtocol?: string | null;
  mieruPeers?: MieruPeer[] | null;
  [key: string]: unknown;
}

export function generateMieruUsername(): string {
  return `user_${crypto.randomBytes(4).toString("hex")}`;
}

export function generateMieruPassword(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildMieruSimpleShareUrl(
  lp: MieruListenProtocol,
  server: string,
  port: number,
  name: string,
): string | null {
  const username = lp.username;
  const password = lp.password;
  if (!username || !password) {
    return null;
  }
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const transport = (lp.transportProtocol ?? DEFAULT_MIERU_TRANSPORT_PROTOCOL).toUpperCase();
  const params = new URLSearchParams({
    profile: name,
    port: String(port),
    protocol: transport === "UDP" ? "UDP" : "TCP",
    mtu: String(lp.mtu ?? DEFAULT_MIERU_MTU),
    multiplexing: "MULTIPLEXING_LOW",
  });
  const query = params.toString().replace(/\+/g, "%20");
  return `mierus://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}?${query}#${encodeURIComponent(name)}`;
}
