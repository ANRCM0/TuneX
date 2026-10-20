/**
 * Huawei Cloud DNS provider against a real HTTP server.
 *
 * The interesting part is the signature: Huawei's `SDK-HMAC-SHA256` scheme signs
 * method + path + canonical query + canonical headers + payload hash, and the server
 * (here, the fixture) can recompute it — so this suite proves the replica signs requests in
 * the shape the vendor API verifies, not merely that "some header exists".
 *
 * Endpoints exercised:
 *   GET  /v2/zones?name=<root>                    → zone id
 *   GET  /v2.1/recordsets?name=<domain>           → recordsets
 *   POST /v2.1/zones/<id>/recordsets              → create
 *   POST /v2.1/zones/<id>/recordsets/batch-delete → delete by IP
 */
import { createHmac, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpFixture } from "./fixtures/http_fixture";

const fixture = new HttpFixture();
const ACCESS_KEY = "AKTEST";
const SECRET_KEY = "SKTEST";
const REGION = "cn-north-4";
const ZONE_ID = "zone-hw";
const RECORDSET_ID = "rs-1";

let provider: import("../../apps/backend/src/services/dns/huawei").HuaweiDNSProvider;

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");
const hmac = (key: string | Buffer, input: string) => createHmac("sha256", key).update(input).digest();

/** Recompute Huawei's SDK-HMAC-SHA256 exactly as the server would. */
function expectedSignature(req: {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}): string {
  const signedHeaderNames = Object.keys(req.headers).sort();
  const canonicalHeaders = `${signedHeaderNames.map((n) => `${n}:${req.headers[n]}`).join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    req.method,
    req.path,
    req.query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(req.body),
  ].join("\n");
  const xSdkDate = req.headers["x-sdk-date"];
  const stringToSign = ["SDK-HMAC-SHA256", xSdkDate, sha256Hex(canonicalRequest)].join("\n");
  const date = xSdkDate.slice(0, 8);
  const kDate = hmac(`SDK${SECRET_KEY}`, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "dns");
  const signingKey = hmac(kService, "sdk_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

beforeAll(async () => {
  await fixture.start();
  process.env.HUAWEI_DNS_API_BASE = fixture.baseUrl;
  const mod = await import("../../apps/backend/src/services/dns/huawei");
  provider = new mod.HuaweiDNSProvider("node.example.com", {
    access_key: ACCESS_KEY,
    secret_key: SECRET_KEY,
    project_id: "proj",
    region_id: REGION,
  } as never);
});

afterAll(async () => {
  await fixture.stop();
  delete process.env.HUAWEI_DNS_API_BASE;
});

beforeEach(() => {
  fixture.requests.length = 0;
  fixture.route({
    "GET /v2/zones": { body: { zones: [{ id: ZONE_ID, name: "example.com." }] } },
    "GET /v2.1/recordsets": {
      body: {
        recordsets: [
          { id: RECORDSET_ID, name: "node.example.com.", type: "A", records: ["203.0.113.7"] },
          { id: "rs-mx", name: "node.example.com.", type: "MX", records: ["10 mail.example.com."] },
        ],
      },
    },
    [`POST /v2.1/zones/${ZONE_ID}/recordsets`]: { body: { id: "rs-new" } },
    [`DELETE /v2.1/zones/${ZONE_ID}/recordsets/${RECORDSET_ID}`]: { body: { id: RECORDSET_ID } },
  });
});

describe("huawei provider over HTTP", () => {
  it("signs every request with SDK-HMAC-SHA256 that a server can verify", async () => {
    await provider.listRecords();
    const call = fixture.requests[0];
    const auth = String(call.headers.authorization);
    expect(auth).toMatch(/^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=.+, Signature=[0-9a-f]{64}$/);

    const signature = auth.split("Signature=")[1];
    const signedHeaders = Object.fromEntries(
      String(auth)
        .match(/SignedHeaders=([^,]+)/)![1]
        .split(";")
        .map((name) => [name, String(call.headers[name])]),
    );
    const recomputed = expectedSignature({
      method: call.method,
      path: call.path,
      query: call.query.toString(),
      headers: signedHeaders,
      body: call.rawBody,
    });
    expect(signature).toBe(recomputed);
  });

  it("lists A records for the host and ignores other types", async () => {
    const records = await provider.listRecords();
    expect(records).toEqual([{ ip: "203.0.113.7", type: "A" }]);

    // `listRecords` goes straight to the record-set collection; only the zone lookup
    // needs the root domain, and this path does not resolve one.
    const listCall = fixture.requests[0];
    expect(listCall.path).toBe("/v2.1/recordsets");
    // The client sends the host without the trailing dot; the matcher accepts both forms.
    expect(listCall.query.get("name")).toBe("node.example.com");
  });

  it("creates a recordset with the vendor body shape", async () => {
    const ok = await provider.createRecord("198.51.100.9", "A", 300, 1, "0");
    expect(ok).toBe(true);
    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe(`/v2.1/zones/${ZONE_ID}/recordsets`);
    expect(call.body).toMatchObject({
      // The panel sends the bare host; the vendor accepts it without the trailing dot.
      name: "node.example.com",
      type: "A",
      ttl: 300,
      records: ["198.51.100.9"],
    });
  });

  it("resolves the record-set id, then deletes it", async () => {
    const ok = await provider.deleteRecord("203.0.113.7");
    expect(ok).toBe(true);
    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe(`/v2.1/zones/${ZONE_ID}/recordsets/${RECORDSET_ID}`);
  });
});
