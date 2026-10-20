/**
 * Hono-RPC-style client, reconstructed from the shipped bundle
 * (relayx-web/work/all_modules/0nux8wznlx72k__194108.js, module 194108).
 *
 * Behaviour mirrored from upstream:
 *  - property access accumulates path segments; "then" is excluded so `await client` is safe
 *  - the LAST segment decides the verb: $get/$post/$put/$patch/$delete, plus $url
 *  - query: URLSearchParams; arrays repeat the key; undefined is skipped; null becomes "null"
 *  - param: `/:name` is replaced (upstream regex has no /g, so only the first occurrence)
 *  - base path is "/api"
 *  - one shared fetch wrapper: x-impersonation, 401 -> /handler/sign-out,
 *    403 + EMAIL_NOT_VERIFIED -> /verify-email, other !ok -> toast
 *
 * DEVIATION (deliberate): the upstream wrapper calls `res.clone().json()` unguarded,
 * so a non-JSON error body (e.g. a 502 HTML from the proxy) throws and the toast is
 * silently lost. We guard it here — see reports/13-frontend-build.md.
 */
import { toast } from "sonner";

export const IMPERSONATION_STORAGE_KEY = "impersonation";
const BASE_PATH = "/api";

type Verb = "get" | "post" | "put" | "patch" | "delete";
type Args = [
  opts?: {
    query?: Record<string, unknown>;
    param?: Record<string, string | number>;
    json?: unknown;
    header?: Record<string, string>;
  },
  extra?: { fetch?: typeof fetch; init?: RequestInit; headers?: Record<string, string> },
];

function serializeQuery(query: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, String(item));
    else sp.set(k, String(v));
  }
  return sp.toString();
}

function applyParams(path: string, params: Record<string, string | number>): string {
  let out = path;
  for (const [k, v] of Object.entries(params)) {
    // upstream: falsy values REMOVE the segment rather than leaving it empty
    out = out.replace(new RegExp(`/:${k}(?:{[^/]+})?\\??`), v ? `/${v}` : "");
  }
  return out;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const impersonation =
    typeof window !== "undefined" ? window.sessionStorage.getItem(IMPERSONATION_STORAGE_KEY) : null;

  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
      ...(impersonation ? { "x-impersonation": impersonation } : {}),
    },
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/handler/sign-out";
    return res;
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      body = { error: `HTTP ${res.status}` };
    }
    const payload = body as { error?: unknown; code?: string };
    if (res.status === 403 && payload?.code === "EMAIL_NOT_VERIFIED") {
      if (typeof window !== "undefined") window.location.href = "/verify-email";
      return res;
    }
    toast.error(typeof payload?.error === "string" ? payload.error : JSON.stringify(body));
  }

  return res;
}

async function dispatch(path: string[], args: Args): Promise<Response> {
  const [opts, extra] = args;
  const segments = [...path];
  let verb: string | null = null;
  const tail = segments[segments.length - 1] ?? "";
  if (tail.startsWith("$")) {
    segments.pop();
    verb = tail.slice(1);
  }

  const url = BASE_PATH + "/" + segments.join("/");
  const params = opts?.param ?? {};
  let finalUrl = applyParams(url, params);
  if (opts?.query) {
    const qs = serializeQuery(opts.query);
    if (qs) finalUrl += `?${qs}`;
  }

  if (verb === "url") {
    return new Response(
      JSON.stringify({
        url: new URL(
          finalUrl,
          typeof window === "undefined" ? "http://localhost" : window.location.origin,
        ).toString(),
      }),
    );
  }
  if (!verb) return new Response(null, { status: 204 }); // lazy handle, no request

  const method = verb.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return apiFetch(finalUrl, {
    method,
    body: hasBody && opts?.json !== undefined ? JSON.stringify(opts.json) : undefined,
    ...(extra?.init ?? {}),
  });
}

export type RpcProxy = { [key: string]: RpcProxy } & ((...args: Args) => Promise<Response>);

function createProxy(path: string[]): RpcProxy {
  const fn = ((...args: Args) => dispatch(path, args)) as unknown as RpcProxy;
  return new Proxy(fn, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;
      return createProxy([...path, key]);
    },
  });
}

export const client = createProxy([]);
export const adminClient = client.admin as RpcProxy;
