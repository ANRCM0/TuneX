/**
 * Replica-local authentication (`AUTH_MODE=local`).
 *
 * Upstream delegates passwords and sessions to StackAuth; this suite pins the drop-in
 * replacement so the panel can be exercised without that hosted service:
 *
 *   - scrypt hashes verify and reject, and the encoding is self-describing;
 *   - tokens are HS256 with `sub` = local user id, and the pair round-trips through the
 *     upstream cookie shape `["<refresh>", "<access>"]`;
 *   - `/auth/sign-up` makes the first registrant super admin, honours ALLOW_REGISTER,
 *     rejects duplicates, and sets the same cookie names the middleware reads;
 *   - `/auth/sign-in` rejects a wrong password and an inactive user;
 *   - `/auth/me` is protected, and a session cookie authenticates a normal API call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { Hono } from "hono";
import type { PrismaClient } from "../../apps/backend/src/db";

const temp: TempDatabase = createTempDatabase("local-auth");
process.env.DATABASE_URL = temp.url;
process.env.AUTH_MODE = "local";

let db: PrismaClient;
let app: Hono;
let hashPassword: (p: string) => Promise<string>;
let verifyPassword: (p: string, h: string) => Promise<boolean>;
let issueTokens: (id: number) => Promise<{ accessToken: string; refreshToken: string }>;
let verifyToken: (t: string, kind?: "access" | "refresh") => Promise<{ sub: string } | null>;
let parseTokenCookie: (v: string | undefined) => { accessToken: string; refreshToken: string } | null;
let tokenCookieValue: (p: { accessToken: string; refreshToken: string }) => string;

const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } }, outgoing: {} };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
    env,
  );
}

/**
 * Collect the cookies from a response.
 *
 * `Headers.get("set-cookie")` joins every Set-Cookie with ", " — and the access cookie's
 * value is a JSON array, which contains commas itself. `getSetCookie()` keeps them apart.
 */
function cookieHeader(res: Response): string {
  const list = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return list
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair) => pair && !pair.endsWith("="))
    .join("; ");
}

beforeAll(async () => {
  const localAuth = await import("../../apps/backend/src/services/local_auth");
  hashPassword = localAuth.hashPassword;
  verifyPassword = localAuth.verifyPassword;
  issueTokens = localAuth.issueTokens;
  verifyToken = localAuth.verifyToken;
  parseTokenCookie = localAuth.parseTokenCookie;
  tokenCookieValue = localAuth.tokenCookieValue;

  db = (await import("../../apps/backend/src/db")).db;
  const mod = await import("../../apps/backend/src/app");
  app = mod.default;
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
  temp.cleanup();
});

describe("password hashing", () => {
  it("round-trips and rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
  });
});

describe("tokens", () => {
  it("signs access/refresh tokens with the local subject", async () => {
    const pair = await issueTokens(42);
    expect((await verifyToken(pair.accessToken, "access"))?.sub).toBe("42");
    expect(await verifyToken(pair.accessToken, "refresh")).toBeNull();
    expect((await verifyToken(pair.refreshToken, "refresh"))?.sub).toBe("42");
  });

  it("uses the upstream cookie shape", async () => {
    const pair = await issueTokens(7);
    const cookie = tokenCookieValue(pair);
    expect(JSON.parse(cookie)).toEqual([pair.refreshToken, pair.accessToken]);
    expect(parseTokenCookie(cookie)?.accessToken).toBe(pair.accessToken);
    expect(parseTokenCookie("not-json")).toBeNull();
  });
});

describe("sign-up / sign-in", () => {
  it("promotes the first registrant to super admin and sets both cookies", async () => {
    const res = await post("/auth/sign-up", { email: "First@Example.com", password: "supersecret" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: number; super_admin: boolean; email: string } };
    expect(body.user.super_admin).toBe(true);
    expect(body.user.email).toBe("first@example.com");
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("stack-access=");
    expect(cookies).toContain("stack-refresh=");
  });

  it("rejects a duplicate email", async () => {
    const res = await post("/auth/sign-up", { email: "first@example.com", password: "another-one" });
    expect(res.status).toBe(409);
  });

  it("makes later registrants plain users", async () => {
    const res = await post("/auth/sign-up", { email: "second@example.com", password: "supersecret" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { super_admin: boolean } };
    expect(body.user.super_admin).toBe(false);
  });

  it("signs in with a session cookie and authenticates a protected call", async () => {
    const res = await post("/auth/sign-in", { email: "first@example.com", password: "supersecret" });
    expect(res.status).toBe(200);
    const cookie = cookieHeader(res);
    const me = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(me.status).toBe(200);
    const info = await app.request("/user/info", { headers: { cookie } }, env);
    expect(info.status).toBe(200);
  });

  it("rejects a wrong password and an unknown address", async () => {
    expect((await post("/auth/sign-in", { email: "first@example.com", password: "nope-nope" })).status).toBe(401);
    expect((await post("/auth/sign-in", { email: "ghost@example.com", password: "supersecret" })).status).toBe(401);
  });

  it("refuses an inactive account", async () => {
    await db.user.update({ where: { email: "second@example.com" }, data: { status: "inactive" } });
    const res = await post("/auth/sign-in", { email: "second@example.com", password: "supersecret" });
    expect(res.status).toBe(403);
  });

  it("honours ALLOW_REGISTER=false", async () => {
    await db.systemConfig.upsert({
      where: { name: "ALLOW_REGISTER" },
      update: { value: "false" },
      create: { name: "ALLOW_REGISTER", value: "false" },
    });
    const res = await post("/auth/sign-up", { email: "third@example.com", password: "supersecret" });
    expect(res.status).toBe(403);
    await db.systemConfig.update({ where: { name: "ALLOW_REGISTER" }, data: { value: "true" } });
  });
});

describe("session guard", () => {
  it("rejects /auth/me without a cookie", async () => {
    expect((await app.request("/auth/me", {}, env)).status).toBe(401);
  });

  it("rejects a tampered access token", async () => {
    const res = await post("/auth/sign-in", { email: "first@example.com", password: "supersecret" });
    const cookie = cookieHeader(res).replace(
      /stack-access=[^;]+/,
      `stack-access=${JSON.stringify(["x", "bad.token.here"])}`,
    );
    expect((await app.request("/auth/me", { headers: { cookie } }, env)).status).toBe(401);
  });

  it("clears the cookies on sign-out", async () => {
    const res = await post("/auth/sign-out", {});
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toContain("stack-access=;");
  });
});
