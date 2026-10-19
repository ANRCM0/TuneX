/**
 * Text-level parsers for the backend's Hono wiring.
 *
 * Shared by `tests/unit/route-guards.test.ts`, `route-validators.test.ts` and
 * `route-table.test.ts` so the three parity checks agree on how a route is
 * declared. Nothing here imports the backend (no Prisma, no env), so the
 * suites stay hermetic.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const SRC = `${REPO}apps/backend/src`;
export const ANALYSIS = fileURLToPath(new URL("../../../relayx-analysis/", import.meta.url));
export const API_MAP = `${ANALYSIS}work/api_map.json`;

export type Registration = [method: string, path: string, targets: string[]];

/** What `describeRoute({...})` declares for one registration. */
export interface DocResponse {
  code: number;
  description: string;
}

export interface DocInfo {
  hasDescribeRoute: boolean;
  summary: string | null;
  statusCodes: number[];
  responses: DocResponse[];
}

/** Split an argument list on top-level commas. */
export function splitTopLevel(args: string): string[] {
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

/** Index of the bracket that closes the one at `open` (same kind). */
export function findMatching(source: string, open: number, openChar = "(", closeChar = ")"): number {
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
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${openChar} at offset ${open}`);
}

/** Index of the `)` that closes the `(` at `open`. */
export function findClose(source: string, open: number): number {
  return findMatching(source, open, "(", ")");
}

/** Top-level three-digit keys of the `responses: { … }` object in a describeRoute arg. */
function statusCodesOf(describeArg: string): number[] {
  const responsesAt = describeArg.indexOf("responses");
  if (responsesAt === -1) return [];
  const open = describeArg.indexOf("{", responsesAt);
  if (open === -1) return [];
  const close = findMatching(describeArg, open, "{", "}");
  const body = describeArg.slice(open + 1, close);
  const codes: number[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (depth === 0 && /\d/.test(ch)) {
      const match = /^(\d{3})\s*:/.exec(body.slice(i));
      if (match) {
        codes.push(Number(match[1]));
        i += match[0].length - 1;
      }
    }
  }
  return codes;
}

export interface ParsedRegistration {
  method: string;
  path: string;
  targets: string[];
  docs: DocInfo;
}

function responsesOf(describeArg: string): DocResponse[] {
  const responsesAt = describeArg.indexOf("responses");
  if (responsesAt === -1) return [];
  const open = describeArg.indexOf("{", responsesAt);
  if (open === -1) return [];
  const close = findMatching(describeArg, open, "{", "}");
  const body = describeArg.slice(open + 1, close);
  const out: DocResponse[] = [];
  for (const match of body.matchAll(/"?([0-9]{3})"?\s*:\s*\{\s*description:\s*"((?:[^"\\]|\\.)*)"/g)) {
    out.push({ code: Number(match[1]), description: match[2] });
  }
  return out;
}

function docsIn(rest: string[]): DocInfo {
  const arg = rest.find((candidate) => candidate.startsWith("describeRoute("));
  if (!arg) return { hasDescribeRoute: false, summary: null, statusCodes: [], responses: [] };
  const summary = /summary:\s*"([^"]*)"/.exec(arg)?.[1] ?? null;
  return {
    hasDescribeRoute: true,
    summary,
    statusCodes: statusCodesOf(arg),
    responses: responsesOf(arg),
  };
}

/**
 * `router.<verb>(path, …)` and `router.on([verbs], path, …)` registrations.
 *
 * Only `router.*` / `app.*` are treated as registrations: `c.get("ip")` inside a
 * handler must not become a phantom route.
 */
export function registrationsWithDocs(source: string): ParsedRegistration[] {
  const out: ParsedRegistration[] = [];
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
    const docs = docsIn(rest);
    for (const method of methods) out.push({ method, path, targets: targets.sort(), docs });
  }
  return out;
}

/** Backwards-compatible projection used by the validator/tables suites. */
export function registrationsIn(source: string): Registration[] {
  return registrationsWithDocs(source).map(({ method, path, targets }) => [method, path, targets]);
}

/** identifier -> module specifier, from the single-import lines in app.ts. */
export function importsOf(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/import\s+(\w+)\s+from\s+"(\.\/[^"]+)"/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

export function modulePath(spec: string): string | null {
  const base = normalize(join(SRC, spec));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Full mount prefix per router identifier, from the two `.route(...)` chains. */
export function mountPrefixes(app: string): Map<string, string> {
  const chain = (segment: string) =>
    [...segment.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)].map(
      (m) => [m[1], m[2]] as const,
    );
  const adminStart = app.indexOf("const adminRoutes");
  const routesStart = app.indexOf("const routes = app");
  const adminEntries = chain(app.slice(adminStart, routesStart));
  const topEntries = chain(app.slice(routesStart));

  const prefixes = new Map<string, string>();
  // `/queuedash` and `/health` are mounted before the `routes` chain; they are
  // the only `app.route(...)` calls written with an explicit `app.` receiver,
  // because the later mounts are chained (`.route(...)`) off that call.
  for (const match of app.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)) {
    if (match[2] !== "adminRoutes") prefixes.set(match[2], match[1]);
  }
  for (const [prefix, identifier] of adminEntries) {
    prefixes.set(identifier, `/admin${prefix}`);
  }
  for (const [prefix, identifier] of topEntries) {
    if (identifier === "adminRoutes") continue;
    prefixes.set(identifier, prefix);
  }
  return prefixes;
}

/** Walk every registration mounted from a router module. */
function walkRegistrations(visit: (key: string, registration: ParsedRegistration) => void): void {
  const app = readFileSync(`${SRC}/app.ts`, "utf8");
  const imports = importsOf(app);
  const prefixes = mountPrefixes(app);

  for (const [identifier, prefix] of prefixes) {
    const specifier = imports.get(identifier);
    if (!specifier) throw new Error(`no import found for router ${identifier}`);
    const file = modulePath(specifier);
    if (!file) throw new Error(`no file found for router ${identifier} (${specifier})`);

    for (const registration of registrationsWithDocs(readFileSync(file, "utf8"))) {
      const joined = `${prefix}${registration.path}`.replace(/\/+/g, "/");
      const full = joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
      visit(`${registration.method} ${full}`, registration);
    }
  }
}

/** Every registration mounted from a router module, keyed `METHOD /path`. */
export function replicaRegistrations(): Map<string, string[]> {
  const registrations = new Map<string, string[]>();
  walkRegistrations((key, registration) => registrations.set(key, registration.targets));
  return registrations;
}

/** `describeRoute` metadata per mounted registration, keyed `METHOD /path`. */
export function replicaDocumentation(): Map<string, DocInfo> {
  const docs = new Map<string, DocInfo>();
  walkRegistrations((key, registration) => docs.set(key, registration.docs));
  return docs;
}

/** Route registrations declared directly on `app` in `app.ts` (`/docs`, `/openapi.json`). */
export function appLevelRegistrations(): Map<string, string[]> {
  const app = readFileSync(`${SRC}/app.ts`, "utf8");
  const registrations = new Map<string, string[]>();
  for (const [method, path, targets] of registrationsIn(app)) {
    registrations.set(`${method} ${path}`, targets);
  }
  return registrations;
}
