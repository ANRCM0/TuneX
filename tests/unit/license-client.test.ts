/**
 * LicenseService — the panel's HTTP client for the license server.
 *
 * The cache/refresh logic is what decides whether a site keeps its license after the
 * server is unreachable, and the error mapping is what admins see. `fetch` is stubbed;
 * Redis is an in-memory fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseService } from "../../apps/backend/src/services/license";

let service: LicenseService;

const redisState: { license: Record<string, unknown> | null } = { license: null };
const redisCalls: string[] = [];
const fetchCalls: { url: string; init?: RequestInit }[] = [];

const licenseRow = {
  expired_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  site_url: "https://panel.test",
  type: "business",
  content: "fernet-token",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.test";
  process.env.LICENSE_URL = "http://license.test";
  const { LicenseService: Service } = await import("../../apps/backend/src/services/license");
  service = new Service({
    getLicense: async () => {
      redisCalls.push("getLicense");
      return redisState.license;
    },
    setLicense: async (value: unknown) => {
      redisCalls.push("setLicense");
      redisState.license = value as Record<string, unknown>;
    },
    delLicense: async () => {
      redisCalls.push("delLicense");
      redisState.license = null;
    },
  } as never);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  redisState.license = null;
  redisCalls.length = 0;
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return jsonResponse(licenseRow);
  });
});

describe("getLicense", () => {
  it("returns a cached license for the same site without calling the server", async () => {
    redisState.license = { ...licenseRow };

    const license = await service.getLicense();

    expect(license).toMatchObject({ site_url: "https://panel.test" });
    expect(fetchCalls).toHaveLength(0);
    expect(redisCalls).toEqual(["getLicense"]);
  });

  it("refreshes a license cached for another site and stores the new one", async () => {
    redisState.license = { ...licenseRow, site_url: "https://old.test" };

    const license = await service.getLicense();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://license.test/license?site_url=https%3A%2F%2Fpanel.test");
    expect(license).toMatchObject({ site_url: "https://panel.test" });
    expect(redisCalls).toEqual(["getLicense", "setLicense"]);
  });

  it("forces a refresh and clears the cache when the server has no license", async () => {
    redisState.license = { ...licenseRow };
    vi.stubGlobal("fetch", async () => jsonResponse(null));

    const license = await service.getLicense(true);

    expect(license).toBeNull();
    expect(redisCalls).toEqual(["delLicense"]);
  });

  it("maps a transport failure to a 500", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(service.getLicense()).rejects.toMatchObject({
      status: 500,
      message: "获取远程 License 失败",
    });
  });
});

describe("other endpoints", () => {
  it("posts a license purchase with the site and payment fields", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ pay_url: "https://pay.test/1" });
    });

    const result = await service.payLicense(
      "pay-1",
      "alipay",
      "year" as never,
      "https://back.test",
      "1.2.3.4",
      "business" as never,
      "C10",
    );

    expect(result).toEqual({ pay_url: "https://pay.test/1" });
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    expect(body).toEqual({
      site_url: "https://panel.test",
      payment_id: "pay-1",
      pay_type: "alipay",
      cycle: "year",
      redirect_url: "https://back.test",
      client_ip: "1.2.3.4",
      type: "business",
      coupon: "C10",
    });
  });

  it("returns coupon data or maps the server error message", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ code: "C10", value: 10 });
    });
    await expect(service.getCoupon("C10", "business" as never, "month" as never)).resolves.toEqual({
      code: "C10",
      value: 10,
    });
    expect(fetchCalls[0].url).toContain("/coupon?code=C10");
    expect(fetchCalls[0].url).toContain("site_url=https%3A%2F%2Fpanel.test");

    vi.stubGlobal("fetch", async () => jsonResponse({ error: "优惠码已失效" }, 404));
    await expect(service.getCoupon("C10", "business" as never, "month" as never)).rejects.toMatchObject({
      status: 404,
      message: "优惠码已失效",
    });

    vi.stubGlobal("fetch", async () => jsonResponse({}, 500));
    await expect(service.getCoupon("C10", "business" as never, "month" as never)).rejects.toMatchObject({
      status: 500,
      message: "获取优惠码失败",
    });
  });

  it("requires a cached license before rebinding the site", async () => {
    await expect(service.updateLicense("https://new.test")).rejects.toMatchObject({
      status: 404,
      message: "请先购买 License",
    });

    redisState.license = { ...licenseRow };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    });
    await service.updateLicense("https://new.test");
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
      site_url: "https://new.test",
      content: "fernet-token",
    });
    expect(redisCalls).toContain("delLicense");

    redisState.license = { ...licenseRow };
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "域名被占用" }, 409));
    await expect(service.updateLicense("https://new.test")).rejects.toMatchObject({
      status: 409,
      message: "域名被占用",
    });
  });

  it("returns history pages and maps failures", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ data: [{ id: "h1" }], total: 1 });
    });
    await expect(service.getHistory(2, 5, "id:desc", "success", "o-1")).resolves.toEqual({
      data: [{ id: "h1" }],
      total: 1,
    });
    expect(fetchCalls[0].url).toContain("page=2");
    expect(fetchCalls[0].url).toContain("limit=5");

    vi.stubGlobal("fetch", async () => jsonResponse({ error: "boom" }, 500));
    await expect(service.getHistory()).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("compares an ISO expired_at as a timestamp", async () => {
    const { licenseExpired } = await import("../../apps/backend/src/services/license");
    const now = new Date("2020-01-01T00:00:00.000Z");
    expect(licenseExpired("2000-01-01T00:00:00.000Z", now)).toBe(true);
    expect(licenseExpired("2099-01-01T00:00:00.000Z", now)).toBe(false);
    expect(licenseExpired(new Date("2099-01-01T00:00:00.000Z"), now)).toBe(false);
  });
});
