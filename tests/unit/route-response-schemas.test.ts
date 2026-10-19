/**
 * Response-schema parity: the `content["application/json"].schema` of every
 * documented response.
 *
 * This is the last layer of the route contract — the body shape the panel
 * publishes in `/openapi.json`. It is compared with the expression the
 * decompiled registration uses, after normalising three known bundler artefacts:
 *
 *   - `exports_external.` is the bundle's alias for `z.`;
 *   - `i4(...)` / `resolver(...)` are the same wrapper;
 *   - a trailing `2` on a schema identifier (`TicketListResponseSchema2`) is a
 *     module-local duplicate-name suffix, the schema body is identical.
 *
 * `GET /bot` is compared verbatim: upstream publishes a raw JSON Schema object
 * there, and the replica now does the same.
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
  evidence: string;
}

/** The `schema: …` expression inside one registration's `responses` block. */
function upstreamSchema(evidence: string): string | null {
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
  const responsesAt = segment.search(/responses\s*:\s*\{/);
  if (responsesAt === -1) return null;
  const open = segment.indexOf("{", responsesAt);
  const close = findMatching(segment, open, "{", "}");
  const body = segment.slice(open + 1, close);
  const at = body.search(/schema\s*:/);
  if (at === -1) return null;
  for (let i = at; i < body.length; i++) {
    if (body[i] === "(") return body.slice(i + 1, findMatching(body, i, "(", ")")).trim();
    if (body[i] === "{") return body.slice(i, findMatching(body, i, "{", "}") + 1);
    if (body[i] === ",") break;
  }
  return null;
}

/** Compare expressions modulo bundler aliases, whitespace and trailing commas. */
function normalize(expression: string | null): string | null {
  if (expression === null) return null;
  let value = expression.replace(/\s+/g, "").replace(/,$/, "");
  value = value.replace(/exports_external\./g, "z.");
  for (const wrapper of ["resolver", "i4", "r2", "h2"]) {
    if (value.startsWith(`${wrapper}(`) && value.endsWith(")")) {
      value = value.slice(wrapper.length + 1, -1);
    }
  }
  value = value.replace(/,\)/g, ")").replace(/,}/g, "}").replace(/,$/, "");
  value = value.replace(/(Schema)2\b/g, "$1");
  return value;
}

const PRESENT = existsSync(API_MAP);

describe.skipIf(!PRESENT)("route response-schema parity", () => {
  const api = PRESENT
    ? (JSON.parse(readFileSync(API_MAP, "utf8")) as { routes: RouteRegistration[] }).routes
    : [];
  const docs = PRESENT ? replicaDocumentation() : new Map();

  const pairs = api.map((route) => ({
    route: `${route.method} ${route.path}`,
    upstream: normalize(upstreamSchema(route.evidence)),
    replica: normalize(
      docs.get(`${route.method} ${route.path}`)!.responses.find((entry) => entry.schema)?.schema ?? null,
    ),
  }));

  it("covers the same 64 routes", () => {
    expect(pairs.filter((pair) => pair.upstream !== null)).toHaveLength(64);
    expect(pairs.filter((pair) => pair.replica !== null)).toHaveLength(64);
  });

  it("declares the same schema for every route", () => {
    const differences = pairs.filter((pair) => pair.upstream !== pair.replica);
    expect(differences).toEqual([]);
  });

  it("keeps the raw JSON Schema for /bot", () => {
    const bot = pairs.find((pair) => pair.route === "GET /bot")!;
    expect(bot.replica).toContain('type:"object"');
    expect(bot.replica).toContain("username");
  });
});
