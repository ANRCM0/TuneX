/**
 * API-documentation parity: `describeRoute` presence, operation summary and
 * documented response status codes, per registration.
 *
 * The decompile records all three (`openapiDoc`, `operationSummary`,
 * `documentedStatusCodes`) in `api_map.json`. This suite parses the same data out
 * of the replica's `describeRoute({...})` blocks and compares.
 *
 * Why it matters: the status keys are the OpenAPI contract the panel's own
 * `/openapi.json` publishes, so a wrong key (200 where the handler returns 204)
 * is a visible client-facing difference even when the handler is correct.
 *
 * Skips when the analysis tree is not a sibling of the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS, API_MAP, findMatching, replicaDocumentation } from "../helpers/route-parse";

interface RouteRegistration {
  method: string;
  path: string;
  openapiDoc: boolean;
  operationSummary: string | null;
  documentedStatusCodes: number[] | null;
  evidence: string;
}

/** Decode the `\uXXXX` escapes the decompiled bundle uses for Chinese strings. */
function decodeEscapes(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** Response entries of one upstream registration, read from `evidence` (`module:line`). */
function upstreamResponses(evidence: string): { code: number; description: string }[] {
  const [modulePath, rawLine] = evidence.split(":");
  const lines = readFileSync(join(ANALYSIS, modulePath), "utf8").split("\n");
  const start = Number(rawLine) - 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}\)/.test(lines[i])) {
      end = i + 1;
      break;
    }
  }
  const segment = lines.slice(start, end).join("\n");
  const responsesAt = segment.search(/responses:\s*\{/);
  if (responsesAt === -1) return [];
  const open = segment.indexOf("{", responsesAt);
  const close = findMatching(segment, open, "{", "}");
  const body = segment.slice(open + 1, close);
  const out: { code: number; description: string }[] = [];
  for (const match of body.matchAll(/"?([0-9]{3})"?\s*:\s*\{\s*description:\s*"((?:[^"\\]|\\.)*)"/g)) {
    out.push({ code: Number(match[1]), description: decodeEscapes(match[2]) });
  }
  return out;
}

const PRESENT = existsSync(API_MAP);

describe.skipIf(!PRESENT)("route documentation parity", () => {
  const api = PRESENT
    ? (JSON.parse(readFileSync(API_MAP, "utf8")) as { routes: RouteRegistration[] }).routes
    : [];
  const docs = PRESENT ? replicaDocumentation() : new Map();

  it("documents the same routes", () => {
    const missing = api.map((route) => `${route.method} ${route.path}`).filter((key) => !docs.has(key));
    expect(missing).toEqual([]);
    expect(api.filter((route) => route.openapiDoc)).toHaveLength(158);
  });

  it("declares describeRoute exactly where upstream does", () => {
    const differences = api
      .map((route) => ({
        route: `${route.method} ${route.path}`,
        upstream: route.openapiDoc,
        replica: docs.get(`${route.method} ${route.path}`)!.hasDescribeRoute,
      }))
      .filter((row) => row.upstream !== row.replica);
    expect(differences).toEqual([]);
  });

  it("uses the upstream operation summaries", () => {
    const differences = api
      .map((route) => ({
        route: `${route.method} ${route.path}`,
        upstream: route.operationSummary,
        replica: docs.get(`${route.method} ${route.path}`)!.summary,
      }))
      .filter((row) => row.upstream !== null && row.upstream !== row.replica);
    expect(differences).toEqual([]);
  });

  it("documents the upstream response status codes", () => {
    const differences = api
      .map((route) => {
        const expected = [...(route.documentedStatusCodes ?? [])].sort((a, b) => a - b);
        const observed = [...docs.get(`${route.method} ${route.path}`)!.statusCodes].sort((a, b) => a - b);
        return { route: `${route.method} ${route.path}`, expected, observed };
      })
      .filter((row) => row.expected.join(",") !== row.observed.join(","));
    expect(differences).toEqual([]);
  });

  it("uses the upstream response descriptions", () => {
    const differences = api
      .map((route) => {
        const expected = upstreamResponses(route.evidence).sort((a, b) => a.code - b.code);
        const observed = [...docs.get(`${route.method} ${route.path}`)!.responses]
          .map(({ code, description }) => ({ code, description }))
          .sort((a, b) => a.code - b.code);
        return { route: `${route.method} ${route.path}`, expected, observed };
      })
      .filter((row) => JSON.stringify(row.expected) !== JSON.stringify(row.observed));
    expect(differences).toEqual([]);
  });

  it("matches the upstream status-code distribution", () => {
    const counts = new Map<string, number>();
    for (const route of api) {
      const key = [...(route.documentedStatusCodes ?? [])].sort((a, b) => a - b).join(",");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      "": 5,
      "200": 75,
      "201": 7,
      "204": 70,
      "204,400": 1,
      "204,404": 2,
    });
  });
});
