/**
 * Route-table parity — the headline claim of `docs/PARITY.md`, automated.
 *
 * The table was previously compared once by hand (157 upstream distinct
 * `METHOD path`, 163 in the replica, 6 documented extras). This suite rebuilds
 * the replica table from source: every router module mounted through `app.ts`,
 * plus the two handlers declared on `app` itself. It then asserts:
 *
 *   - no upstream `METHOD path` is missing;
 *   - the only replica paths absent from `api_map.json` are the six documented
 *     extras (the health probes, `/queuedash`, `/docs`, `/openapi.json`);
 *   - both counts still match `docs/PARITY.md` (157 upstream, 163 replica).
 *
 * Skips when the analysis tree is not a sibling of the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_MAP,
  appLevelRegistrations,
  replicaRegistrations,
} from "../helpers/route-parse";

interface RouteRegistration {
  method: string;
  path: string;
}

/** The six upstream mounts `api_map.json` records outside its `routes` array. */
const DOCUMENTED_EXTRAS = [
  "GET /queuedash",
  "GET /health",
  "GET /health/diag",
  "GET /health/heap",
  "GET /docs",
  "GET /openapi.json",
  // Replica-local authentication (docs/DEVIATIONS.md §30).
  "POST /auth/sign-up",
  "POST /auth/sign-in",
  "POST /auth/sign-out",
  "POST /auth/refresh",
  "GET /auth/me",
  "POST /auth/verify-email",
  "POST /auth/verify-email/request",
];

const PRESENT = existsSync(API_MAP);

describe.skipIf(!PRESENT)("route table parity", () => {
  const api = PRESENT
    ? (JSON.parse(readFileSync(API_MAP, "utf8")) as { routes: RouteRegistration[] }).routes
    : [];

  const replicaTable = new Set<string>([
    ...replicaRegistrations().keys(),
    ...appLevelRegistrations().keys(),
  ]);
  const upstreamTable = new Set(api.map((route) => `${route.method} ${route.path}`));

  it("has the documented upstream shape", () => {
    expect(api).toHaveLength(160);
    expect(upstreamTable.size).toBe(157);
  });

  it("is missing no upstream registration", () => {
    const missing = [...upstreamTable].filter((key) => !replicaTable.has(key));
    expect(missing).toEqual([]);
  });

  it("adds exactly the documented extras", () => {
    const extras = [...replicaTable].filter((key) => !upstreamTable.has(key));
    expect(extras.sort()).toEqual([...DOCUMENTED_EXTRAS].sort());
  });

  it("still has the documented replica count", () => {
    expect(replicaTable.size).toBe(170);
  });
});
