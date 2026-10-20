/**
 * Per-route validator parity — the other half of the guard story.
 *
 * `docs/PARITY.md` listed "middleware registered inside route files
 * (`zValidator` targets) is not compared" as open. This suite compares the
 * `json`/`query`/`param` validation targets parsed from every router module with
 * `relayx-analysis/work/api_map.json` (`requestSchemas[].in` per upstream
 * registration).
 *
 * What it proves: for all 160 upstream registrations the replica declares the
 * same validation targets. What it does not prove: the schema shapes themselves
 * (models are covered by `tests/unit/schema-parity.test.ts`).
 *
 * Skips when the analysis tree is not a sibling of the repo. Parsing lives in
 * `tests/helpers/route-parse.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_MAP, replicaRegistrations } from "../helpers/route-parse";

interface RouteRegistration {
  method: string;
  path: string;
  requestSchemas: { in: string }[] | null;
}

const PRESENT = existsSync(API_MAP);

describe.skipIf(!PRESENT)("route validator parity", () => {
  const api = PRESENT
    ? (JSON.parse(readFileSync(API_MAP, "utf8")) as { routes: RouteRegistration[] }).routes
    : [];
  const replica = PRESENT ? replicaRegistrations() : new Map<string, string[]>();

  it("parses the whole mount tree", () => {
    // 157 upstream distinct keys, plus `/queuedash` and the three `/health`
    // probes that `api_map.json` records outside its `routes` array. The 160
    // upstream registrations collapse to 157 because `/license` is mounted
    // twice; `router.on(["POST", "GET"], …)` contributes two keys of its own.
    // +6 local-auth registrations (`/auth/sign-up|sign-in|sign-out|refresh|me|verify-email`).
    expect(replicaRegistrations().size).toBe(167);
  });

  it("finds every upstream registration", () => {
    const missing = api
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !replica.has(key));
    expect(missing).toEqual([]);
  });

  it("declares the same validation targets as the decompile", () => {
    const differences: string[] = [];
    for (const route of api) {
      const key = `${route.method} ${route.path}`;
      const expected = (route.requestSchemas ?? []).map((schema) => schema.in).sort();
      const observed = replica.get(key)!;
      if (expected.join(",") !== observed.join(",")) {
        differences.push(`${key}: upstream=[${expected}] replica=[${observed}]`);
      }
    }
    expect(differences).toEqual([]);
  });

  it("matches the upstream target totals", () => {
    const totals = new Map<string, number>();
    for (const route of api) {
      for (const schema of route.requestSchemas ?? []) {
        totals.set(schema.in, (totals.get(schema.in) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries([...totals].sort())).toEqual({ json: 62, param: 47, query: 61 });
    const observed = new Map<string, number>();
    for (const route of api) {
      for (const target of replica.get(`${route.method} ${route.path}`)!) {
        observed.set(target, (observed.get(target) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries([...observed].sort())).toEqual({ json: 62, param: 47, query: 61 });
  });

  it("keeps the multi-method callback registrations on both verbs", () => {
    // `pay.ts` uses `router.on(["POST", "GET"], …/callback")`; a parser that only
    // understands `router.get` would silently drop one of the two.
    expect(replica.get("GET /pay/:id/callback")).toEqual([]);
    expect(replica.get("POST /pay/:id/callback")).toEqual([]);
  });
});
