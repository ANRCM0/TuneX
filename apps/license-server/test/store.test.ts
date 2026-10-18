/**
 * Store tests — covers the behaviours the Python `Store` class guarantees:
 * one active license per site, renewal that keeps the original `content`, rebinding by
 * opaque content, revocation, order history pagination, and the three content modes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RELAYX_AGENT_LICENSE_SECRET } from "../src/config";
import { fernetDecrypt } from "../src/fernet";
import { LicenseStore } from "../src/store";

const SITE = "https://panel.example.com";
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

let tempDir: string;
let store: LicenseStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "relayx-license-store-"));
  store = new LicenseStore(join(tempDir, "license.db"));
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("issue / get", () => {
  it("issues an active business license with reference-format timestamps", () => {
    const license = store.issue(SITE, "business", 365);
    expect(license.site_url).toBe(SITE);
    expect(license.type).toBe("business");
    expect(license.content).toMatch(/^selfhosted-/);
    expect(license.expired_at).toMatch(ISO_SECONDS);
    expect(license.created_at).toMatch(ISO_SECONDS);
    expect(store.get(SITE)).toEqual(license);
  });

  it("renews an existing license without changing its content", () => {
    const first = store.issue(SITE, "business", 30);
    const renewed = store.issue(SITE, "personal", 365);
    expect(renewed.content).toBe(first.content);
    expect(renewed.created_at).toBe(first.created_at);
    expect(renewed.type).toBe("personal");
    expect(renewed.expired_at).not.toBe(first.expired_at);
    expect(renewed.expired_at > first.expired_at).toBe(true);
  });

  it("keeps one active row per site", () => {
    store.issue(SITE, "business", 30);
    store.issue(SITE, "business", 30);
    expect(store.all()).toHaveLength(1);
  });

  it("returns null for an unknown site", () => {
    expect(store.get("https://unknown.example.com")).toBeNull();
  });

  it("supports base64 and fernet content modes", () => {
    const base64License = store.issue("https://b64.example.com", "business", 30, "base64");
    const base64Payload = JSON.parse(
      Buffer.from(base64License.content.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(base64Payload).toMatchObject({
      v: 1,
      type: "business",
      site_url: "https://b64.example.com",
      edition: "self-hosted",
    });
    expect(base64Payload.expired_at).toEqual(expect.any(Number));

    const fernetLicense = store.issue("https://fernet.example.com", "business", 30, "fernet");
    const fernetPayload = JSON.parse(
      fernetDecrypt(RELAYX_AGENT_LICENSE_SECRET, fernetLicense.content).toString("utf8"),
    ) as Record<string, unknown>;
    expect(fernetPayload).toMatchObject({
      v: 1,
      type: "business",
      site_url: "https://fernet.example.com",
      edition: "self-hosted",
    });
    expect(fernetPayload.expired_at).toEqual(expect.any(Number));
    expect(fernetPayload.expired_at as number).toBeGreaterThan(fernetPayload.iat as number);
  });
});

describe("rebind / revoke", () => {
  it("rebinds a license to a new domain by content", () => {
    const license = store.issue(SITE, "business", 365);
    const renamed = "https://renamed.example.com";
    expect(store.rebind(license.content, renamed)).toBe(true);
    expect(store.get(SITE)).toBeNull();
    const moved = store.get(renamed);
    expect(moved?.content).toBe(license.content);
    expect(moved?.site_url).toBe(renamed);
  });

  it("reports false when the content is unknown", () => {
    expect(store.rebind("selfhosted-nope", "https://renamed.example.com")).toBe(false);
  });

  it("revokes every active license for a site exactly once", () => {
    store.issue(SITE, "business", 365);
    expect(store.revoke(SITE)).toBe(1);
    expect(store.get(SITE)).toBeNull();
    expect(store.revoke(SITE)).toBe(0);
  });
});

describe("orders / history", () => {
  it("records orders with 16 hex chars and paginates newest-first", () => {
    const first = store.addOrder(SITE, "business", "year", null);
    const second = store.addOrder(SITE, "business", "month", "alipay");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toBe(second);

    store.addOrder(SITE, "personal", "lifetime", null);
    const page = store.history(SITE, 1, 2);
    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(2);
    expect(page.data[0]?.pay_type).toBeNull();
    expect(page.data[1]?.pay_type).toBe("alipay");

    const secondPage = store.history(SITE, 2, 2);
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.total).toBe(3);
  });

  it("returns an empty page for an unknown site", () => {
    expect(store.history("https://unknown.example.com", 1, 10)).toEqual({ data: [], total: 0 });
  });
});
