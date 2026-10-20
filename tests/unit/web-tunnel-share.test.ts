/**
 * Share-link builders (`apps/web/src/lib/tunnel-share.ts`).
 *
 * Reconstructed from the shipped TunnelQrDialog (module 993582). Each case pins one
 * protocol branch, including the two that emit files (wireguard .conf, openvpn .ovpn)
 * and the guard rails (missing credentials ⇒ null instead of a broken link).
 */
import { describe, expect, it } from "vitest";
import { buildShare, type ShareTunnel } from "../../apps/web/src/lib/tunnel-share";

const group = { connect_ip: "203.0.113.7" };

const tunnel = (over: Partial<ShareTunnel> & { protocol?: Record<string, unknown> }): ShareTunnel => ({
  name: "hk-tokyo",
  listen_port: 10000,
  in_node_group: group,
  listen_protocol: {
    type: over.protocol?.type as string,
    ...over.protocol,
  } as ShareTunnel["listen_protocol"],
  ...over,
});

describe("buildShare — URI protocols", () => {
  it("http carries credentials when set", () => {
    const r = buildShare(tunnel({ protocol: { type: "http", username: "u", password: "p" } }));
    expect(r?.url).toBe("http://u:p@203.0.113.7:10000#hk-tokyo");
  });

  it("socks5 and relay use their own schemes", () => {
    expect(buildShare(tunnel({ protocol: { type: "socks5" } }))?.url).toBe(
      "socks5://203.0.113.7:10000#hk-tokyo",
    );
    expect(buildShare(tunnel({ protocol: { type: "relay" } }))?.url).toBe(
      "relay://203.0.113.7:10000#hk-tokyo",
    );
  });

  it("shadowsocks base64-encodes the credential pair", () => {
    const r = buildShare(tunnel({ protocol: { type: "ss", username: "aes", password: "secret" } }));
    expect(r?.url).toBe(`ss://${Buffer.from("aes:secret").toString("base64")}@203.0.113.7:10000#hk-tokyo`);
  });

  it("vless emits the REALITY parameter set", () => {
    const r = buildShare(
      tunnel({
        protocol: {
          type: "vless",
          uuid: "11111111-2222-3333-4444-555555555555",
          publicKey: "PUBKEY",
          shortId: "abcd",
          dest: "www.apple.com:443",
        },
      }),
    );
    expect(r?.url).toContain("vless://11111111-2222-3333-4444-555555555555@203.0.113.7:10000?");
    for (const part of [
      "type=tcp",
      "encryption=none",
      "security=reality",
      "flow=xtls-rprx-vision",
      "fp=chrome",
      "sni=www.apple.com",
      "pbk=PUBKEY",
      "sid=abcd",
    ]) {
      expect(r?.url).toContain(part);
    }
  });

  it("mieru encodes the profile query", () => {
    const r = buildShare(tunnel({ protocol: { type: "mieru", username: "mu", password: "pw", mtu: 1400 } }));
    expect(r?.url.startsWith("mierus://mu:pw@203.0.113.7?")).toBe(true);
    expect(r?.url).toContain("multiplexing=MULTIPLEXING_LOW");
    expect(r?.url).toContain("profile=hk-tokyo");
  });
});

describe("buildShare — file protocols", () => {
  it("wireguard produces a wg-quick config plus two client URIs", () => {
    const r = buildShare(
      tunnel({
        protocol: {
          type: "wireguard",
          clientPrivateKey: "PRIV",
          publicKey: "PUB",
          peers: [{ allowedIPs: "10.66.0.2/32", persistentKeepalive: 25, presharedKey: "PSK" }],
          dns: "1.1.1.1",
          mtu: 1420,
        },
      }),
    );
    expect(r?.conf).toContain("[Interface]");
    expect(r?.conf).toContain("PrivateKey = PRIV");
    expect(r?.conf).toContain("Address = 10.66.0.2/32");
    expect(r?.conf).toContain("PublicKey = PUB");
    expect(r?.conf).toContain("PresharedKey = PSK");
    expect(r?.conf).toContain("Endpoint = 203.0.113.7:10000");
    expect(r?.v2raynUrl?.startsWith("wireguard://")).toBe(true);
    expect(r?.shadowrocketUrl?.startsWith("wg://")).toBe(true);
  });

  it("openvpn emits a full profile with the four inline blocks", () => {
    const r = buildShare(
      tunnel({
        protocol: {
          type: "openvpn",
          ca: "CA",
          clientCert: "CERT",
          clientKey: "KEY",
          tlsCrypt: "TC",
          udp: true,
          cipher: "AES-256-GCM",
        },
      }),
    );
    expect(r?.ovpn).toContain("proto udp");
    expect(r?.ovpn).toContain("remote 203.0.113.7 10000");
    for (const tag of ["<ca>", "<cert>", "<key>", "<tls-crypt>"]) expect(r?.ovpn).toContain(tag);
  });
});

describe("buildShare — guard rails", () => {
  it("returns null without a listen port, protocol or address", () => {
    expect(buildShare({ name: "x", listen_protocol: { type: "http" } })).toBeNull();
    expect(buildShare({ name: "x", listen_port: 1, in_node_group: group })).toBeNull();
    expect(buildShare({ name: "x", listen_port: 1, listen_protocol: { type: "http" } })).toBeNull();
  });

  it("returns null when a protocol is missing its key material", () => {
    expect(buildShare(tunnel({ protocol: { type: "vless" } }))).toBeNull();
    expect(buildShare(tunnel({ protocol: { type: "wireguard" } }))).toBeNull();
    expect(buildShare(tunnel({ protocol: { type: "openvpn" } }))).toBeNull();
    expect(buildShare(tunnel({ protocol: { type: "mieru" } }))).toBeNull();
  });

  it("prefers the node-group connect_ip over per-node addresses", () => {
    const r = buildShare(
      tunnel({
        in_node_group: { connect_ip: "198.51.100.9", nodes: [{ connect_ip: "192.0.2.1" }] },
        protocol: { type: "http" },
      }),
    );
    expect(r?.url).toContain("198.51.100.9");
  });
});
