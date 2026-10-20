import crypto from "crypto";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Upstream: src/utils/openvpn.ts (89 lines).
 *
 * Upstream builds the PKI with `node-forge` (`forge.pki.*`). node-forge is not in the
 * frozen dependency set, so the replica issues the same X.509 material with the `openssl`
 * CLI, which is present in the runtime image (OpenSSL 3.0.x). The exported shape is
 * identical: { ca, serverCert, serverKey, clientCert, clientKey } as PEM strings.
 * Deviation recorded in docs/DEVIATIONS.md.
 */

const CERT_VALID_YEARS = 10;
const CERT_VALID_DAYS = CERT_VALID_YEARS * 365;

export interface OpenVpnPki {
  ca: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
}

export interface OpenVpnListenProtocol {
  type?: string | null;
  ca?: string | null;
  cert?: string | null;
  key?: string | null;
  clientCert?: string | null;
  clientKey?: string | null;
  tlsCrypt?: string | null;
  udp?: boolean | null;
  cipher?: string | null;
  auth?: string | null;
  mtu?: number | null;
  server?: string | null;
  [key: string]: unknown;
}

/** One RSA-2048 key pair, PEM encoded exactly like forge's `privateKeyToPem`. */
function generateRsaKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
}

export function generateOpenVpnPki(): OpenVpnPki {
  const dir = mkdtempSync(join(tmpdir(), "relayx-openvpn-"));
  try {
    const ca = generateRsaKeyPair();
    const server = generateRsaKeyPair();
    const client = generateRsaKeyPair();

    const caKeyPath = join(dir, "ca.key");
    const caCertPath = join(dir, "ca.crt");
    const serverKeyPath = join(dir, "server.key");
    const clientKeyPath = join(dir, "client.key");
    writeFileSync(caKeyPath, ca.privateKey);
    writeFileSync(serverKeyPath, server.privateKey);
    writeFileSync(clientKeyPath, client.privateKey);

    // Self-signed CA — mirrors buildCert({ cA: true, keyCertSign, cRLSign, digitalSignature }).
    openssl([
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      caKeyPath,
      "-sha256",
      "-days",
      String(CERT_VALID_DAYS),
      "-subj",
      "/CN=RelayX OpenVPN CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign,digitalSignature",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-out",
      caCertPath,
    ]);

    const sign = (
      keyPath: string,
      commonName: string,
      keyUsage: string,
      extendedKeyUsage: string,
      outPrefix: string,
    ): string => {
      const csrPath = join(dir, `${outPrefix}.csr`);
      const extPath = join(dir, `${outPrefix}.ext`);
      const crtPath = join(dir, `${outPrefix}.crt`);
      openssl(["req", "-new", "-key", keyPath, "-subj", `/CN=${commonName}`, "-out", csrPath]);
      writeFileSync(
        extPath,
        [
          "basicConstraints=critical,CA:FALSE",
          `keyUsage=critical,${keyUsage}`,
          `extendedKeyUsage=${extendedKeyUsage}`,
          "subjectKeyIdentifier=hash",
          "",
        ].join("\n"),
      );
      openssl([
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-CAcreateserial",
        "-days",
        String(CERT_VALID_DAYS),
        "-sha256",
        "-extfile",
        extPath,
        "-out",
        crtPath,
      ]);
      return readFileSync(crtPath, "utf8");
    };

    const serverCert = sign(
      serverKeyPath,
      "RelayX OpenVPN Server",
      "digitalSignature,keyEncipherment",
      "serverAuth",
      "server",
    );
    const clientCert = sign(
      clientKeyPath,
      "RelayX OpenVPN Client",
      "digitalSignature",
      "clientAuth",
      "client",
    );

    return {
      ca: readFileSync(caCertPath, "utf8"),
      serverCert,
      serverKey: server.privateKey,
      clientCert,
      clientKey: client.privateKey,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function generateTlsCryptKey(): string {
  const hex = crypto.randomBytes(256).toString("hex");
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    lines.push(hex.slice(i, i + 32));
  }
  return ["-----BEGIN OpenVPN Static key V1-----", ...lines, "-----END OpenVPN Static key V1-----"].join(
    "\n",
  );
}
