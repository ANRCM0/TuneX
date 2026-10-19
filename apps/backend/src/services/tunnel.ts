import { createHash, randomUUID } from "crypto";
import { isIPv4, isIPv6 } from "net";
import { HTTPException } from "hono/http-exception";
import {
  BypassType,
  IpType,
  NodeType,
  Status,
  SystemConfigName,
  TunnelCategory,
  TunnelType,
} from "@prisma/client";
import { SITE_URL } from "../config";
import { db, type Prisma } from "../db";
import { logger } from "../logger";
import { instance, service, TOKENS } from "../container";
import { formatIP, joinIPAndPort } from "../utils/ip";
import {
  buildWireGuardShadowrocketUrl,
  buildWireGuardV2rayNUrl,
  generateWireGuardKeyPair,
} from "../utils/wireguard";
import { generateOpenVpnPki, generateTlsCryptKey } from "../utils/openvpn";
import {
  DEFAULT_MIERU_MTU,
  DEFAULT_MIERU_TRANSPORT_PROTOCOL,
  buildMieruSimpleShareUrl,
  generateMieruPassword,
  generateMieruUsername,
} from "../utils/mieru";
import {
  DEFAULT_VLESS_USER,
  VLESS_FINGERPRINT,
  VLESS_FLOW,
  buildVlessRealityUrl,
  generateRealityKeyPair,
  generateRealityShortId,
  normalizeRealityDest,
  realityServerName,
} from "../utils/reality";
import { licenseExpired, type LicenseService } from "./license";
import type { NodeGroupService } from "./node_group";
import type { RedisService } from "./redis";
import type { SystemConfigService } from "./system_config";
import { fernetService } from "./fernet";
import { getIo } from "./io-registry";

/**
 * Upstream: src/services/tunnel.ts (2010 decompiled lines) — ported 1:1.
 *
 * Deviations (both forced by the frozen dependency set, see docs/DEVIATIONS.md):
 *   - `lodash` (`orderBy`, `min`, `isEmpty`) is replaced with the small local helpers at
 *     the bottom of this file. Behaviour for the call sites here is identical.
 *   - `js-yaml` is replaced by a minimal YAML emitter; the Clash base document is embedded
 *     verbatim from the recovered `config.yaml`. The produced document has the same shape
 *     (`proxies` + `proxy-groups` appended to the recovered rules).
 *   - `uuid.v4` is `crypto.randomUUID()`; `uuid.v5(SITE_URL, uuid.URL)` is the SHA-1 UUIDv5
 *     implementation at the bottom of this file.
 */

const DEFAULT_WIREGUARD_CLIENT_ALLOWED_IPS = ["0.0.0.0/0"];
const DEFAULT_WIREGUARD_DNS = ["1.1.1.1"];
const DEFAULT_OPENVPN_CIPHER = "AES-256-GCM";
const DEFAULT_OPENVPN_AUTH = "SHA256";
const DEFAULT_OPENVPN_MTU = 1500;
const DEFAULT_OPENVPN_SERVER = "10.8.0.0/24";

/** `uuid.URL` namespace used by the recovered `v5(SITE_URL, v5.URL)` call. */
const UUID_URL_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

type JsonRecord = Record<string, any>;

interface ForwardAddress {
  address: string;
  weight: number;
  host?: string | null;
}

interface TunnelLimit {
  ip_limit?: number;
  client_limit?: number;
  bandwidth_limit?: number;
  climiter_name?: string;
  limiter_name?: string;
}

/** Structural subset of a tunnel the availability filter needs. */
interface FilterableTunnel {
  id: number;
  user_id: number;
  in_node_group: { user_id: number };
  out_node_group: { user_id: number } | null;
  user: {
    user_plan: {
      traffic_used: number;
      max_tunnels: number | null;
      traffic: number | null;
      plan: {
        max_tunnels: number | null;
        traffic: number | null;
        all_in_node_groups: boolean;
        all_out_node_groups: boolean;
        node_groups: { node_group_id: number }[];
      };
    } | null;
  };
}

type AvailableTunnel = Prisma.TunnelGetPayload<{
  include: {
    user: { include: { user_plan: { include: { plan: { include: { node_groups: true } } } } } };
    out_node_group: { include: { nodes: true } };
    in_node_group: { include: { nodes: true } };
    tunnel_chains: { include: { node_group: { include: { nodes: true } } } };
  };
}>;

function cleanStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function asRecord(value: unknown): JsonRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  return null;
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isWireGuardDefaultRoute(value: string): boolean {
  return value === "0.0.0.0/0" || value === "::/0";
}

function defaultWireGuardPeerAllowedIPs(peerIndex: number): string[] {
  return [`10.66.0.${peerIndex + 2}/32`];
}

function normalizeWireGuardPeerAllowedIPs(allowedIPs: unknown, peerIndex: number): string[] {
  const values = cleanStringList(allowedIPs).filter((value) => !isWireGuardDefaultRoute(value));
  return values.length > 0 ? values : defaultWireGuardPeerAllowedIPs(peerIndex);
}

/** `uuid.v5(name, uuid.URL)` — SHA-1 based UUIDv5. */
function uuidV5(name: string, namespace: string = UUID_URL_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `lodash.orderBy(collection, path, order)`. */
function orderByPath<T>(collection: T[], path: string, order: "asc" | "desc"): T[] {
  const read = (item: unknown): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
        item,
      );
  return [...collection].sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    if (typeof av === "string" && typeof bv === "string") {
      // lodash compares strings with < / > (code-unit order), not locale collation.
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return order === "desc" ? -cmp : cmp;
    }
    const an = Number(av);
    const bn = Number(bv);
    const cmp = an < bn ? -1 : an > bn ? 1 : 0;
    return order === "desc" ? -cmp : cmp;
  });
}

