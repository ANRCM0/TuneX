/**
 * Share-link builders, reconstructed from the shipped TunnelQrDialog
 * (relayx-web/work/all_modules/0h4-jil_-79px__993582.js).
 *
 * Per listen_protocol.type upstream builds:
 *   http        http://user:pass@host:port#name
 *   socks5      socks5://user:pass@host:port#name
 *   ss          ss://btoa(user:pass)@host:port#name
 *   relay       relay://user:pass@host:port#name
 *   vless       vless://uuid@host:port?type=tcp&encryption=none&security=reality&flow=xtls-rprx-vision
 *               &fp=chrome&sni=…&pbk=…[&sid=…]#name
 *   wireguard   wireguard://<clientPrivKey>@host:port/?publickey=…&address=…&mtu=…#name
 *               plus a wg-quick style .conf and a shadowrocket wg:// link
 *   mieru       mierus://user:pass@host?profile=…&port=…&protocol=TCP|UDP&mtu=…&multiplexing=…#name
 *   openvpn     a full .ovpn profile
 */

export type ShareProtocol = {
  type?: string;
  username?: string | null;
  password?: string | null;
  uuid?: string;
  publicKey?: string;
  shortId?: string;
  dest?: string;
  clientPrivateKey?: string;
  peers?: { allowedIPs?: string[] | string; presharedKey?: string; persistentKeepalive?: number }[];
  clientAllowedIPs?: string[] | string;
  dns?: string[] | string;
  mtu?: number;
  transportProtocol?: string;
  ca?: string;
  clientCert?: string;
  clientKey?: string;
  tlsCrypt?: string;
  udp?: boolean;
  cipher?: string;
  auth?: string;
};

export type ShareTunnel = {
  name?: string;
  listen_port?: number;
  listen_protocol?: ShareProtocol | null;
  in_node_group?: { connect_ip?: string | null; nodes?: { connect_ip?: string | null }[] } | null;
};

export type ShareResult = {
  url?: string;
  conf?: string;
  ovpn?: string;
  shadowrocketUrl?: string;
  v2raynUrl?: string;
};

const FALLBACK_ADDRESS = "10.66.0.2/32";

const list = (v?: string[] | string | null): string[] =>
  (Array.isArray(v) ? v : (v ?? "").split(",")).map((s) => s.trim()).filter(Boolean);

function firstHost(t: ShareTunnel): string | undefined {
  const g = t.in_node_group;
  if (!g) return undefined;
  if (g.connect_ip) return g.connect_ip.split(",")[0]?.trim();
  for (const n of g.nodes ?? []) {
    const ip = (n.connect_ip ?? "").split(",")[0]?.trim();
    if (ip) return ip.includes(":") ? `[${ip}]` : ip;
  }
  return undefined;
}

function b64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}

