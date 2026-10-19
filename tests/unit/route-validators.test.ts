/**
 * Per-route validator parity — the other half of the guard story.
 *
 * `docs/PARITY.md` still listed "middleware registered inside route files
 * (`zValidator` targets) is not compared" as open. This suite parses
 * `apps/backend/src/app.ts` for the mount tree, parses every route file for its
 * `router.<method>(path, …zValidator("json"|"query"|"param", …))` registrations,
 * and compares the result with `relayx-analysis/work/api_map.json`
 * (`requestSchemas[].in` per upstream registration).
 *
 * What it proves: for all 160 upstream registrations the replica declares the
 * same validation targets. What it does not prove: the schema shapes themselves
 * (that is `tests/unit/schema-parity.test.ts` for models, and the route tests for
 * request bodies).
 *
 * Skips when the analysis tree is not a sibling of the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SRC = `${REPO}apps/backend/src`;
const ANALYSIS = fileURLToPath(new URL("../../../relayx-analysis/", import.meta.url));
const API_MAP = `${ANALYSIS}work/api_map.json`;

interface RouteRegistration {
  method: string;
  path: string;
  requestSchemas: { in: string }[] | null;
}

type Registration = [method: string, path: string, targets: string[]];

/** Split an argument list on top-level commas. */
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

/** Index of the `)` that closes the `(` at `open`. */
function findClose(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

/** `router.<verb>(path, …)` plus `router.on([verbs], path, …)` registrations. */
function registrationsIn(source: string): Registration[] {
  const out: Registration[] = [];
  // Only `router.<verb>` / `app.<verb>` count: `c.get("ip")` inside a handler
  // must not become a phantom registration.
  for (const match of source.matchAll(/(?:router|app)\.(get|post|put|patch|delete|on)\(/g)) {
    const verb = match[1];
    const open = match.index! + match[0].length - 1;
    const args = splitTopLevel(source.slice(open + 1, findClose(source, open)));
    if (!args.length) continue;

    let methods: string[];
    let path: string;
    let rest: string[];
    if (verb === "on") {
      if (!args[0].startsWith("[") || !args[1]?.startsWith('"')) continue;
      methods = args[0]
        .slice(1, -1)
        .split(",")
        .map((m) => m.trim().replace(/^["']|["']$/g, "").toUpperCase())
        .filter(Boolean);
      path = args[1].slice(1, -1);
      rest = args.slice(2);
    } else {
      if (!args[0].startsWith('"')) continue;
      methods = [verb.toUpperCase()];
      path = args[0].slice(1, -1);
      rest = args.slice(1);
    }

    const targets = rest.flatMap((arg) =>
      [...arg.matchAll(/zValidator\(\s*"(\w+)"/g)].map((m) => m[1]),
    );
    for (const method of methods) out.push([method, path, targets.sort()]);
  }
  return out;
}

/** identifier -> module specifier, from the single-import lines in app.ts. */
function importsOf(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/import\s+(\w+)\s+from\s+"(\.\/[^"]+)"/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function modulePath(spec: string): string | null {
  const base = normalize(join(SRC, spec));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Full mount prefix per router identifier, from the two `.route(...)` chains. */
function mountPrefixes(app: string): Map<string, string> {
  const chain = (segment: string) =>
    [...segment.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)].map(
      (m) => [m[1], m[2]] as const,
    );
  const adminStart = app.indexOf("const adminRoutes");
  const routesStart = app.indexOf("const routes = app");
  const adminEntries = chain(app.slice(adminStart, routesStart));
  const topEntries = chain(app.slice(routesStart));

  const prefixes = new Map<string, string>();
  for (const [prefix, identifier] of adminEntries) {
    prefixes.set(identifier, `/admin${prefix}`);
  }
  for (const [prefix, identifier] of topEntries) {
    if (identifier === "adminRoutes") continue;
    prefixes.set(identifier, prefix);
  }
  return prefixes;
}

function replicaRegistrations(): Map<string, string[]> {
  const app = readFileSync(`${SRC}/app.ts`, "utf8");
  const imports = importsOf(app);
  const prefixes = mountPrefixes(app);
  const registrations = new Map<string, string[]>();

  for (const [identifier, prefix] of prefixes) {
    const specifier = imports.get(identifier);
    if (!specifier) throw new Error(`no import found for router ${identifier}`);
    const file = modulePath(specifier);
    if (!file) throw new Error(`no file found for router ${identifier} (${specifier})`);

    for (const [method, relativePath, targets] of registrationsIn(readFileSync(file, "utf8"))) {
      const joined = `${prefix}${relativePath}`.replace(/\/+/g, "/");
      const full = joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
      registrations.set(`${method} ${full}`, targets);
    }
  }
  return registrations;
}

const PRESENT = existsSync(API_MAP);

describe.skipIf(!PRESENT)("route validator parity", () => {
  const api = PRESENT
    ? (JSON.parse(readFileSync(API_MAP, "utf8")) as { routes: RouteRegistration[] }).routes
    : [];
  const replica = PRESENT ? replicaRegistrations() : new Map<string, string[]>();

  it("parses the whole mount tree", () => {
    // 31 router modules (16 admin + 15 public). The 160 upstream registrations
    // collapse to 157 distinct method+path keys because `/license` is mounted
    // twice; `router.on(["POST", "GET"], …)` contributes two keys of its own.
    expect(replicaRegistrations().size).toBe(157);
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
