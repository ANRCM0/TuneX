/**
 * Route/guard parity — the check `docs/PARITY.md` used to list as unproven.
 *
 * Two independent sources are compared:
 *
 *   1. The replica's guard wiring, parsed from `apps/backend/src/app.ts`.
 *   2. `relayx-analysis/work/api_map.json`, which records the decompiled
 *      upstream registration for every route (`middlewareChain`, `isAdmin`,
 *      `licenseGated`, `public`, `adminResource`).
 *
 * A third comparison pins the replica's wiring to the upstream source text:
 * `112__src__app.ts` must contain the same ordered `use(path, guards…)` list.
 *
 * Hono routing semantics used here were established empirically against the
 * installed hono 4.13.13 and re-read in the upstream bundle
 * (`work/backend_bundle.ts.js:213864-213871`, reg-exp-router tokens
 * `[^/]+` / `(?:|/.*)`): a middleware registered at `/x` matches only `/x`;
 * only a trailing `/*` also covers `/x/...`. See "Known evidence
 * discrepancy" below for the seven routes where `api_map.json` disagrees.
 *
 * The analysis tree is a sibling of the repo, so this suite skips (not fails)
 * when it is absent — e.g. a standalone clone of `relayx/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_RESOURCES,
  ADMIN_ROUTE_TABLE,
  resolveAdminRoute,
} from "../../packages/shared/src/permissions";
import { noAuthPathsRegex } from "../../apps/backend/src/middlewares/auth";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ANALYSIS = fileURLToPath(new URL("../../../relayx-analysis/", import.meta.url));

const REPLICA_APP = `${REPO}apps/backend/src/app.ts`;
const UPSTREAM_APP = `${ANALYSIS}work/modules/112__src__app.ts`;
const API_MAP = `${ANALYSIS}work/api_map.json`;

const EVIDENCE_PRESENT = existsSync(API_MAP) && existsSync(UPSTREAM_APP);

/** Guard middlewares; everything else (`cors()`, `sentry({…})`, validators) is ignored. */
const GUARD_NAMES = new Set([
  "authRequired",
  "adminRequired",
  "adminPermissionGuard",
  "superAdminRequired",
  "businessLicenseRequired",
]);

interface UseEntry {
  /** Registration path; `*` for `use(mw)` with no path argument. */
  path: string;
  /** Guard handlers, in source order. */
  guards: string[];
  /** Character offset in the source, used for registration-order comparisons. */
  index: number;
}

interface RouteRegistration {
  method: string;
  path: string;
  middlewareChain: { name: string }[];
  isAdmin: boolean;
  public: boolean;
  licenceGated: boolean;
  adminResource: { key: string; matchedPrefix: string; business: boolean | null } | null;
}

/** Split `a, b(c, d), "e,f"` on top-level commas. */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Read the argument list of every `<callee>.use(` call in `src`. */
function parseUseCalls(src: string, callee: string): UseEntry[] {
  const entries: UseEntry[] = [];
  const needle = `${callee}.use(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    const open = at + needle.length - 1;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced ${needle} at offset ${at}`);
    const args = splitTopLevel(src.slice(open + 1, end));
    const first = args[0] ?? "";
    const hasPath = first.startsWith('"') || first.startsWith("'") || first.startsWith("`");
    const path = hasPath ? first.slice(1, -1) : "*";
    const guardArgs = (hasPath ? args.slice(1) : args).map((a) => a.split("(")[0].trim());
    entries.push({
      path,
      guards: guardArgs.filter((name) => GUARD_NAMES.has(name)),
      index: at,
    });
    from = end;
  }
  return entries;
}

/** Hono path matching: non-wildcard is exact, `/*` also covers the bare prefix. */
function matches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  const pat = pattern.split("/").filter(Boolean);
  const seg = path.split("/").filter(Boolean);
  if (pat.at(-1) === "*") {
    const head = pat.slice(0, -1);
    if (seg.length < head.length) return false;
    return head.every((p, i) => p.startsWith(":") || p === seg[i]);
  }
  if (pat.length !== seg.length) return false;
  return pat.every((p, i) => p.startsWith(":") || p === seg[i]);
}