export function buildShare(t: ShareTunnel): ShareResult | null {
  const p = t.listen_protocol;
  const port = t.listen_port;
  const host = firstHost(t);
  if (!p?.type || !port || !host) return null;
  const tag = `#${encodeURIComponent(t.name ?? "")}`;
  const auth = p.username ? `${p.username}:${p.password ?? ""}@` : "";

  switch (p.type) {
    case "http":
      return { url: `http://${auth}${host}:${port}${tag}` };
    case "socks5":
      return { url: `socks5://${auth}${host}:${port}${tag}` };
    case "ss":
      return { url: `ss://${b64(`${p.username ?? ""}:${p.password ?? ""}`)}@${host}:${port}${tag}` };
    case "relay":
      return { url: `relay://${auth}${host}:${port}${tag}` };
    case "vless": {
      if (!p.uuid || !p.publicKey) return null;
      const dest = (p.dest ?? "www.apple.com:443").trim();
      const sni = dest.includes(":") ? dest.slice(0, dest.lastIndexOf(":")) : dest;
      const q = [
        "type=tcp",
        "encryption=none",
        "security=reality",
        "flow=xtls-rprx-vision",
        "fp=chrome",
        `sni=${encodeURIComponent(sni)}`,
        `pbk=${encodeURIComponent(p.publicKey)}`,
      ];
      if (p.shortId) q.push(`sid=${encodeURIComponent(p.shortId)}`);
      return { url: `vless://${p.uuid}@${host}:${port}?${q.join("&")}${tag}` };
    }
    case "wireguard": {
      if (!p.clientPrivateKey || !p.publicKey) return null;
      const peer = p.peers?.[0];
      const allowed = list(peer?.allowedIPs).filter((a) => {
        const cidr = a.includes("/") ? a : `${a}/0`;
        return cidr !== "0.0.0.0/0" && cidr !== "::/0";
      });
      const address = allowed.length > 0 ? allowed.join(",") : FALLBACK_ADDRESS;
      const firstIp = (allowed[0] ?? "10.66.0.2").split("/")[0];
      const dns = list(p.dns);
      const clientAllowed = list(p.clientAllowedIPs);
      const mtu = p.mtu ?? 1420;
      const keepalive = peer?.persistentKeepalive ?? 25;

      const v2 = [`publickey=${encodeURIComponent(p.publicKey)}`];
      if (peer?.presharedKey) v2.push(`presharedkey=${encodeURIComponent(peer.presharedKey)}`);
      v2.push(`address=${encodeURIComponent(address)}`);
      if (p.mtu) v2.push(`mtu=${p.mtu}`);
      const v2raynUrl = `wireguard://${encodeURIComponent(p.clientPrivateKey)}@${host}:${port}/?${v2.join("&")}${tag}`;

      const sr = [
        `publicKey=${encodeURIComponent(p.publicKey)}`,
        `privateKey=${encodeURIComponent(p.clientPrivateKey)}`,
        `ip=${firstIp}`,
        `mtu=${mtu}`,
        "udp=1",
        `keepalive=${keepalive}`,
      ];
      if (dns.length) sr.push(`dns=${encodeURIComponent(dns.join(","))}`);
      if (peer?.presharedKey) sr.push(`presharedKey=${encodeURIComponent(peer.presharedKey)}`);
      const shadowrocketUrl = `wg://${host}:${port}?${sr.join("&")}${tag}`;

      const conf = [
        "[Interface]",
        `PrivateKey = ${p.clientPrivateKey}`,
        `Address = ${allowed.length ? allowed.join(", ") : FALLBACK_ADDRESS}`,
        ...(dns.length ? [`DNS = ${dns.join(", ")}`] : []),
        `MTU = ${mtu}`,
        "",
        "[Peer]",
        `PublicKey = ${p.publicKey}`,
        ...(peer?.presharedKey ? [`PresharedKey = ${peer.presharedKey}`] : []),
        `AllowedIPs = ${clientAllowed.length ? clientAllowed.join(", ") : "0.0.0.0/0, ::/0"}`,
        `Endpoint = ${host}:${port}`,
        `PersistentKeepalive = ${keepalive}`,
      ].join("\n");

      return { url: v2raynUrl, v2raynUrl, shadowrocketUrl, conf };
    }
    case "mieru": {
      if (!p.username || !p.password) return null;
      const proto = (p.transportProtocol ?? "tcp").toUpperCase() === "UDP" ? "UDP" : "TCP";
      const q = new URLSearchParams({
        profile: t.name ?? "relayx",
        port: String(port),
        protocol: proto,
        mtu: String(p.mtu ?? 1400),
        multiplexing: "MULTIPLEXING_LOW",
      })
        .toString()
        .replace(/\+/g, "%20");
      return {
        url: `mierus://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${host}?${q}${tag}`,
      };
    }
    case "openvpn": {
      if (!p.ca || !p.clientCert || !p.clientKey || !p.tlsCrypt) return null;
      const proto = p.udp ? "udp" : "tcp";
      const cipher = p.cipher ?? "AES-256-GCM";
      const lines = [
        `# ${t.name ?? ""}`,
        "client",
        "dev tun",
        `proto ${proto}`,
        `remote ${host} ${port}`,
        "resolv-retry infinite",
        "nobind",
        "persist-key",
        "persist-tun",
        "remote-cert-tls server",
        `cipher ${cipher}`,
        `data-ciphers ${cipher}`,
        `data-ciphers-fallback ${cipher}`,
        `auth ${p.auth ?? "SHA256"}`,
        `tun-mtu ${p.mtu ?? 1500}`,
        "redirect-gateway def1",
        "verb 3",
        `<ca>\n${p.ca.trim()}\n</ca>`,
        `<cert>\n${p.clientCert.trim()}\n</cert>`,
        `<key>\n${p.clientKey.trim()}\n</key>`,
        `<tls-crypt>\n${p.tlsCrypt.trim()}\n</tls-crypt>`,
      ];
      return { ovpn: lines.join("\n") };
    }
    default:
      return null;
  }
}