/** `lodash.isEmpty` for the plain object shapes used here. */
function isEmptyObject(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

// ── Clash base document (recovered config.yaml, embedded verbatim) ──────────────
const CLASH_BASE_CONFIG = `log-level: error
external-controller: 0.0.0.0:9090
mode: rule
rule-providers:
  icloud:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt
    path: ./ruleset/icloud.yaml
    interval: 86400
  apple:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt
    path: ./ruleset/apple.yaml
    interval: 86400
  google:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/google.txt
    path: ./ruleset/google.yaml
    interval: 86400
  proxy:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt
    path: ./ruleset/proxy.yaml
    interval: 86400
  direct:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt
    path: ./ruleset/direct.yaml
    interval: 86400
  private:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt
    path: ./ruleset/private.yaml
    interval: 86400
  gfw:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt
    path: ./ruleset/gfw.yaml
    interval: 86400
  tld-not-cn:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/tld-not-cn.txt
    path: ./ruleset/tld-not-cn.yaml
    interval: 86400
  telegramcidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/telegramcidr.txt
    path: ./ruleset/telegramcidr.yaml
    interval: 86400
  cncidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt
    path: ./ruleset/cncidr.yaml
    interval: 86400
  lancidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/lancidr.txt
    path: ./ruleset/lancidr.yaml
    interval: 86400
  applications:
    type: http
    behavior: classical
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt
    path: ./ruleset/applications.yaml
    interval: 86400
rules:
  - RULE-SET,applications,DIRECT
  - RULE-SET,private,DIRECT
  - RULE-SET,icloud,DIRECT
  - RULE-SET,apple,DIRECT
  - RULE-SET,proxy,proxy
  - RULE-SET,direct,DIRECT
  - RULE-SET,lancidr,DIRECT
  - RULE-SET,cncidr,DIRECT
  - RULE-SET,telegramcidr,proxy
  - RULE-SET,gfw,proxy
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT`;

function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (s === "") return '""';
  if (/[:#,[\]{}&*?|<>=!%@`"']/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

/** Minimal YAML emitter for the Clash `proxies` / `proxy-groups` shapes. */
function emitYaml(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          return `${pad}-\n${emitYaml(item, indent + 2)}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([key, v]) => {
        if (v !== null && typeof v === "object") {
          return `${pad}${key}:\n${emitYaml(v, indent + 2)}`;
        }
        if (v === null) return `${pad}${key}: null`;
        return `${pad}${key}: ${yamlScalar(v)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

export class TunnelService {
  constructor(
    private readonly redisService: RedisService,
    private readonly nodeGroupService: NodeGroupService,
    private readonly licenseService: LicenseService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  minLimit(a?: number | null, b?: number | null): number | undefined {
    if (a && b) return Math.min(a, b);
    return a ?? b ?? undefined;
  }

  sanitizeListenProtocol(lp: unknown): JsonRecord | null {
    const protocol = asRecord(lp);
    if (!protocol) return null;
    const { privateKey: _privateKey, key: _key, ...rest } = protocol;
    return rest;
  }

  prepareListenProtocol(nextInput: unknown, prevInput?: unknown): JsonRecord | null {
    const next = asRecord(nextInput);
    if (!next) return null;
    const prev = asRecord(prevInput);
    if (next.type === "openvpn") {
      return this.prepareOpenVpnListenProtocol(next, prev);
    }
    if (next.type === "vless") {
      return this.prepareVlessListenProtocol(next, prev);
    }
    if (next.type === "mieru") {
      return this.prepareMieruListenProtocol(next, prev);
    }
    if (next.type !== "wireguard") {
      return {
        type: next.type,
        username: next.username ?? null,
        password: next.password ?? null,
      };
    }
    const result: JsonRecord = {
      type: next.type,
      privateKey: next.privateKey ?? null,
      publicKey: next.publicKey ?? null,
      clientPrivateKey: next.clientPrivateKey ?? null,
      mtu: next.mtu ?? null,
      clientAllowedIPs: next.clientAllowedIPs ?? null,
      dns: next.dns ?? null,
      peers: next.peers ?? null,
    };
    const prevIsWireguard = prev?.type === "wireguard";
    if (!result.privateKey || !result.publicKey) {
      const reusePrev = prevIsWireguard && prev?.privateKey && prev?.publicKey;
      const server = reusePrev
        ? { privateKey: prev.privateKey, publicKey: prev.publicKey }
        : generateWireGuardKeyPair();
      result.privateKey = server.privateKey;
      result.publicKey = server.publicKey;
    }
    const clientAllowedIPs = cleanStringList(result.clientAllowedIPs);
    result.clientAllowedIPs =
      clientAllowedIPs.length > 0 ? clientAllowedIPs : [...DEFAULT_WIREGUARD_CLIENT_ALLOWED_IPS];
    const dns = cleanStringList(result.dns);
    result.dns = dns.length > 0 ? dns : [...DEFAULT_WIREGUARD_DNS];
    const peers =
      result.peers && result.peers.length > 0
        ? result.peers
        : [{ publicKey: "", allowedIPs: defaultWireGuardPeerAllowedIPs(0) }];
    result.peers = peers.map((peer: JsonRecord, index: number) => {
      const allowedIPs = normalizeWireGuardPeerAllowedIPs(peer.allowedIPs, index);
      if (peer.publicKey) {
        return { ...peer, allowedIPs };
      }
      const prevPeerPublicKey = prevIsWireguard ? prev?.peers?.[0]?.publicKey : undefined;
      if (prevPeerPublicKey) {
        return { ...peer, publicKey: prevPeerPublicKey, allowedIPs };
      }
      const client = generateWireGuardKeyPair();
      result.clientPrivateKey = client.privateKey;
      return { ...peer, publicKey: client.publicKey, allowedIPs };
    });
    if (!result.clientPrivateKey && prevIsWireguard && prev?.clientPrivateKey) {
      result.clientPrivateKey = prev.clientPrivateKey;
    }
    if (!result.mtu) {
      result.mtu = 1420;
    }
    return result;
  }

  prepareVlessListenProtocol(next: JsonRecord, prev?: JsonRecord | null): JsonRecord {
    const prevIsVless = prev?.type === "vless";
    const result: JsonRecord = {
      type: "vless",
      username: next.username?.trim() || DEFAULT_VLESS_USER,
      uuid: next.uuid ?? null,
      privateKey: next.privateKey ?? null,
      publicKey: next.publicKey ?? null,
      dest: normalizeRealityDest(next.dest),
      shortId: next.shortId ?? null,
    };
    if (!result.uuid) {
      result.uuid = prevIsVless && prev?.uuid ? prev.uuid : randomUUID();
    }
    if (!result.privateKey || !result.publicKey) {
      const reusePrev = prevIsVless && prev?.privateKey && prev?.publicKey;
      const keyPair = reusePrev
        ? { privateKey: prev.privateKey, publicKey: prev.publicKey }
        : generateRealityKeyPair();
      result.privateKey = keyPair.privateKey;
      result.publicKey = keyPair.publicKey;
    }
    if (!result.shortId) {
      result.shortId = prevIsVless && prev?.shortId ? prev.shortId : generateRealityShortId();
    }
    return result;
  }

  prepareMieruListenProtocol(next: JsonRecord, prev?: JsonRecord | null): JsonRecord {
    const prevIsMieru = prev?.type === "mieru";
    const { privateKey: _pk, publicKey: _pub, ...rest } = next;
    const result: JsonRecord = { ...rest, type: "mieru" };
    const transportProtocol = (result.transportProtocol ?? DEFAULT_MIERU_TRANSPORT_PROTOCOL)
      .trim()
      .toLowerCase();
    result.transportProtocol =
      transportProtocol === "udp" || transportProtocol === "both"
        ? transportProtocol
        : DEFAULT_MIERU_TRANSPORT_PROTOCOL;
    const legacyPeer = next.mieruPeers?.[0];
    if (!result.username) {
      result.username =
        (prevIsMieru && prev?.username) || legacyPeer?.username || generateMieruUsername();
    }
    if (!result.password) {
      result.password =
        (prevIsMieru && prev?.password) || legacyPeer?.password || generateMieruPassword();
    }
    if (!result.mtu) {
      result.mtu = DEFAULT_MIERU_MTU;
    }
    return result;
  }

  prepareOpenVpnListenProtocol(next: JsonRecord, prev?: JsonRecord | null): JsonRecord {
    const result: JsonRecord = {
      type: "openvpn",
      ca: next.ca ?? null,
      cert: next.cert ?? null,
      key: next.key ?? null,
      clientCert: next.clientCert ?? null,
      clientKey: next.clientKey ?? null,
      tlsCrypt: next.tlsCrypt ?? null,
      udp: next.udp ?? null,
      cipher: next.cipher ?? null,
      auth: next.auth ?? null,
      mtu: next.mtu ?? null,
      server: next.server ?? null,
    };
    const prevIsOpenVpn = prev?.type === "openvpn";
    const hasPki = result.ca && result.cert && result.key && result.clientCert && result.clientKey;
    if (!hasPki) {
      const reusePrev =
        prevIsOpenVpn && prev?.ca && prev?.cert && prev?.key && prev?.clientCert && prev?.clientKey;
      if (reusePrev) {
        result.ca = prev.ca;
        result.cert = prev.cert;
        result.key = prev.key;
        result.clientCert = prev.clientCert;
        result.clientKey = prev.clientKey;
      } else {
        const pki = generateOpenVpnPki();
        result.ca = pki.ca;
        result.cert = pki.serverCert;
        result.key = pki.serverKey;
        result.clientCert = pki.clientCert;
        result.clientKey = pki.clientKey;
      }
    }
    if (!result.tlsCrypt) {
      result.tlsCrypt = prevIsOpenVpn && prev?.tlsCrypt ? prev.tlsCrypt : generateTlsCryptKey();
    }
    result.udp = result.udp ?? false;
    result.cipher = result.cipher || DEFAULT_OPENVPN_CIPHER;
    result.auth = result.auth || DEFAULT_OPENVPN_AUTH;
    result.mtu = result.mtu && result.mtu > 0 ? result.mtu : DEFAULT_OPENVPN_MTU;
    result.server = result.server || DEFAULT_OPENVPN_SERVER;
    return result;
  }

  computeAllLimits(allTunnels: AvailableTunnel[], limitScope: unknown): Map<number, TunnelLimit> {
    const result = new Map<number, TunnelLimit>();
    for (const t of allTunnels) {
      const plan = t.user.user_plan?.plan;
      if (limitScope === "tunnel") {
        const ip_limit = this.minLimit(t.ip_limit, plan?.ip_limit);
        const client_limit = this.minLimit(t.client_limit, plan?.client_limit);
        const bandwidth_limit = this.minLimit(t.bandwidth_limit, plan?.bandwidth_limit);
        result.set(t.id, {
          ip_limit,
          client_limit,
          bandwidth_limit,
          climiter_name: ip_limit ? `climiter-${t.id}` : undefined,
          limiter_name: bandwidth_limit ? `limiter-${t.id}` : undefined,
        });
        continue;
      }
      const ip_limit = plan?.ip_limit ?? undefined;
      const client_limit = plan?.client_limit ?? undefined;
      const bandwidth_limit = plan?.bandwidth_limit ?? undefined;
      result.set(t.id, {
        ip_limit,
        client_limit,
        bandwidth_limit,
        climiter_name: ip_limit ? `climiter-u${t.user_id}` : undefined,
        limiter_name: bandwidth_limit ? `limiter-u${t.user_id}` : undefined,
      });
    }
    return result;
  }

  async resetExpiredTunnels(): Promise<number> {
    const result = await db.tunnel.updateMany({
      where: {
        listen_port: { not: null },
        user: {
          user_plan: {
            expired_at: { lte: new Date() },
          },
        },
      },
      data: {
        listen_port: null,
      },
    });
    return result.count;
  }

  async repushWaitingTunnels(): Promise<number> {
    const WAIT_THRESHOLD_MS = 30 * 1000;
    const threshold = Date.now() - WAIT_THRESHOLD_MS;
    const allTunnels = await this.getAllAvailableTunnels();
    const isWaiting = (t: AvailableTunnel): boolean =>
      t.listen_port === null && t.updated_at.getTime() < threshold;
    const groupIds = new Set<number>();
    for (const tunnel of allTunnels.filter(isWaiting)) {
      if (tunnel.category === TunnelCategory.port_forward) {
        const groupTunnels = allTunnels.filter(
          (t) => t.in_node_group_id === tunnel.in_node_group_id,
        );
        if (
          this.filterAvailableTunnels(groupTunnels, tunnel.in_node_group_id).some(
            (t) => t.id === tunnel.id,
          )
        ) {
          groupIds.add(tunnel.in_node_group_id);
        }
      } else if (tunnel.out_node_group_id) {
        const groupTunnels = allTunnels.filter(
          (t) => t.out_node_group_id === tunnel.out_node_group_id,
        );
        if (
          this.filterAvailableTunnels(groupTunnels, undefined, tunnel.out_node_group_id).some(
            (t) => t.id === tunnel.id,
          )
        ) {
          groupIds.add(tunnel.out_node_group_id);
        }
      }
    }
    if (groupIds.size === 0) {
      return 0;
    }
    const ids = [...groupIds];
    await this.redisService.deleteNodeConfigHash(ids);
    logger.info(`Repushing config for node groups with waiting tunnels: ${ids.join(",")}`);
    return ids.length;
  }

  async getTunnels(query: Record<string, any>, user_id?: number) {
    const {
      page,
      perPage,
      sort,
      name,
      in_node_group_id,
      out_node_group_id,
      in_tunnel_chain_id,
      out_tunnel_chain_id,
      status,
      ip_type,
      tunnel_type,
      listen_port,
    } = query;
    const tunnelChainFilters: Prisma.TunnelWhereInput[] = [];
    if (in_tunnel_chain_id) {
      tunnelChainFilters.push({
        tunnel_chains: {
          some: {
            node_group_id: { in: in_tunnel_chain_id },
            node_type: "in",
          },
        },
      });
    }
    if (out_tunnel_chain_id) {
      tunnelChainFilters.push({
        tunnel_chains: {
          some: {
            node_group_id: { in: out_tunnel_chain_id },
            node_type: "out",
          },
        },
      });
    }
    const where: Prisma.TunnelWhereInput = {
      name: name ? { contains: name } : undefined,
      in_node_group_id: in_node_group_id ? { in: in_node_group_id } : undefined,
      out_node_group_id: out_node_group_id ? { in: out_node_group_id } : undefined,
      status: status ? { in: status } : undefined,
      ip_type,
      tunnel_type: tunnel_type ? { in: tunnel_type } : undefined,
      listen_port: listen_port ? { equals: listen_port } : undefined,
      user_id: user_id ?? undefined,
      ...(tunnelChainFilters.length > 0 && { AND: tunnelChainFilters }),
    };
    const orderBy = sort?.map((sort2: { id: string; desc: boolean }) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    }) as Prisma.TunnelOrderByWithRelationInput[] | undefined;
    const [data, total] = await db.$transaction([
      db.tunnel.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ order_by: "desc" }, { id: "desc" }],
        where,
        include: {
          user: {
            select: {
              email: true,
            },
          },
          in_node_group: {
            select: {
              name: true,
              traffic_rate: true,
              connect_ip: true,
              admission: true,
              nodes: {
                select: {
                  connect_ip: true,
                },
              },
            },
          },
          out_node_group: {
            select: {
              name: true,
              traffic_rate: true,
            },
          },
          tunnel_chains: {
            select: {
              node_group_id: true,
              node_type: true,
            },
          },
        },
      }),
      db.tunnel.count({ where }),
    ]);
    return {
      data: data.map((tunnel) => ({
        ...tunnel,
        forward_addresses: tunnel.forward_addresses,
        tunnel_chains: tunnel.tunnel_chains.map((chain) => {
          return {
            node_group_id: chain.node_group_id,
            node_type: chain.node_type,
          };
        }),
        listen_protocol: this.sanitizeListenProtocol(tunnel.listen_protocol),
        forward_addresses_protocol: tunnel.forward_addresses_protocol,
      })),
      total,
    };
  }

  async getTunnelTraffics(user_id: number, query: Record<string, any>) {
    const {
      page,
      perPage,
      sort,
      tunnel_name,
      in_node_group_id,
      out_node_group_id,
      start_date,
      end_date,
    } = query;
    const orderBy = sort?.map((sort2: { id: string; desc: boolean }) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    }) as Prisma.TunnelTrafficOrderByWithRelationInput[] | undefined;
    const where: Prisma.TunnelTrafficWhereInput = {
      tunnel: {
        name: tunnel_name ? { contains: tunnel_name } : undefined,
        in_node_group_id: in_node_group_id ? { equals: in_node_group_id } : undefined,
        out_node_group_id: out_node_group_id ? { equals: out_node_group_id } : undefined,
        user_id,
      },
      date: {
        gte: start_date,
        lte: end_date,
      },
    };
    const [data, total] = await db.$transaction([
      db.tunnelTraffic.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ id: "desc" }],
        where,
        select: {
          id: true,
          traffic: true,
          traffic_cost: true,
          date: true,
          tunnel: {
            select: {
              name: true,
              in_node_group: {
                select: {
                  name: true,
                },
              },
              out_node_group: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      }),
      db.tunnelTraffic.count({ where }),
    ]);
    return { data, total };
  }

  async getTunnelSummary(user_id: number) {
    const tunnels = await db.tunnel.groupBy({
      where: { user_id },
      by: ["status"],
      _count: {
        _all: true,
      },
    });
    return tunnels.map((tunnel) => ({
      status: tunnel.status,
      count: tunnel._count._all,
    }));
  }

  async deleteTunnelTraffic(): Promise<number> {
    const retentionDays = await this.systemConfigService.getConfig<number>(
      SystemConfigName.TUNNEL_TRAFFIC_RETENTION_DAYS,
    );
    const deleted = await db.tunnelTraffic.deleteMany({
      where: {
        date: {
          lt: new Date(Date.now() - 1000 * 60 * 60 * 24 * Number(retentionDays)),
        },
      },
    });
    return deleted.count;
  }

  async pushNodeConfig(): Promise<void> {
    const [groups, allTunnels, outListens, sysinfo] = await Promise.all([
      db.nodeGroup.findMany({
        select: {
          id: true,
          node_type: true,
          name: true,
          port_range: true,
          allow_listen_protocol: true,
        },
        where: {
          nodes: {
            some: { status: Status.active },
          },
        },
      }),
      this.getAllAvailableTunnels(),
      this.redisService.getAllOutListens(),
      this.redisService.getSysinfo(),
    ]);
    const aliveThreshold = Date.now() - 60 * 1000;
    const aliveGroupIds = new Set(
      Object.entries(sysinfo)
        .filter(([, nodes]) =>
          nodes.some((n) => new Date(n.last_active as string).getTime() >= aliveThreshold),
        )
        .map(([id]) => Number(id)),
    );
    const aliveGroups = groups.filter((g) => aliveGroupIds.has(g.id));
    const limitScope = await this.systemConfigService.getConfig(SystemConfigName.LIMIT_SCOPE);
    const tunnelLimits = this.computeAllLimits(allTunnels, limitScope);
    const tasks = aliveGroups.map(async (group) => {
      const config = await this.getNodeConfig(
        group.id,
        group.node_type,
        group.port_range,
        group.allow_listen_protocol,
        allTunnels,
        outListens,
        tunnelLimits,
      );
      const config_str = JSON.stringify(config);
      const old_hash = await this.redisService.getNodeConfigHash(group.id);
      const new_hash = createHash("sha256").update(config_str).digest("hex");
      if (old_hash !== new_hash) {
        await this.redisService.setNodeConfigHash(group.id, new_hash);
        logger.info(`Pushed config to node group ${group.id}#${group.name}`);
        await this.redisService.publishIoEmit(`node_group/${group.id}`, "config", [
          fernetService.encrypt(config_str),
        ]);
      }
    });
    await Promise.all(tasks);
  }

  async getAllAvailableTunnels(): Promise<AvailableTunnel[]> {
    const license = await this.licenseService.getLicense();
    if (!license || licenseExpired(license.expired_at)) {
      return [];
    }
    const tunnels = await db.tunnel.findMany({
      include: {
        user: {
          include: {
            user_plan: {
              include: {
                plan: {
                  include: {
                    node_groups: true,
                  },
                },
              },
            },
          },
        },
        out_node_group: {
          include: {
            nodes: {
              where: { status: Status.active },
              orderBy: { id: "asc" },
            },
          },
        },
        in_node_group: {
          include: {
            nodes: {
              where: { status: Status.active },
              orderBy: { id: "asc" },
            },
          },
        },
        tunnel_chains: {
          orderBy: { id: "asc" },
          include: {
            node_group: {
              include: {
                nodes: {
                  where: { status: Status.active },
                  orderBy: { id: "asc" },
                },
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
      where: {
        status: Status.active,
        user: {
          status: Status.active,
          user_plan: {
            OR: [{ expired_at: { gt: new Date() } }, { expired_at: null }],
          },
        },
      },
    });
    return tunnels as AvailableTunnel[];
  }

  filterAvailableTunnels(
    tunnels: FilterableTunnel[],
    in_node_group_id?: number,
    out_node_group_id?: number,
  ): FilterableTunnel[] {
    const available_tunnels: FilterableTunnel[] = [];
    const user_tunnels: Record<number, number> = {};
    const filtered = tunnels.filter((tunnel) => {
      if (in_node_group_id && tunnel.in_node_group.user_id !== tunnel.user_id) {
        const plan = tunnel.user.user_plan?.plan;
        if (!plan?.all_in_node_groups) {
          const nodeGroups = plan?.node_groups ?? [];
          if (
            nodeGroups.length > 0 &&
            !nodeGroups.some((g) => g.node_group_id === in_node_group_id)
          ) {
            return false;
          }
        }
      }
      if (
        out_node_group_id &&
        tunnel.out_node_group &&
        tunnel.out_node_group.user_id !== tunnel.user_id
      ) {
        const plan = tunnel.user.user_plan?.plan;
        if (!plan?.all_out_node_groups) {
          const nodeGroups = plan?.node_groups ?? [];
          if (
            nodeGroups.length > 0 &&
            !nodeGroups.some((g) => g.node_group_id === out_node_group_id)
          ) {
            return false;
          }
        }
      }
      return true;
    });
    for (const tunnel of filtered) {
      const user_id = tunnel.user_id;
      const user_plan = tunnel.user.user_plan;
      if (!user_plan) {
        continue;
      }
      const traffic_used = user_plan.traffic_used;
      const max_tunnels = user_plan.max_tunnels ?? user_plan.plan.max_tunnels;
      const traffic = user_plan.traffic ?? user_plan.plan.traffic;
      const user_tunnel_count = user_tunnels[user_id] ?? 0;
      if (max_tunnels && user_tunnel_count === max_tunnels) {
        continue;
      }
      if (traffic && traffic_used >= traffic) {
        continue;
      }
      user_tunnels[user_id] = user_tunnel_count + 1;
      available_tunnels.push(tunnel);
    }
    return available_tunnels;
  }

  async getAvailableTunnels(
    in_node_group_id: number | null,
    out_node_group_id: number | null,
  ): Promise<FilterableTunnel[]> {
    const license = await this.licenseService.getLicense();
    if (!license || licenseExpired(license.expired_at)) {
      return [];
    }
    const tunnels = await db.tunnel.findMany({
      include: {
        user: {
          include: {
            user_plan: {
              include: {
                plan: {
                  include: {
                    node_groups: true,
                  },
                },
              },
            },
          },
        },
        out_node_group: {
          include: {
            nodes: {
              where: { status: Status.active },
            },
          },
        },
        in_node_group: {
          include: {
            nodes: {
              where: { status: Status.active },
            },
          },
        },
      },
      where: {
        in_node_group_id: in_node_group_id ?? undefined,
        out_node_group_id: out_node_group_id ?? undefined,
        status: Status.active,
        user: {
          status: Status.active,
          user_plan: {
            OR: [{ expired_at: { gt: new Date() } }, { expired_at: null }],
          },
        },
      },
    });
    return this.filterAvailableTunnels(tunnels, in_node_group_id ?? undefined, out_node_group_id ?? undefined);
  }

  getConnectIP(connect_ip: string, ip_type: IpType): string | undefined {
    const connect_ips = connect_ip.split(",");
    return connect_ips.map(formatIP).find((ip) => {
      if (ip_type === IpType.ipv4) {
        return isIPv4(ip);
      } else if (ip_type === IpType.ipv6) {
        return isIPv6(ip);
      } else {
        return true;
      }
    });
  }

  async getTunnelChains(tunnel_id: number, ip_type: IpType) {
    const in_hops: JsonRecord[] = [];
    const out_hops: JsonRecord[] = [];
    const tunnel_chains = await db.tunnelChain.findMany({
      where: { tunnel_id },
      include: {
        node_group: {
          include: {
            nodes: {
              where: { status: Status.active },
              orderBy: { id: "asc" },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    for (const tunnel_chain of tunnel_chains) {
      const nodes = await Promise.all(
        tunnel_chain.node_group.nodes.map(async (node) => {
          const port = await this.redisService.getOutListen(node.id, "tcp");
          if (!port) {
            return null;
          }
          const connect_ip = this.getConnectIP(node.connect_ip, ip_type);
          if (!connect_ip) {
            return null;
          }
          return {
            name: node.node_id,
            addr: joinIPAndPort(connect_ip, Number(port)),
            connector: { type: "relay", metadata: { nodelay: true } },
            dialer: { type: "tcp" },
            metadata: { weight: node.weight.toString(), backup: node.backup },
          };
        }),
      );
      const node_type = tunnel_chain.node_type;
      const hop = {
        name: `hop-${tunnel_chain.id}`,
        selector: {
          strategy: tunnel_chain.node_group.load_balance_type,
        },
        nodes: orderByPath(
          nodes.filter((node) => node !== null),
          "metadata.weight",
          "desc",
        ),
      };
      if (node_type === NodeType.in) {
        in_hops.push(hop);
      } else {
        out_hops.push(hop);
      }
    }
    return { in_hops, out_hops };
  }

  getOutListenFromCache(
    outListens: Record<string, string>,
    node_id: number,
    type: string,
  ): string | null {
    return outListens[`${node_id}:${type}`] ?? null;
  }

  getTunnelChainsFromTunnel(tunnel: AvailableTunnel, outListens: Record<string, string>) {
    const in_hops: JsonRecord[] = [];
    const out_hops: JsonRecord[] = [];
    const ip_type = tunnel.ip_type;
    for (const tunnel_chain of tunnel.tunnel_chains) {
      const nodes = tunnel_chain.node_group.nodes
        .map((node) => {
          const port = this.getOutListenFromCache(outListens, node.id, "tcp");
          if (!port) return null;
          const connect_ip = this.getConnectIP(node.connect_ip, ip_type);
          if (!connect_ip) return null;
          return {
            name: node.node_id,
            addr: joinIPAndPort(connect_ip, Number(port)),
            connector: { type: "relay", metadata: { nodelay: true } },
            dialer: { type: "tcp" },
            metadata: { weight: node.weight.toString(), backup: node.backup },
          };
        })
        .filter((node) => node !== null);
      const hop = {
        name: `hop-${tunnel_chain.id}`,
        selector: {
          strategy: tunnel_chain.node_group.load_balance_type,
        },
        nodes: orderByPath(nodes, "metadata.weight", "desc"),
      };
      if (tunnel_chain.node_type === NodeType.in) {
        in_hops.push(hop);
      } else {
        out_hops.push(hop);
      }
    }
    return { in_hops, out_hops };
  }

  async getNodeConfig(
    node_group_id: number,
    node_type: NodeType,
    port_range: string | null,
    allow_listen_protocol: boolean,
    allTunnels: AvailableTunnel[],
    outListens: Record<string, string>,
    tunnelLimits: Map<number, TunnelLimit>,
  ): Promise<unknown> {
    switch (node_type) {
      case NodeType.in:
        return this.getInNodeConfig(
          node_group_id,
          port_range,
          allow_listen_protocol,
          allTunnels,
          outListens,
          tunnelLimits,
        );
      case NodeType.out:
        return this.getOutNodeConfig(
          node_group_id,
          port_range,
          allTunnels,
          outListens,
          tunnelLimits,
        );
    }
  }

  async getInNodeConfig(
    in_node_group_id: number,
    port_range: string | null,
    allow_listen_protocol: boolean,
    allTunnels: AvailableTunnel[],
    outListens: Record<string, string>,
    tunnelLimits: Map<number, TunnelLimit>,
  ): Promise<JsonRecord> {
    const observerPeriod = await this.systemConfigService.getConfig(
      SystemConfigName.OBSERVER_PERIOD,
    );
    const services: JsonRecord[] = [];
    const chains: JsonRecord[] = [];
    const climiters = new Map<string, JsonRecord>();
    const limiters = new Map<string, JsonRecord>();
    const in_node_group_bypass = await db.nodeGroup.findUnique({
      where: { id: in_node_group_id },
      select: { bypass_type: true, bypass_list: true, admission: true },
    });
    const bypass_list_in = asList<string>(in_node_group_bypass?.bypass_list);
    const bypass_name_in = `bypass-${in_node_group_id}`;
    const has_bypass_in = bypass_list_in.length > 0;
    const is_admission_enabled = in_node_group_bypass?.admission ?? false;
    const admissions: JsonRecord[] = [];
    const filteredTunnels = allTunnels.filter((t) => t.in_node_group_id === in_node_group_id);
    const tunnels = this.filterAvailableTunnels(filteredTunnels, in_node_group_id) as AvailableTunnel[];
    const port_forward_tunnels = tunnels.filter(
      (tunnel) => tunnel.category === TunnelCategory.port_forward,
    );
    for (const tunnel of port_forward_tunnels) {
      let listen_address: string;
      const listen_ip = tunnel.listen_ip || "";
      if (tunnel.listen_port) {
        listen_address = `${listen_ip}:${tunnel.listen_port}`;
      } else {
        listen_address = `${listen_ip}:WAIT_LISTEN${port_range ? port_range : ""}`;
      }
      const ip_type = tunnel.ip_type;
      const name = `${tunnel.id}`;
      const out_chain_nodes: JsonRecord[] = [];
      const forward_addresses = asList<ForwardAddress>(tunnel.forward_addresses);
      const forwarder_addresses_protocol = asRecord(tunnel.forward_addresses_protocol);
      let forwarder: JsonRecord | undefined;
      if (!forwarder_addresses_protocol || !forwarder_addresses_protocol.type) {
        forwarder = {
          nodes: [...forward_addresses]
            .sort((a, b) => b.weight - a.weight)
            .map((fa) => ({
              name: fa.address,
              addr: fa.address,
              filter: fa.host ? { host: fa.host } : undefined,
              metadata: {
                weight: fa.weight.toString(),
              },
            })),
          selector: {
            strategy: tunnel.load_balance_type,
          },
        };
      }
      if (tunnel.out_node_group_id) {
        const nodes = tunnel.out_node_group?.nodes ?? [];
        for (const node of nodes) {
          const port = this.getOutListenFromCache(outListens, node.id, tunnel.tunnel_type);
          if (!port) {
            continue;
          }
          const connect_ip = this.getConnectIP(node.connect_ip, ip_type);
          if (!connect_ip) {
            continue;
          }
          out_chain_nodes.push({
            name: node.node_id,
            addr: joinIPAndPort(connect_ip, Number(port)),
            connector: {
              type: tunnel.tunnel_type === TunnelType.udp ? "ssu" : "relay",
              metadata: { nodelay: true },
            },
            dialer: {
              type: tunnel.tunnel_type,
              ...(tunnel.tunnel_type === TunnelType.relayx
                ? {
                    metadata: {
                      key: uuidV5(SITE_URL),
                      host: new URL(SITE_URL).host,
                    },
                  }
                : undefined),
            },
            metadata: {
              weight: node.weight.toString(),
              backup: node.backup,
            },
          });
        }
      }
      const limits = tunnelLimits.get(tunnel.id);
      const ip_limit = limits?.ip_limit;
      const bandwidth_limit = limits?.bandwidth_limit;
      const client_limit = limits?.client_limit;
      const climiter = limits?.climiter_name;
      if (climiter && ip_limit && !climiters.has(climiter)) {
        climiters.set(climiter, {
          name: climiter,
          limits: [`$ ${ip_limit}`],
        });
      }
      const limiter = limits?.limiter_name;
      if (limiter && bandwidth_limit && !limiters.has(limiter)) {
        limiters.set(limiter, {
          name: limiter,
          limits: [`$ ${bandwidth_limit / 8}MB ${bandwidth_limit / 8}MB`],
        });
      }
      const base_service = {
        addr: listen_address,
        climiter,
        limiter,
        observer: "observer",
        forwarder,
        metadata: {
          enableStats: true,
          "observer.resetTraffic": true,
          "observer.period": `${observerPeriod}s`,
          maxClients: client_limit != null ? client_limit.toString() : undefined,
        },
      };
      let handler_type: string | undefined;
      let username: string | undefined;
      let password: string | undefined;
      const listen_protocol_obj = asRecord(tunnel.listen_protocol);
      if (listen_protocol_obj && allow_listen_protocol) {
        if (listen_protocol_obj.type) {
          handler_type = listen_protocol_obj.type;
          username = listen_protocol_obj.username;
          password = listen_protocol_obj.password;
        }
      }
      const { in_hops, out_hops } = this.getTunnelChainsFromTunnel(tunnel, outListens);
      const hops = in_hops;
      if (out_chain_nodes.length > 0) {
        hops.push({
          name: `hop-out-${name}`,
          selector: {
            strategy: tunnel.out_node_group?.load_balance_type
              ? tunnel.out_node_group.load_balance_type
              : tunnel.load_balance_type,
          },
          nodes: orderByPath(out_chain_nodes, "metadata.weight", "desc"),
        });
      }
      if (out_hops.length > 0) {
        hops.push(...out_hops);
      }
      if (forwarder_addresses_protocol && forwarder_addresses_protocol.type) {
        hops.push({
          name: `hop-forwarder-${name}`,
          selector: {
            strategy: tunnel.load_balance_type,
          },
          nodes: forward_addresses.map((fa) => ({
            name: fa.address,
            addr: fa.address,
            filter: fa.host ? { host: fa.host } : undefined,
            connector: {
              type: forwarder_addresses_protocol.type,
              auth: {
                username: forwarder_addresses_protocol.username,
                password: forwarder_addresses_protocol.password,
              },
              metadata:
                forwarder_addresses_protocol.type === "socks5"
                  ? {
                      notls: true,
                      relay: "udp",
                    }
                  : undefined,
            },
            dialer: { type: "tcp" },
            metadata: {
              weight: fa.weight.toString(),
              backup: false,
            },
          })),
        });
      }
      chains.push({
        name,
        hops,
      });
      const block_protocols = asList<string>(tunnel.in_node_group.block_protocols);
      const sniffing = block_protocols.length > 0 ? true : undefined;
      const whitelist_ips = asList<string>(tunnel.user.user_plan?.whitelist_ips);
      const has_admission = is_admission_enabled && whitelist_ips.length > 0;
      const admission_name = has_admission ? `admission-${name}` : undefined;
      if (has_admission) {
        admissions.push({
          name: `admission-${name}`,
          whitelist: true,
          matchers: whitelist_ips,
        });
      }
      if (handler_type === "wireguard" && listen_protocol_obj) {
        services.push({
          name: `wg-${name}`,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          admission: admission_name,
          handler: {
            type: "tungo",
            chain: hops.length > 0 ? name : undefined,
            metadata: {
              sniffing,
              "sniffing.fallback": sniffing ? true : undefined,
              "block.protocol": block_protocols.length > 0 ? block_protocols : undefined,
            },
          },
          listener: {
            type: "wireguard",
            metadata: {
              privateKey: listen_protocol_obj.privateKey ?? undefined,
              mtu: (listen_protocol_obj.mtu ?? 1420).toString(),
              logLevel: "verbose",
              peers: asList<JsonRecord>(listen_protocol_obj.peers).map((peer, index) => ({
                publicKey: peer.publicKey,
                allowedIPs: normalizeWireGuardPeerAllowedIPs(peer.allowedIPs, index),
                presharedKey: peer.presharedKey ?? undefined,
                persistentKeepalive:
                  peer.persistentKeepalive != null
                    ? peer.persistentKeepalive.toString()
                    : undefined,
              })),
            },
          },
          ...base_service,
        });
      } else if (handler_type === "vless" && listen_protocol_obj) {
        services.push({
          name: `tcp-${name}`,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          admission: admission_name,
          handler: {
            type: "vless",
            chain: hops.length > 0 ? name : undefined,
            metadata: {
              users: {
                [username || DEFAULT_VLESS_USER]: listen_protocol_obj.uuid,
              },
              sniffing,
            },
          },
          listener: {
            type: "reality",
            metadata: {
              privateKey: listen_protocol_obj.privateKey ?? undefined,
              dest: normalizeRealityDest(listen_protocol_obj.dest),
              shortId: listen_protocol_obj.shortId ?? undefined,
            },
          },
          ...base_service,
        });
      } else if (handler_type === "mieru" && listen_protocol_obj) {
        if (!listen_protocol_obj.username || !listen_protocol_obj.password) {
          continue;
        }
        services.push({
          name: `mieru-${name}`,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          admission: admission_name,
          handler: {
            type: "mieru",
            chain: hops.length > 0 ? name : undefined,
            metadata: {
              sniffing,
              "sniffing.fallback": sniffing ? true : undefined,
              "block.protocol": block_protocols.length > 0 ? block_protocols : undefined,
            },
          },
          listener: {
            type: "mieru",
            metadata: {
              users: {
                [listen_protocol_obj.username]: listen_protocol_obj.password,
              },
              mtu: listen_protocol_obj.mtu ?? DEFAULT_MIERU_MTU,
              protocol: listen_protocol_obj.transportProtocol ?? DEFAULT_MIERU_TRANSPORT_PROTOCOL,
            },
          },
          ...base_service,
        });
      } else if (handler_type === "openvpn" && listen_protocol_obj) {
        services.push({
          name: `ovpn-${name}`,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          admission: admission_name,
          handler: {
            type: "tungo",
            chain: hops.length > 0 ? name : undefined,
            metadata: {
              sniffing,
              "sniffing.fallback": sniffing ? true : undefined,
              "block.protocol": block_protocols.length > 0 ? block_protocols : undefined,
            },
          },
          listener: {
            type: "openvpn",
            metadata: {
              udp: listen_protocol_obj.udp ?? false,
              ca: listen_protocol_obj.ca ?? undefined,
              cert: listen_protocol_obj.cert ?? undefined,
              key: listen_protocol_obj.key ?? undefined,
              tlsCrypt: listen_protocol_obj.tlsCrypt ?? undefined,
              server: listen_protocol_obj.server ?? DEFAULT_OPENVPN_SERVER,
              cipher: listen_protocol_obj.cipher ?? DEFAULT_OPENVPN_CIPHER,
              auth: listen_protocol_obj.auth ?? DEFAULT_OPENVPN_AUTH,
              mtu: (listen_protocol_obj.mtu ?? DEFAULT_OPENVPN_MTU).toString(),
            },
          },
          ...base_service,
        });
      } else {
        if (tunnel.tunnel_type !== TunnelType.udp) {
          services.push({
            name: `tcp-${name}`,
            bypass: has_bypass_in ? bypass_name_in : undefined,
            admission: admission_name,
            handler: {
              type: handler_type ? handler_type : "tcp",
              chain: hops.length > 0 ? name : undefined,
              metadata: {
                sniffing,
                "block.protocol": block_protocols.length > 0 ? block_protocols : undefined,
                proxyProtocol: tunnel.proxy_protocol ? "1" : undefined,
                udp: handler_type === "socks5" ? true : undefined,
              },
              auth:
                username && password
                  ? {
                      username,
                      password,
                    }
                  : undefined,
            },
            listener: {
              type: "tcp",
            },
            ...base_service,
          });
        }
        services.push({
          name: `udp-${name}`,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          admission: admission_name,
          handler: {
            type: handler_type ? (handler_type === "ss" ? "ssu" : handler_type) : "udp",
            chain: hops.length > 0 ? name : undefined,
            auth:
              username && password
                ? {
                    username,
                    password,
                  }
                : undefined,
          },
          listener: {
            type: "udp",
            metadata: {
              keepalive: true,
            },
          },
          ...base_service,
        });
      }
    }
    if (tunnels.some((tunnel) => tunnel.category === TunnelCategory.remote_port_forward)) {
      const tunnel_types = new Set<TunnelType>(tunnels.map((tunnel) => tunnel.tunnel_type));
      for (const tunnel_type of tunnel_types) {
        services.push({
          name: tunnel_type,
          bypass: has_bypass_in ? bypass_name_in : undefined,
          addr: `:WAIT_LISTEN${port_range ? port_range : ""}`,
          handler: {
            type: tunnel_type === TunnelType.udp ? "ssu" : "relay",
            metadata: {
              bind: true,
              nodelay: true,
            },
          },
          listener: {
            type: tunnel_type,
            metadata: {
              keepalive: tunnel_type === TunnelType.udp ? true : undefined,
            },
          },
        });
      }
    }
    const existsInChains = allTunnels.some((t) =>
      t.tunnel_chains.some(
        (c) => c.node_group_id === in_node_group_id && c.node_group.node_type === NodeType.in,
      ),
    );
    if (existsInChains) {
      services.push({
        name: "chain",
        bypass: has_bypass_in ? bypass_name_in : undefined,
        addr: `:WAIT_LISTEN${port_range ? port_range : ""}`,
        listener: {
          type: "tcp",
        },
        handler: {
          type: "relay",
          metadata: {
            nodelay: true,
          },
        },
        metadata: {
          enableStats: true,
          "observer.resetTraffic": true,
          "observer.period": `${observerPeriod}s`,
        },
      });
    }
    const bypasses_in = has_bypass_in
      ? [
          {
            name: bypass_name_in,
            whitelist: in_node_group_bypass?.bypass_type === BypassType.whitelist,
            matchers: bypass_list_in,
          },
        ]
      : [];
    const config: JsonRecord = {
      log: {
        level: "fatal",
      },
      tls: {
        validity: "8760h",
        commonName: new URL(SITE_URL).hostname,
        organization: new URL(SITE_URL).hostname,
      },
      services,
      chains,
      climiters: Array.from(climiters.values()),
      limiters: Array.from(limiters.values()),
      bypasses: bypasses_in,
      admissions,
      observers: [
        {
          name: "observer",
          plugin: {
            type: "http",
            addr: `${SITE_URL}/api/tunnel/observer`,
          },
        },
      ],
    };
    return config;
  }

  async getOutNodeConfig(
    out_node_group_id: number,
    port_range: string | null,
    allTunnels: AvailableTunnel[],
    outListens: Record<string, string>,
    tunnelLimits: Map<number, TunnelLimit>,
  ): Promise<JsonRecord> {
    const services: JsonRecord[] = [];
    const chains: JsonRecord[] = [];
    const node_group = await db.nodeGroup.findUnique({
      where: { id: out_node_group_id },
      select: { block_protocols: true },
    });
    const block_protocols = asList<string>(node_group?.block_protocols);
    const filteredTunnels = allTunnels.filter((t) => t.out_node_group_id === out_node_group_id);
    const tunnels = this.filterAvailableTunnels(
      filteredTunnels,
      undefined,
      out_node_group_id,
    ) as AvailableTunnel[];
    const climiters = new Map<string, JsonRecord>();
    const limiters = new Map<string, JsonRecord>();
    const port_forward_tunnels = tunnels.filter(
      (tunnel) => tunnel.category === TunnelCategory.port_forward,
    );
    const tunnel_types = new Set<TunnelType>(port_forward_tunnels.map((t) => t.tunnel_type));
    const existsInChains = allTunnels.some((t) =>
      t.tunnel_chains.some(
        (c) => c.node_group_id === out_node_group_id && c.node_group.node_type === NodeType.out,
      ),
    );
    if (existsInChains) {
      tunnel_types.add(TunnelType.tcp);
    }
    const sniffing = block_protocols.length > 0 ? true : undefined;
    for (const tunnel_type of tunnel_types) {
      services.push({
        name: tunnel_type,
        addr: `:WAIT_LISTEN${port_range ? port_range : ""}`,
        handler: {
          type: tunnel_type === TunnelType.udp ? "ssu" : "relay",
          metadata: {
            sniffing,
            "block.protocol": block_protocols.length > 0 ? block_protocols : undefined,
            nodelay: true,
          },
        },
        listener: {
          type: tunnel_type,
          metadata: {
            ...(tunnel_type === TunnelType.udp ? { keepalive: true } : undefined),
            ...(tunnel_type === TunnelType.relayx ? { key: uuidV5(SITE_URL) } : undefined),
          },
        },
      });
    }
    const remote_port_forward_tunnels = tunnels.filter(
      (tunnel) => tunnel.category === TunnelCategory.remote_port_forward,
    );
    for (const tunnel of remote_port_forward_tunnels) {
      let listen_address: string;
      const listen_ip = tunnel.listen_ip || "";
      if (tunnel.listen_port) {
        listen_address = `${listen_ip}:${tunnel.listen_port}`;
      } else {
        listen_address = `${listen_ip}:WAIT_LISTEN${port_range ? port_range : ""}`;
      }
      const ip_type = tunnel.ip_type;
      const name = `${tunnel.id}`;
      const chain_nodes: JsonRecord[] = [];
      const nodes = tunnel.in_node_group?.nodes ?? [];
      for (const node of nodes) {
        const port = this.getOutListenFromCache(outListens, node.id, tunnel.tunnel_type);
        if (!port) {
          continue;
        }
        const connect_ip = this.getConnectIP(node.connect_ip, ip_type);
        if (!connect_ip) {
          continue;
        }
        const addr = joinIPAndPort(connect_ip, Number(port));
        chain_nodes.push({
          name: node.node_id,
          addr,
          connector: { type: "relay", metadata: { nodelay: true } },
          dialer: {
            type: tunnel.tunnel_type,
            ...(tunnel.tunnel_type === TunnelType.relayx
              ? {
                  metadata: {
                    key: uuidV5(SITE_URL),
                    host: new URL(SITE_URL).host,
                  },
                }
              : undefined),
          },
          metadata: {
            weight: node.weight.toString(),
            backup: node.backup,
          },
        });
      }
      chains.push({
        name,
        hops: [
          {
            name,
            selector: {
              strategy: tunnel.load_balance_type,
            },
            nodes: orderByPath(chain_nodes, "metadata.weight", "desc"),
          },
        ],
      });
      const limits = tunnelLimits.get(tunnel.id);
      const ip_limit = limits?.ip_limit;
      const bandwidth_limit = limits?.bandwidth_limit;
      const client_limit = limits?.client_limit;
      const climiter = limits?.climiter_name;
      if (climiter && ip_limit && !climiters.has(climiter)) {
        climiters.set(climiter, {
          name: climiter,
          limits: [`$ ${ip_limit}`],
        });
      }
      const limiter = limits?.limiter_name;
      if (limiter && bandwidth_limit && !limiters.has(limiter)) {
        limiters.set(limiter, {
          name: limiter,
          limits: [`$ ${bandwidth_limit / 8}MB ${bandwidth_limit / 8}MB`],
        });
      }
      const forward_addresses = asList<ForwardAddress>(tunnel.forward_addresses);
      const forwarder = {
        nodes: [...forward_addresses]
          .sort((a, b) => b.weight - a.weight)
          .map((fa) => ({
            name: `${name}-${fa.address}`,
            addr: fa.address,
            filter: fa.host ? { host: fa.host } : undefined,
            metadata: {
              weight: fa.weight.toString(),
            },
          })),
        selector: {
          strategy: tunnel.load_balance_type,
        },
      };
      const base_service = {
        addr: listen_address,
        climiter,
        limiter,
        forwarder,
        metadata: {
          maxClients: client_limit != null ? client_limit.toString() : undefined,
        },
      };
      if (tunnel.tunnel_type != "udp") {
        services.push({
          name: `rtcp-${name}`,
          handler: { type: "rtcp" },
          listener: { type: "rtcp", chain: name },
          ...base_service,
        });
      }
      services.push({
        name: `rudp-${name}`,
        handler: { type: "rudp" },
        listener: { type: "rudp", chain: name },
        ...base_service,
      });
    }
    const config: JsonRecord = {
      log: {
        level: "fatal",
      },
      tls: {
        validity: "8760h",
        commonName: new URL(SITE_URL).hostname,
        organization: new URL(SITE_URL).hostname,
      },
      chains,
      climiters: Array.from(climiters.values()),
      limiters: Array.from(limiters.values()),
      services,
    };
    return config;
  }

  async checkTunnel(
    tunnel_type: TunnelType,
    in_node_group_id: number,
    out_node_group_id: number | null,
    listen_port: number | null,
    id: number | null,
    listen_protocol?: JsonRecord | null,
  ): Promise<void> {
    if (listen_port) {
      const tunnel = await db.tunnel.findUnique({
        where: {
          listen_port_in_node_group_id: {
            listen_port,
            in_node_group_id,
          },
        },
        select: {
          id: true,
        },
      });
      if (tunnel && tunnel.id !== id) {
        throw new HTTPException(409, { message: "隧道端口已存在" });
      }
    }
    const in_node_group = await db.nodeGroup.findUnique({
      where: { id: in_node_group_id },
      select: {
        allow_tunnel_types: true,
        need_out_node_group: true,
        port_range: true,
        allow_out_node_groups: true,
        allow_listen_protocol: true,
        allow_listen_protocols: true,
      },
    });
    if (!in_node_group) {
      throw new HTTPException(404, { message: "节点组不存在" });
    }
    if (in_node_group.port_range && listen_port) {
      if (!this.nodeGroupService.checkPortRange(in_node_group.port_range, listen_port)) {
        throw new HTTPException(400, { message: "端口不在允许范围内" });
      }
    }
    if (in_node_group.need_out_node_group && !out_node_group_id) {
      throw new HTTPException(400, { message: "出口节点组不能为空" });
    }
    if (
      listen_protocol?.type &&
      in_node_group.allow_listen_protocol &&
      in_node_group.allow_listen_protocols
    ) {
      const allowed = asList<string>(in_node_group.allow_listen_protocols);
      if (allowed.length > 0 && !allowed.includes(listen_protocol.type)) {
        throw new HTTPException(403, { message: "入口节点组不允许使用此入口代理协议" });
      }
    }
    if (out_node_group_id && in_node_group.allow_out_node_groups) {
      const allowedOutNodeGroups = asList<number>(in_node_group.allow_out_node_groups);
      if (!allowedOutNodeGroups.includes(out_node_group_id)) {
        throw new HTTPException(403, { message: "该入口节点组不允许使用此出口节点组" });
      }
    }
    if (out_node_group_id) {
      const out_node_group = await db.nodeGroup.findUnique({
        where: { id: out_node_group_id },
        select: {
          allow_in_node_groups: true,
          allow_tunnel_types: true,
        },
      });
      if (!out_node_group) {
        throw new HTTPException(404, { message: "出口节点组不存在" });
      }
      if (out_node_group.allow_in_node_groups) {
        const allowedInNodeGroups = asList<number>(out_node_group.allow_in_node_groups);
        if (!allowedInNodeGroups.includes(in_node_group_id)) {
          throw new HTTPException(403, { message: "该出口节点组不允许使用此入口节点组" });
        }
      }
      const out_allow_tunnel_types = asList<TunnelType>(out_node_group?.allow_tunnel_types);
      if (
        out_node_group.allow_tunnel_types &&
        !out_allow_tunnel_types.includes(tunnel_type)
      ) {
        throw new HTTPException(403, { message: "出口节点组不允许使用此隧道类型" });
      }
    }
    const allow_tunnel_types = asList<TunnelType>(in_node_group?.allow_tunnel_types);
    if (!in_node_group?.allow_tunnel_types) {
      return;
    }
    if (!allow_tunnel_types.includes(tunnel_type)) {
      throw new HTTPException(403, { message: "入口节点组不允许使用此隧道类型" });
    }
  }

  async updateTunnelOrder(id: number, order_by: number, user_id: number): Promise<void> {
    await db.tunnel.update({
      where: { id, user_id },
      data: { order_by },
    });
  }

  async createTunnel(
    user_id: number,
    data: JsonRecord,
    max_tunnels?: number | null,
  ): Promise<void> {
    const {
      name,
      listen_ip,
      listen_port,
      forward_addresses,
      in_node_group_id,
      out_node_group_id,
      status,
      load_balance_type,
      tunnel_type,
      ip_type,
      ip_limit,
      client_limit,
      bandwidth_limit,
      category,
      tunnel_chains,
      listen_protocol,
      forward_addresses_protocol,
      proxy_protocol,
    } = data;
    await this.checkTunnel(
      tunnel_type,
      in_node_group_id,
      out_node_group_id,
      listen_port,
      null,
      listen_protocol,
    );
    const prepared_listen_protocol = this.prepareListenProtocol(listen_protocol);
    await this.redisService.lockUserTunnel(user_id, async () => {
      const user = await db.user.findUnique({
        where: { id: user_id },
      });
      if (!user) {
        throw new HTTPException(404, { message: "用户不存在" });
      }
      await this.nodeGroupService.checkUserNodeGroup(user, in_node_group_id, out_node_group_id);
      if (max_tunnels) {
        const existing_tunnels = await db.tunnel.count({
          where: { user_id },
        });
        if (existing_tunnels >= max_tunnels) {
          throw new HTTPException(409, { message: "已达到最大隧道数量，请升级套餐" });
        }
      }
      try {
        await db.$transaction(async (tx) => {
          const tunnel = await tx.tunnel.create({
            data: {
              name,
              listen_ip,
              listen_port,
              forward_addresses,
              in_node_group_id,
              out_node_group_id,
              status,
              load_balance_type,
              tunnel_type,
              ip_type,
              user_id,
              order_by: (await db.tunnel.count()) * 1000,
              ip_limit,
              client_limit,
              bandwidth_limit,
              category,
              listen_protocol: prepared_listen_protocol ?? undefined,
              forward_addresses_protocol,
              proxy_protocol: proxy_protocol ?? false,
            },
          });
          if (tunnel_chains && tunnel_chains.length > 0) {
            await tx.tunnelChain.createMany({
              data: tunnel_chains.map((chain: JsonRecord) => ({
                tunnel_id: tunnel.id,
                node_group_id: chain.node_group_id,
                node_type: chain.node_type,
              })),
            });
          }
        });
      } catch {
        throw new HTTPException(409, { message: "端口已存在" });
      }
    });
  }

  async testTunnel(tunnel_id: number, ip: string, user_id?: number) {
    const io = getIo();
    const [tunnel, allOutListens] = await Promise.all([
      db.tunnel.findUnique({
        where: { id: tunnel_id, user_id: user_id ?? undefined, status: Status.active },
        include: {
          in_node_group: {
            select: {
              name: true,
            },
          },
          out_node_group: {
            include: {
              nodes: {
                where: { status: Status.active },
                select: {
                  id: true,
                  node_id: true,
                  connect_ip: true,
                },
              },
            },
          },
          tunnel_chains: {
            include: {
              node_group: {
                include: {
                  nodes: {
                    where: { status: Status.active },
                    select: {
                      id: true,
                      node_id: true,
                      connect_ip: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.redisService.getAllOutListens(),
    ]);
    if (!tunnel) {
      throw new HTTPException(404, { message: "隧道不存在" });
    }
    const getOutListen = (node_id: number, type: string): string | undefined =>
      allOutListens[`${node_id}:${type}`];
    const TIMEOUT = 5000;
    const results: JsonRecord[] = [];
    const ip_type = tunnel.ip_type;
    let group_id = tunnel.in_node_group_id;
    let from_node_group_name: string | undefined = tunnel.in_node_group.name;
    let to_node_group_name: string | undefined;
    const tunnel_chains = tunnel.tunnel_chains;
    const in_chains = tunnel_chains.filter((chain) => chain.node_type === NodeType.in);
    const pingPromise = io
      .timeout(TIMEOUT)
      .to(`node_group/${group_id}`)
      .emitWithAck("ping", ip)
      .catch(() => []);
    for (const tunnel_chain of in_chains) {
      const ips: Record<string, string> = {};
      for (const node of tunnel_chain.node_group.nodes) {
        const nodeIp = this.getConnectIP(node.connect_ip, ip_type);
        if (!nodeIp) {
          continue;
        }
        const port = getOutListen(node.id, "tcp");
        if (port) {
          ips[node.node_id] = joinIPAndPort(nodeIp, Number(port));
        }
      }
      let result: unknown[] = [];
      try {
        result = await io.timeout(TIMEOUT).to(`node_group/${group_id}`).emitWithAck("test", ips);
      } catch (error) {
        logger.error(`隧道测试失败: ${error}, ips: ${JSON.stringify(ips)}`);
      }
      to_node_group_name = tunnel_chain.node_group.name;
      results.push({
        from: from_node_group_name,
        to: to_node_group_name,
        results: result,
      });
      group_id = tunnel_chain.node_group_id;
      from_node_group_name = to_node_group_name;
    }
    if (tunnel.out_node_group_id && tunnel.out_node_group) {
      const ips: Record<string, string> = {};
      for (const node of tunnel.out_node_group?.nodes ?? []) {
        const nodeIp = this.getConnectIP(node.connect_ip, ip_type);
        if (!nodeIp) {
          continue;
        }
        const port = getOutListen(node.id, tunnel.tunnel_type);
        if (port) {
          ips[node.node_id] = joinIPAndPort(nodeIp, Number(port));
        }
      }
      let result: unknown[] = [];
      try {
        result = await io.timeout(TIMEOUT).to(`node_group/${group_id}`).emitWithAck("test", ips);
      } catch (error) {
        logger.error(`隧道测试失败: ${error}, ips: ${JSON.stringify(ips)}`);
      }
      to_node_group_name = tunnel.out_node_group.name;
      results.push({
        from: from_node_group_name,
        to: to_node_group_name,
        results: result,
      });
      group_id = tunnel.out_node_group_id;
      from_node_group_name = to_node_group_name;
    }
    const out_chains = tunnel_chains.filter((chain) => chain.node_type === NodeType.out);
    for (const tunnel_chain of out_chains) {
      const ips: Record<string, string> = {};
      for (const node of tunnel_chain.node_group.nodes) {
        const nodeIp = this.getConnectIP(node.connect_ip, ip_type);
        if (!nodeIp) {
          continue;
        }
        const port = getOutListen(node.id, "tcp");
        if (port) {
          ips[node.node_id] = joinIPAndPort(nodeIp, Number(port));
        }
      }
      let result: unknown[] = [];
      try {
        result = await io.timeout(TIMEOUT).to(`node_group/${group_id}`).emitWithAck("test", ips);
      } catch (error) {
        logger.error(`隧道测试失败: ${error}, ips: ${JSON.stringify(ips)}`);
      }
      to_node_group_name = tunnel_chain.node_group.name;
      results.push({
        from: from_node_group_name,
        to: to_node_group_name,
        results: result,
      });
      group_id = tunnel_chain.node_group_id;
      from_node_group_name = to_node_group_name;
    }
    const forward_addresses = asList<ForwardAddress>(tunnel.forward_addresses);
    const forward_ips = forward_addresses.reduce<Record<string, string>>((acc, fa) => {
      acc[fa.address] = fa.address;
      return acc;
    }, {});
    if (!isEmptyObject(forward_ips)) {
      let result: unknown[] = [];
      try {
        result = await io
          .timeout(TIMEOUT)
          .to(`node_group/${group_id}`)
          .emitWithAck("test", forward_ips);
      } catch (error) {
        logger.error(`隧道测试失败: ${error}, ips: ${JSON.stringify(forward_ips)}`);
      }
      results.push({
        from: from_node_group_name,
        to: "转发地址",
        results: result,
      });
    }
    const ping_results = await pingPromise;
    results.unshift({
      from: tunnel.in_node_group.name,
      to: "本地",
      results: ping_results,
    });
    return results;
  }

  async getSubscriptionTunnels(user_id: number) {
    const userPlan = await db.userPlan.findUnique({
      where: { user_id },
      select: { traffic: true, traffic_used: true, expired_at: true },
    });
    if (!userPlan) {
      return { tunnels: [], userPlan: null };
    }
    if (userPlan.expired_at && userPlan.expired_at < new Date()) {
      return { tunnels: [], userPlan };
    }
    if (userPlan.traffic && userPlan.traffic_used >= userPlan.traffic) {
      return { tunnels: [], userPlan };
    }
    const tunnels = await db.tunnel.findMany({
      where: {
        user_id,
        status: Status.active,
        listen_port: { not: null },
      },
      include: {
        in_node_group: {
          select: {
            connect_ip: true,
            nodes: {
              where: { status: Status.active },
              select: { connect_ip: true },
            },
          },
        },
      },
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
    });
    return { tunnels, userPlan };
  }

  async generateSubscription(user_id: number, wgFormat = "shadowrocket"): Promise<string> {
    const { tunnels } = await this.getSubscriptionTunnels(user_id);
    const tunnelConfigs: string[] = [];
    let introBaseConfig: string | null = null;
    for (const tunnel of tunnels) {
      const listen_protocol = asRecord(tunnel.listen_protocol);
      if (!listen_protocol) {
        continue;
      }
      const connect_ip = this.getConnectIP(
        tunnel.in_node_group.connect_ip || tunnel.in_node_group.nodes[0]?.connect_ip || "",
        tunnel.ip_type,
      );
      if (!connect_ip || !tunnel.listen_port) {
        continue;
      }
      const server = connect_ip;
      const port = tunnel.listen_port;
      const remark = encodeURIComponent(tunnel.name);
      if (listen_protocol.type === "wireguard") {
        const builder =
          wgFormat === "v2rayn" ? buildWireGuardV2rayNUrl : buildWireGuardShadowrocketUrl;
        const wgConfig = builder(listen_protocol, server, port, tunnel.name);
        if (!wgConfig) {
          continue;
        }
        tunnelConfigs.push(wgConfig);
        continue;
      }
      if (listen_protocol.type === "vless") {
        const vlessConfig = buildVlessRealityUrl(listen_protocol, server, port, tunnel.name);
        if (!vlessConfig) {
          continue;
        }
        tunnelConfigs.push(vlessConfig);
        continue;
      }
      if (listen_protocol.type === "mieru") {
        const mieruUrl = buildMieruSimpleShareUrl(listen_protocol, server, port, tunnel.name);
        if (!mieruUrl) {
          continue;
        }
        tunnelConfigs.push(mieruUrl);
        continue;
      }
      const type = listen_protocol.type;
      const method = listen_protocol.username;
      const password = listen_protocol.password;
      if (!method || !password) {
        continue;
      }
      const auth = Buffer.from(`${method}:${password}`).toString("base64");
      const config = `${type}://${auth}@${server}:${port}`;
      if (!introBaseConfig) {
        introBaseConfig = config;
      }
      tunnelConfigs.push(`${config}#${remark}`);
    }
    const configs: string[] = [];
    if (introBaseConfig) {
      const siteName =
        (await this.systemConfigService.getConfig<string>(SystemConfigName.SITE_NAME)) || "RelayX";
      configs.push(`${introBaseConfig}#${encodeURIComponent(`${siteName} ${SITE_URL}`)}`);
    }
    configs.push(...tunnelConfigs);
    return configs.join("\n");
  }

  async generateClashSubscription(user_id: number): Promise<string> {
    const { tunnels } = await this.getSubscriptionTunnels(user_id);
    const proxies: JsonRecord[] = [];
    const proxyNames: string[] = [];
    const usedNames = new Set<string>();
    for (const tunnel of tunnels) {
      const listen_protocol = asRecord(tunnel.listen_protocol);
      if (!listen_protocol?.type) {
        continue;
      }
      const connect_ip = this.getConnectIP(
        tunnel.in_node_group.connect_ip || tunnel.in_node_group.nodes[0]?.connect_ip || "",
        tunnel.ip_type,
      );
      if (!connect_ip || !tunnel.listen_port) {
        continue;
      }
      let name = tunnel.name;
      if (usedNames.has(name)) {
        name = `${name}#${tunnel.id}`;
      }
      usedNames.add(name);
      let proxy: JsonRecord;
      if (listen_protocol.type === "ss") {
        if (!listen_protocol.username || !listen_protocol.password) {
          continue;
        }
        proxy = {
          name,
          type: "ss",
          server: connect_ip,
          port: tunnel.listen_port,
          cipher: listen_protocol.username,
          password: listen_protocol.password,
          udp: true,
        };
      } else if (listen_protocol.type === "socks5") {
        proxy = {
          name,
          type: "socks5",
          server: connect_ip,
          port: tunnel.listen_port,
          username: listen_protocol.username ?? undefined,
          password: listen_protocol.password ?? undefined,
          udp: true,
        };
      } else if (listen_protocol.type === "wireguard") {
        const clientPrivateKey = listen_protocol.clientPrivateKey;
        const serverPublicKey = listen_protocol.publicKey;
        if (!clientPrivateKey || !serverPublicKey) {
          continue;
        }
        const peer = asList<JsonRecord>(listen_protocol.peers)[0];
        const clientAddress = cleanStringList(peer?.allowedIPs).filter(
          (value) => value !== "0.0.0.0/0" && value !== "::/0",
        );
        const ip = (clientAddress[0] ?? "10.66.0.2/32").split("/")[0];
        const allowedIPs = cleanStringList(listen_protocol.clientAllowedIPs);
        const dns = cleanStringList(listen_protocol.dns);
        proxy = {
          name,
          type: "wireguard",
          server: connect_ip,
          port: tunnel.listen_port,
          ip,
          "private-key": clientPrivateKey,
          "public-key": serverPublicKey,
          "preshared-key": peer?.presharedKey ?? undefined,
          "allowed-ips": allowedIPs.length > 0 ? allowedIPs : ["0.0.0.0/0"],
          dns: dns.length > 0 ? dns : undefined,
          mtu: listen_protocol.mtu ?? 1420,
          "persistent-keepalive": peer?.persistentKeepalive ?? 25,
          udp: true,
          "remote-dns-resolve": true,
        };
      } else if (listen_protocol.type === "vless") {
        if (!listen_protocol.uuid || !listen_protocol.publicKey) {
          continue;
        }
        proxy = {
          name,
          type: "vless",
          server: connect_ip,
          port: tunnel.listen_port,
          uuid: listen_protocol.uuid,
          network: "tcp",
          udp: true,
          tls: true,
          flow: VLESS_FLOW,
          servername: realityServerName(listen_protocol.dest),
          "client-fingerprint": VLESS_FINGERPRINT,
          "reality-opts": {
            "public-key": listen_protocol.publicKey,
            "short-id": listen_protocol.shortId ?? undefined,
          },
        };
      } else if (listen_protocol.type === "mieru") {
        if (!listen_protocol.username || !listen_protocol.password) {
          continue;
        }
        const transport = (
          listen_protocol.transportProtocol ?? DEFAULT_MIERU_TRANSPORT_PROTOCOL
        ).toUpperCase();
        proxy = {
          name,
          type: "mieru",
          server: connect_ip,
          port: tunnel.listen_port,
          transport: transport === "UDP" ? "UDP" : "TCP",
          udp: true,
          username: listen_protocol.username,
          password: listen_protocol.password,
          multiplexing: "MULTIPLEXING_LOW",
          mtu: listen_protocol.mtu ?? DEFAULT_MIERU_MTU,
        };
      } else if (listen_protocol.type === "openvpn") {
        if (
          !listen_protocol.ca ||
          !listen_protocol.clientCert ||
          !listen_protocol.clientKey ||
          !listen_protocol.tlsCrypt
        ) {
          continue;
        }
        proxy = {
          name,
          type: "openvpn",
          server: connect_ip,
          port: tunnel.listen_port,
          proto: listen_protocol.udp ? "udp" : "tcp",
          ca: listen_protocol.ca,
          cert: listen_protocol.clientCert,
          key: listen_protocol.clientKey,
          "tls-crypt": listen_protocol.tlsCrypt,
          cipher: listen_protocol.cipher ?? DEFAULT_OPENVPN_CIPHER,
          auth: listen_protocol.auth ?? DEFAULT_OPENVPN_AUTH,
          mtu: listen_protocol.mtu ?? DEFAULT_OPENVPN_MTU,
          udp: true,
        };
      } else {
        continue;
      }
      proxies.push(proxy);
      proxyNames.push(name);
    }
    const proxyGroups = [
      {
        name: "proxy",
        type: "select",
        proxies: proxyNames.length > 0 ? proxyNames : ["DIRECT"],
      },
    ];
    return `${CLASH_BASE_CONFIG}\nproxies:\n${emitYaml(proxies, 2)}\nproxy-groups:\n${emitYaml(proxyGroups, 2)}\n`;
  }
}

/** Self-registration: `instance.resolve(TOKENS.Tunnel)` / `tunnelService`. */
export const tunnelService = service<TunnelService>(
  TOKENS.Tunnel,
  () =>
    new TunnelService(
      instance.resolve<RedisService>(TOKENS.Redis),
      instance.resolve<NodeGroupService>(TOKENS.NodeGroup),
      instance.resolve<LicenseService>(TOKENS.License),
      instance.resolve<SystemConfigService>(TOKENS.SystemConfig),
    ),
);