/** Offset of the top-level `app.route("<segment>", …)` mount that owns `path`. */
function mountIndex(src: string, callee: string, path: string): number {
  let best = -1;
  for (const segment of path.split("/").filter(Boolean)) {
    const re = new RegExp(`${callee}\\s*\\.route\\(\\s*"/${segment}"`, "g");
    for (const match of src.matchAll(re)) {
      if (match.index! > best) best = match.index!;
    }
  }
  return best;
}

/** Concrete path for a route template: `/pay/:id/callback` -> `/pay/1/callback`. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "1");
}

const replicaSrc = EVIDENCE_PRESENT ? readFileSync(REPLICA_APP, "utf8") : "";
const upstreamSrc = EVIDENCE_PRESENT ? readFileSync(UPSTREAM_APP, "utf8") : "";
const apiMap = EVIDENCE_PRESENT
  ? (JSON.parse(readFileSync(API_MAP, "utf8")) as {
      routes: RouteRegistration[];
      authBypassRegexes: { regex: string }[];
      totals: Record<string, number>;
    })
  : null;

const replicaUse = EVIDENCE_PRESENT ? parseUseCalls(replicaSrc, "app") : [];
const upstreamUse = EVIDENCE_PRESENT ? parseUseCalls(upstreamSrc, "app34") : [];
const guardEntries = replicaUse.filter((e) => e.guards.length > 0);

/** Effective guard chain for a path, given parsed wiring and mount positions. */
function chainFor(path: string): string[] {
  const mount = mountIndex(replicaSrc, "app", path);
  // `-1` (no mount found) is treated as "after every use() call", which is the
  // position of the final `routes = app.route(...)` chain.
  const out: string[] = [];
  for (const entry of guardEntries) {
    if ((mount === -1 || entry.index < mount) && matches(entry.path, path)) out.push(...entry.guards);
  }
  return out.filter((name, i) => out.indexOf(name) === i);
}

