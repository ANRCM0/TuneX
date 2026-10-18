import crypto from "crypto";

/**
 * Upstream: src/utils/wireguard.ts (70 lines) — ported 1:1.
 *
 * Deviations: none. `crypto.generateKeyPairSync("x25519")` is a Node built-in, so the
 * recovered node-forge-free implementation carries over verbatim.
 */

export interface WireGuardPeer {
  publicKey: string;
  allowedIPs: string[];
  presharedKey?: string | null;
  persistentKeepalive?: number | null;
}

export interface WireGuardListenProtocol {
  type?: string | null;
  privateKey?: string | null;
  publicKey?: string | null;
  clientPrivateKey?: string | null;
  mtu?: number | null;
  dns?: string[] | null;
  clientAllowedIPs?: string[] | null;
  peers?: WireGuardPeer[] | null;
  [key: string]: unknown;
}

export function generateWireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const privKeyDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: privKeyDer.subarray(privKeyDer.length - 32).toString("base64"),
    publicKey: pubKeyDer.subarray(pubKeyDer.length - 32).toString("base64"),
  };
}

const DEFAULT_WG_CLIENT_ADDRESS = "10.66.0.2/32";
const DEFAULT_WG_CLIENT_IP = "10.66.0.2";

function cleanList(values: string[] | null | undefined): string[] {
  return values?.map((v) => v.trim()).filter(Boolean) ?? [];
}

function isDefaultRoute(value: string): boolean {
  const v = value.includes("/") ? value : `${value}/0`;
  return v === "0.0.0.0/0" || v === "::/0";
}

function stripCidr(value: string): string {
  const idx = value.indexOf("/");
  return idx === -1 ? value : value.slice(0, idx);
}

export function buildWireGuardShadowrocketUrl(
  lp: WireGuardListenProtocol,
  server: string,
  port: number,
  name: string,
): string | null {
  const clientPrivateKey = lp.clientPrivateKey;
  const serverPublicKey = lp.publicKey;
  if (!clientPrivateKey || !serverPublicKey) {
    return null;
  }
  const peer = lp.peers?.[0];
  const peerAddrs = cleanList(peer?.allowedIPs).filter((v) => !isDefaultRoute(v));
  const ip = stripCidr(peerAddrs[0] ?? DEFAULT_WG_CLIENT_IP);
  const dns = cleanList(lp.dns);
  const params: string[] = [];
  params.push(`publicKey=${encodeURIComponent(serverPublicKey)}`);
  params.push(`privateKey=${encodeURIComponent(clientPrivateKey)}`);
  params.push(`ip=${ip}`);
  params.push(`mtu=${lp.mtu ?? 1420}`);
  params.push("udp=1");
  params.push(`keepalive=${peer?.persistentKeepalive ?? 25}`);
  if (dns.length > 0) {
    params.push(`dns=${encodeURIComponent(dns.join(","))}`);
  }
  if (peer?.presharedKey) {
    params.push(`presharedKey=${encodeURIComponent(peer.presharedKey)}`);
  }
  return `wg://${server}:${port}?${params.join("&")}#${encodeURIComponent(name)}`;
}

export function buildWireGuardV2rayNUrl(
  lp: WireGuardListenProtocol,
  server: string,
  port: number,
  name: string,
): string | null {
  const clientPrivateKey = lp.clientPrivateKey;
  const serverPublicKey = lp.publicKey;
  if (!clientPrivateKey || !serverPublicKey) {
    return null;
  }
  const peer = lp.peers?.[0];
  const peerAddrs = cleanList(peer?.allowedIPs).filter((v) => !isDefaultRoute(v));
  const address = peerAddrs.length > 0 ? peerAddrs.join(",") : DEFAULT_WG_CLIENT_ADDRESS;
  const params: string[] = [];
  params.push(`publickey=${encodeURIComponent(serverPublicKey)}`);
  if (peer?.presharedKey) {
    params.push(`presharedkey=${encodeURIComponent(peer.presharedKey)}`);
  }
  params.push(`address=${encodeURIComponent(address)}`);
  if (lp.mtu) {
    params.push(`mtu=${lp.mtu}`);
  }
  return `wireguard://${encodeURIComponent(clientPrivateKey)}@${server}:${port}/?${params.join("&")}#${encodeURIComponent(name)}`;
}
