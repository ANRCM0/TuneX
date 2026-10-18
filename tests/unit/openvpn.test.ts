import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateOpenVpnPki, generateTlsCryptKey } from "../../apps/backend/src/utils/openvpn";

describe("openvpn material", () => {
  it("emits a 256-byte OpenVPN static key V1", () => {
    const text = generateTlsCryptKey();
    const lines = text.split("\n");
    expect(lines[0]).toBe("-----BEGIN OpenVPN Static key V1-----");
    expect(lines.at(-1)).toBe("-----END OpenVPN Static key V1-----");
    const hex = lines.slice(1, -1);
    expect(hex).toHaveLength(16);
    for (const line of hex) {
      expect(line).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(Buffer.from(hex.join(""), "hex")).toHaveLength(256);
  });

  it("issues a CA that openssl will use to verify the server and client certs", () => {
    const pki = generateOpenVpnPki();
    expect(pki.serverKey).toContain("BEGIN RSA PRIVATE KEY");
    expect(pki.clientKey).toContain("BEGIN RSA PRIVATE KEY");

    const dir = mkdtempSync(join(tmpdir(), "relayx-ovpn-test-"));
    try {
      const ca = join(dir, "ca.crt");
      const server = join(dir, "server.crt");
      const client = join(dir, "client.crt");
      writeFileSync(ca, pki.ca);
      writeFileSync(server, pki.serverCert);
      writeFileSync(client, pki.clientCert);

      const serverText = execFileSync("openssl", ["x509", "-in", server, "-noout", "-text"], {
        encoding: "utf8",
      });
      const clientText = execFileSync("openssl", ["x509", "-in", client, "-noout", "-text"], {
        encoding: "utf8",
      });
      expect(serverText).toContain("RelayX OpenVPN Server");
      expect(serverText).toContain("TLS Web Server Authentication");
      expect(clientText).toContain("RelayX OpenVPN Client");
      expect(clientText).toContain("TLS Web Client Authentication");

      expect(execFileSync("openssl", ["verify", "-CAfile", ca, server], { encoding: "utf8" })).toContain(
        "OK",
      );
      expect(execFileSync("openssl", ["verify", "-CAfile", ca, client], { encoding: "utf8" })).toContain(
        "OK",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
