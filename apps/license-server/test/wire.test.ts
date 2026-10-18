/**
 * Wire-level acceptance test — a TypeScript port of
 * `relayx-analysis/verify_license_server.py` (the reference harness: 18/18 assertions).
 *
 * Lives in `apps/license-server/test/` rather than `relayx/tests/` because the verify
 * teammate owns that tree; this is the alternative the task brief allows.
 *
 * The `call()` helper below mirrors the frozen panel client
 * (`apps/backend/src/services/license.ts`): plain `fetch`, JSON body only for non-GET
 * requests, JSON parsed only when the response advertises it, `data === null` on non-2xx
 * so that `error.value` carries the `{error}` envelope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createApp } from "../src/app";
import { startLicenseServer, type RunningLicenseServer } from "../src/server";
import { LicenseStore } from "../src/store";

const SITE = "https://panel.example.com";

interface WireResponse {
  ok: boolean;
  status: number;
  data: unknown;
  error?: { status: number; value: unknown };
}

/**
 * Port of the harness `_call(base, segments, args)`: the last segment is the HTTP
 * method, the preceding segments are the path, `args.query` becomes the query string
 * (null/undefined values skipped) and for non-GET methods `args` itself is the JSON body.
 */
async function call(
  baseUrl: string,
  segments: string[],
  args: Record<string, unknown> = {},
): Promise<WireResponse> {
  const method = (segments[segments.length - 1] ?? "GET").toUpperCase();
  const path = `/${segments.slice(0, -1).join("/")}`;
  const url = new URL(path, baseUrl);
  const query = args.query as Record<string, unknown> | undefined;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(args);
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  const parsed: unknown = contentType.includes("application/json") && raw !== "" ? JSON.parse(raw) : raw;
  const ok = response.status >= 200 && response.status < 300;
  return ok
    ? { ok, status: response.status, data: parsed }
    : { ok, status: response.status, data: null, error: { status: response.status, value: parsed } };
}

let tempDir: string;
let store: LicenseStore;
let server: RunningLicenseServer;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "relayx-license-wire-"));
  store = new LicenseStore(join(tempDir, "license.db"));
  server = await startLicenseServer(createApp(store), { port: 0 });
});

afterAll(async () => {
  await server?.close();
  store?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

it("passes the 18 wire-level assertions from verify_license_server.py", async () => {
  let assertions = 0;
  const assert = (label: string, condition: boolean): void => {
    expect(condition, label).toBe(true);
    assertions += 1;
  };

  // [0] prep (not counted among the 18): a paid order succeeds and issues the license.
  const prep = await call(server.url, ["license", "POST"], {
    site_url: SITE,
    payment_id: 1,
    pay_type: null,
    cycle: "year",
    redirect_url: SITE,
    client_ip: "127.0.0.1",
    type: "business",
    coupon: null,
  });
  expect(prep.ok, "prep POST /license 应为 2xx").toBe(true);

  // [1] GET /license — 6 assertions.
  const license = await call(server.url, ["license", "GET"], { query: { site_url: SITE } });
  const licenseData = license.data as Record<string, unknown>;
  assert("1. GET /license 返回 2xx", license.ok);
  assert(
    "2. data 为对象",
    typeof license.data === "object" && license.data !== null && !Array.isArray(license.data),
  );
  assert("3. data.site_url 与 SITE_URL 完全一致", licenseData.site_url === SITE);
  assert("4. data.type === business", licenseData.type === "business");
  assert("5. typeof data.expired_at === string", typeof licenseData.expired_at === "string");
  assert(
    "6. data.content 为非空字符串",
    typeof licenseData.content === "string" && licenseData.content.length > 0,
  );

  // [2] GET /pay — 2 assertions.
  const pay = await call(server.url, ["pay", "GET"]);
  assert("7. GET /pay 返回 2xx", pay.ok);
  assert("8. pay.data 不为空", pay.data !== null && pay.data !== undefined);

  // [3] GET /license/history — 2 assertions.
  const history = await call(server.url, ["license", "history", "GET"], {
    query: { site_url: SITE, page: 1, limit: 10, sort: null, status: null, order_id: null },
  });
  assert("9. GET /license/history 返回 2xx", history.ok);
  assert(
    "10. data 为含 data 数组的对象",
    typeof history.data === "object" &&
      history.data !== null &&
      Array.isArray((history.data as Record<string, unknown>).data),
  );

  // [4] GET /coupon — 2 assertions (self-hosted部署不支持优惠码).
  const coupon = await call(server.url, ["coupon", "GET"], {
    query: { code: "NOPE", type: "business", site_url: SITE, cycle: "year" },
  });
  assert("11. GET /coupon 非 2xx", !coupon.ok);
  const couponError = coupon.error?.value as { error?: unknown } | undefined;
  assert("12. error.value.error 为字符串", typeof couponError?.error === "string");

  // [5] POST /license — 2 assertions.
  const paid = await call(server.url, ["license", "POST"], {
    site_url: SITE,
    payment_id: 2,
    pay_type: null,
    cycle: "year",
    redirect_url: `${SITE}/admin/license`,
    client_ip: "127.0.0.1",
    type: "business",
    coupon: null,
  });
  const paidData = paid.data as Record<string, unknown>;
  assert("13. POST /license 成功（error 为 None）", paid.ok && paid.error === undefined);
  assert("14. POST /license 响应含 url 字段", typeof paidData.url === "string");

  // [6] PUT /license + GET on the new domain — 2 assertions.
  const renamedSite = SITE.replace("panel", "renamed");
  const updated = await call(server.url, ["license", "PUT"], {
    site_url: renamedSite,
    content: licenseData.content,
  });
  assert("15. PUT /license 换绑成功", updated.ok);
  const rebound = await call(server.url, ["license", "GET"], { query: { site_url: renamedSite } });
  const reboundData = rebound.data as Record<string, unknown>;
  assert(
    "16. 新域名可查到授权且 site_url 一致",
    rebound.ok && reboundData.site_url === renamedSite,
  );

  // [7] GET /license for an unknown site — 2 assertions.
  const unknown = await call(server.url, ["license", "GET"], {
    query: { site_url: "https://unknown.example.com" },
  });
  assert("17. 未知站点返回非 2xx", !unknown.ok);
  assert("18. 未知站点 data 为 None", unknown.data === null);

  expect(assertions, "应恰好覆盖参考实现的 18 条断言").toBe(18);
});

it("ignores trailing slashes like the Python handler", async () => {
  const response = await fetch(
    `${server.url}/license/?site_url=${encodeURIComponent("https://panel.example.com")}`,
  );
  // The license was rebound to the renamed domain in the previous test.
  expect(response.status).toBe(404);
  const renamed = await fetch(
    `${server.url}/license/?site_url=${encodeURIComponent("https://renamed.example.com")}`,
  );
  expect(renamed.status).toBe(200);
});

it("serves /health with the reference body shape", async () => {
  const response = await fetch(`${server.url}/health`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok?: unknown; ts?: unknown };
  expect(body.ok).toBe(true);
  expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
});
