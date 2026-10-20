/**
 * Cloudflare DNS provider against a real HTTP server.
 *
 * The existing unit suite mocks `fetch`; this one drives the actual client through
 * `CLOUDFLARE_API_BASE` and asserts the wire contract the panel depends on:
 *
 *   GET  /zones?name=<root>&status=active        → zone id
 *   GET  /zones/<id>/dns_records?name=<domain>   → A/AAAA records
 *   POST /zones/<id>/dns_records                 → create
 *   PATCH /zones/<id>/dns_records/<record>       → update in place
 *   DELETE /zones/<id>/dns_records/<record>      → delete
 *
 * and that the token is sent as a bearer credential, never in the URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpFixture } from "./fixtures/http_fixture";

const fixture = new HttpFixture();
let provider: import("../../apps/backend/src/services/dns/cloudflare").CloudflareDNSProvider;

const ZONE_ID = "zone-abc";
const RECORD_ID = "rec-1";

beforeAll(async () => {
  await fixture.start();
  process.env.CLOUDFLARE_API_BASE = fixture.baseUrl;
  const mod = await import("../../apps/backend/src/services/dns/cloudflare");
  provider = new mod.CloudflareDNSProvider("node.example.com", {
    api_token: "cf-token-123",
  } as never);
});

afterAll(async () => {
  await fixture.stop();
  delete process.env.CLOUDFLARE_API_BASE;
});

beforeEach(() => {
  fixture.requests.length = 0;
  fixture.route({
    "GET /zones": { body: { success: true, result: [{ id: ZONE_ID, name: "example.com" }] } },
    [`GET /zones/${ZONE_ID}/dns_records`]: {
      body: {
        success: true,
        result: [
          { id: RECORD_ID, type: "A", content: "203.0.113.7" },
          { id: "rec-txt", type: "TXT", content: "ignore-me" },
        ],
      },
    },
    [`POST /zones/${ZONE_ID}/dns_records`]: { body: { success: true, result: { id: "rec-new" } } },
    [`PATCH /zones/${ZONE_ID}/dns_records/${RECORD_ID}`]: {
      body: { success: true, result: { id: RECORD_ID } },
    },
    [`DELETE /zones/${ZONE_ID}/dns_records/${RECORD_ID}`]: {
      body: { success: true, result: { id: RECORD_ID } },
    },
  });
});

describe("cloudflare provider over HTTP", () => {
  it("lists A/AAAA records and filters other types", async () => {
    const records = await provider.listRecords();
    expect(records).toEqual([{ ip: "203.0.113.7", type: "A" }]);

    const zoneCall = fixture.requests[0];
    expect(zoneCall.path).toBe("/zones");
    expect(zoneCall.query.get("name")).toBe("example.com");
    expect(zoneCall.query.get("status")).toBe("active");
    expect(zoneCall.headers.authorization).toBe("Bearer cf-token-123");

    const recordCall = fixture.requests[1];
    expect(recordCall.path).toBe(`/zones/${ZONE_ID}/dns_records`);
    expect(recordCall.query.get("name")).toBe("node.example.com");
    expect(recordCall.query.get("type")).toBeNull();
  });

  it("creates a record with the expected body", async () => {
    const ok = await provider.createRecord("198.51.100.9", "A", 120, 1, "0");
    expect(ok).toBe(true);
    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe(`/zones/${ZONE_ID}/dns_records`);
    expect(call.body).toMatchObject({
      type: "A",
      name: "node.example.com",
      content: "198.51.100.9",
      ttl: 120,
    });
  });

  it("updates the existing record instead of creating a second one", async () => {
    await provider.updateRecord("203.0.113.7", "198.51.100.10", "A", 60);
    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("PATCH");
    expect(call.path).toBe(`/zones/${ZONE_ID}/dns_records/${RECORD_ID}`);
    expect(call.body).toMatchObject({ content: "198.51.100.10" });
  });

  it("deletes by IP after resolving the record id", async () => {
    const ok = await provider.deleteRecord("203.0.113.7");
    expect(ok).toBe(true);
    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe(`/zones/${ZONE_ID}/dns_records/${RECORD_ID}`);
  });

  it("surfaces an unknown zone as a 400 with the domain in the message", async () => {
    fixture.route({ "GET /zones": { body: { success: true, result: [] } } });
    await expect(provider.listRecords()).rejects.toMatchObject({ status: 400 });
    expect(fixture.last?.path).toBe("/zones");
  });
});
