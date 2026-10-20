/**
 * Metrics registry and HTTP instrumentation.
 *
 * The panel previously exposed only `/health`. These cases pin the Prometheus contract:
 * counters accumulate per label set, histograms bucket by explicit boundaries, the
 * exposition is valid text 0.0.4, and `/metrics` answers a loopback scrape while hiding
 * itself from a remote peer when no `DIAG_TOKEN` is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import { incr, observe, render, resetMetrics, setGauge } from "../../apps/backend/src/services/metrics";

const temp: TempDatabase = createTempDatabase("metrics");
process.env.DATABASE_URL = temp.url;

const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };
const remote = { incoming: { socket: { remoteAddress: "203.0.113.9" } }, outgoing: {} };

let app: { request: (path: string, init?: RequestInit, e?: unknown) => Promise<Response> };

beforeAll(async () => {
  const mod = await import("../../apps/backend/src/app");
  app = mod.default as never;
});

afterAll(() => temp.cleanup());

describe("registry", () => {
  it("accumulates counters per sorted label set", () => {
    resetMetrics();
    incr("demo_total", { b: "2", a: "1" });
    incr("demo_total", { a: "1", b: "2" });
    incr("demo_total", { a: "1", b: "3" });
    const text = render();
    expect(text).toContain("# TYPE demo_total counter");
    expect(text).toContain('demo_total{a="1",b="2"} 2');
    expect(text).toContain('demo_total{a="1",b="3"} 1');
  });

  it("buckets observations cumulatively and keeps sum/count", () => {
    resetMetrics();
    observe("demo_seconds", 0.004);
    observe("demo_seconds", 0.03);
    observe("demo_seconds", 2);
    const text = render();
    expect(text).toContain('demo_seconds_bucket{le="0.005"} 1');
    expect(text).toContain('demo_seconds_bucket{le="0.05"} 2');
    expect(text).toContain('demo_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("demo_seconds_count 3");
    expect(text).toMatch(/demo_seconds_sum 2\.03/);
  });

  it("renders gauges without labels", () => {
    resetMetrics();
    setGauge("demo_up", 1);
    expect(render()).toContain("demo_up 1");
  });

  it("escapes quotes in label values", () => {
    resetMetrics();
    incr("demo_total", { path: '/a"b' });
    expect(render()).toContain('demo_total{path="/a_b"} 1');
  });
});

describe("HTTP instrumentation", () => {
  it("counts requests, records latency and stamps a request id", async () => {
    resetMetrics();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const text = render();
    expect(text).toContain("relayx_http_requests_total");
    expect(text).toContain('method="GET"');
    expect(text).toContain("relayx_http_request_duration_seconds_count");
  });

  it("preserves an incoming request id", async () => {
    const res = await app.request("/health", { headers: { "x-request-id": "trace-abc" } }, env);
    expect(res.headers.get("x-request-id")).toBe("trace-abc");
  });

  it("serves the exposition to loopback and hides it from a remote peer", async () => {
    const local = await app.request("/metrics", {}, env);
    expect(local.status).toBe(200);
    expect(local.headers.get("content-type")).toContain("text/plain");
    expect(await local.text()).toContain("relayx_http_requests_total");

    const foreign = await app.request("/metrics", {}, remote);
    expect(foreign.status).toBe(404);
  });
});
