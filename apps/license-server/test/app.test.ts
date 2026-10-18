/**
 * Route-level tests for the error contract and defaults that the 18-assertion wire test
 * does not reach. These drive the Hono app in-process (`app.request`) — no listening
 * socket needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { LicenseStore } from "../src/store";

const SITE = "https://panel.example.com";

let tempDir: string;
let store: LicenseStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "relayx-license-app-"));
  store = new LicenseStore(join(tempDir, "license.db"));
  app = createApp(store);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /license", () => {
  it("requires site_url", async () => {
    const response = await app.request("/license");
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "site_url is required" });
  });

  it("returns 404 for an unlicensed site", async () => {
    const response = await app.request(`/license?site_url=${encodeURIComponent("https://unknown.example.com")}`);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "license not found" });
  });
});

describe("GET /coupon and unknown routes", () => {
  it("answers 404 with the self-hosted coupon message", async () => {
    const response = await app.request("/coupon?code=NOPE&type=business&site_url=x&cycle=year");
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: "coupon not supported by self-hosted license server",
    });
  });

  it("answers 404 not found for any other route", async () => {
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "not found" });
  });
});

describe("POST /license", () => {
  it("treats an empty body as an empty JSON object", async () => {
    const response = await app.request("/license", { method: "POST" });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "site_url is required" });
  });

  it("treats malformed JSON as an empty JSON object", async () => {
    const response = await app.request("/license", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "site_url is required" });
  });

  it("defaults type to business, cycle to year and redirect_url to /", async () => {
    const response = await app.request("/license", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_url: SITE }),
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.url).toBe("/");
    expect(body.status).toBe("success");
    expect(typeof body.trade_id).toBe("string");
    expect(body.trade_id).toBe(body.order_id);
    const license = body.license as Record<string, unknown>;
    expect(license.type).toBe("business");
    const days = (Date.parse(String(license.expired_at)) - Date.parse(String(license.created_at))) / 86_400_000;
    expect(Math.round(days)).toBe(365);
  });

  it("maps every payment cycle to the reference number of days", async () => {
    const expected: Record<string, number> = {
      month: 30,
      quarter: 91,
      half_year: 182,
      year: 365,
      lifetime: 36_500,
    };
    for (const [cycle, days] of Object.entries(expected)) {
      const response = await app.request("/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site_url: `https://${cycle}.example.com`, cycle }),
      });
      expect(response.status).toBe(200);
      const license = (await json(response)).license as Record<string, unknown>;
      const issuedDays =
        (Date.parse(String(license.expired_at)) - Date.parse(String(license.created_at))) / 86_400_000;
      expect(Math.round(issuedDays), `cycle=${cycle}`).toBe(days);
    }
  });
});

describe("PUT /license", () => {
  it("requires both site_url and content", async () => {
    const response = await app.request("/license", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_url: "https://renamed.example.com" }),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "site_url and content are required" });
  });

  it("returns 404 when the content is unknown", async () => {
    const response = await app.request("/license", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_url: "https://renamed.example.com", content: "selfhosted-nope" }),
    });
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "license content not found" });
  });
});

describe("GET /license/history", () => {
  it("clamps page/limit and tolerates a missing site_url", async () => {
    for (let index = 0; index < 3; index += 1) {
      store.addOrder(SITE, "business", "year", null);
    }
    const clamped = await app.request(
      `/license/history?site_url=${encodeURIComponent(SITE)}&page=0&limit=0`,
    );
    expect(clamped.status).toBe(200);
    const clampedBody = await json(clamped);
    expect(clampedBody).toMatchObject({ total: 3 });
    expect((clampedBody.data as unknown[]).length).toBe(1);

    const capped = await app.request(
      `/license/history?site_url=${encodeURIComponent(SITE)}&page=1&limit=999`,
    );
    expect(capped.status).toBe(200);
    expect(((await json(capped)).data as unknown[]).length).toBe(3);

    const noSite = await app.request("/license/history");
    expect(noSite.status).toBe(200);
    expect(await json(noSite)).toEqual({ data: [], total: 0 });
  });
});