describe.skipIf(!EVIDENCE_PRESENT)("route guard parity", () => {
  it("reproduces the upstream `use(path, guards…)` list in the same order", () => {
    const stripPosition = (entries: UseEntry[]) => entries.map(({ path, guards }) => ({ path, guards }));
    expect(stripPosition(replicaUse)).toEqual(stripPosition(upstreamUse));
    // The public-by-registration-order mounts must precede the authRequired entry.
    const authEntry = guardEntries.find((e) => e.guards.includes("authRequired"))!;
    for (const prefix of ["/queuedash", "/health"]) {
      expect(mountIndex(replicaSrc, "app", prefix)).toBeLessThan(authEntry.index);
      expect(mountIndex(upstreamSrc, "app34", prefix)).toBeLessThan(
        upstreamUse.find((e) => e.guards.includes("authRequired"))!.index,
      );
    }
  });

  it("mounts the same top-level prefixes, in the same order", () => {
    const prefixes = (src: string, callee: string) =>
      [...src.matchAll(new RegExp(`${callee}\\s*\\.route\\(\\s*"([^"]+)"`, "g"))].map((m) => m[1]);
    // `/auth` is the replica's local-auth mount (docs/DEVIATIONS.md §30); everything else
    // must match upstream, in order.
    expect(prefixes(replicaSrc, "app").filter((p) => p !== "/auth")).toEqual(prefixes(upstreamSrc, "app34"));
  });

  it("derives the same guard chain for every upstream registration", () => {
    const routes = apiMap!.routes;
    const differing: { route: string; expected: string[]; observed: string[] }[] = [];
    for (const route of routes) {
      const expected = route.middlewareChain
        .map((m) => m.name)
        .filter((name) => GUARD_NAMES.has(name))
        .filter((name, i, all) => all.indexOf(name) === i);
      const observed = chainFor(route.path);
      if (expected.join(",") !== observed.join(",")) {
        differing.push({
          route: `${route.method} ${route.path}`,
          expected,
          observed,
        });
      }
    }

    // Known evidence discrepancy: `api_map.json` attributes `businessLicenseRequired`
    // by prefix, but Hono's non-wildcard `use("/admin/pay")` is exact-match, so the
    // `:id` children never receive it. Upstream wires exactly the same lines
    // (`112__src__app.ts:63-73`), so the replica matches upstream runtime behaviour
    // and the api map over-reports licensing for these seven routes.
    const LICENSE_ANNOTATION_GAP = [
      "PATCH /admin/pay/:id",
      "DELETE /admin/pay/:id",
      "PATCH /admin/pay/:id/order",
      "PATCH /admin/plan/coupon/:id",
      "PATCH /admin/topup/activity/:id",
      "GET /pay/:id/callback",
      "POST /pay/:id/callback",
    ];
    expect(differing.map((d) => d.route).sort()).toEqual([...LICENSE_ANNOTATION_GAP].sort());
    for (const diff of differing) {
      expect(diff.expected.filter((g) => !diff.observed.includes(g))).toEqual([
        "businessLicenseRequired",
      ]);
      expect(diff.observed.filter((g) => !diff.expected.includes(g))).toEqual([]);
    }
  });

  it("maps every admin route to the upstream permission key and prefix", () => {
    const routes = apiMap!.routes.filter((r) => r.isAdmin);
    expect(routes).toHaveLength(81);
    for (const route of routes) {
      const upstream = route.adminResource!;
      expect(upstream, `${route.method} ${route.path} has no adminResource in api_map`).toBeTruthy();
      const entry = resolveAdminRoute(concrete(route.path));
      expect(entry, `${route.method} ${route.path} is unreachable for non-super-admins`).toBeTruthy();
      expect({ key: entry!.key, prefix: entry!.prefix }).toEqual({
        key: upstream.key,
        prefix: upstream.matchedPrefix,
      });
    }
    // The map is not silently empty or reordered.
    expect(ADMIN_ROUTE_TABLE.length).toBe(
      ADMIN_RESOURCES.reduce((n, r) => n + r.apiPrefixes.length, 0) + 1 + 1,
    );
  });

  it("bypasses auth on exactly the public routes and on nothing else", () => {
    const routes = apiMap!.routes;
    const isBypassed = (path: string) => noAuthPathsRegex.some((re) => re.test(concrete(path)));
    const missed = routes.filter((r) => r.public && !isBypassed(r.path));
    const leaked = routes.filter((r) => !r.public && isBypassed(r.path));
    expect(missed.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(leaked.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(routes.filter((r) => r.public)).toHaveLength(11);
    // Same nine upstream patterns plus the local-auth escape (`/auth/sign-in|sign-up|
    // sign-out|refresh`, docs/DEVIATIONS.md §30). The replica escapes `/` and `.`, which the
    // analysis quotes verbatim from the decompile; compare with escapes removed.
    const normalize = (source: string) => source.replace(/\\/g, "");
    expect(noAuthPathsRegex.map((re) => normalize(re.source))).toEqual([
      ...apiMap!.authBypassRegexes.map((r) => normalize(r.regex)),
      "^/auth/(sign-in|sign-up|sign-out|refresh)$",
    ]);
  });

  it("agrees with the api map on route, admin and public totals", () => {
    const totals = apiMap!.totals;
    expect(totals.routeRegistrations).toBe(160);
    expect(totals.admin).toBe(81);
    expect(totals.public).toBe(11);
    expect(apiMap!.routes).toHaveLength(totals.routeRegistrations);
    expect(apiMap!.authBypassRegexes).toHaveLength(9);
  });
});
