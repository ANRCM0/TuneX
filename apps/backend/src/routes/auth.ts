/**
 * Local authentication routes (`AUTH_MODE=local`).
 *
 * The endpoint names mirror the StackAuth handler paths the panel redirects to, so the
 * web app keeps one contract: /handler/sign-in → POST /auth/sign-in, and so on.
 *
 * Recovered panel semantics that are preserved:
 *   - the first registrant becomes super admin (`resolveCookieUser` in the decompile);
 *   - `ALLOW_REGISTER=false` rejects sign-up with 「当前站点不允许注册」;
 *   - an `inactive` user cannot sign in (「用户账户已被封禁」);
 *   - a `ref` cookie records the referrer as `parent_id` on first provision.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SystemConfigName } from "@prisma/client";
import { AUTH_MODE } from "../config";
import { db } from "../db";
import { instance, TOKENS } from "../container";
import type { RedisService } from "../services/redis";
import type { SystemConfigService } from "../services/system_config";
import {
  AUTH_COOKIE,
  AUTH_IS_HTTPS_COOKIE,
  AUTH_REFRESH_COOKIE,
  authCookies,
  hashPassword,
  issueTokens,
  parseTokenCookie,
  verifyPassword,
  verifyToken,
} from "../services/local_auth";
import type { AppEnv, SessionUser } from "../types";

const systemConfigService = () => instance.resolve<SystemConfigService>(TOKENS.SystemConfig);
const redisService = () => instance.resolve<RedisService>(TOKENS.Redis);

const app = new Hono<AppEnv>();

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const normalizeEmail = (email: string) => email.trim().toLowerCase();

function assertLocalMode(): void {
  if (AUTH_MODE !== "local") {
    throw new HTTPException(404, { message: "本地认证未启用" });
  }
}

/**
 * Set both cookies under the upstream names.
 *
 * The access cookie holds the JSON array `[refresh, access]`. It is percent-encoded by
 * `setCookie`: Hono's own cookie parser (and therefore the middleware) returns `null` for
 * a raw value containing quotes, so the encoded form is the one that round-trips. The
 * middleware decodes before `JSON.parse`. Deviation from upstream's raw-JSON cookie, see
 * docs/DEVIATIONS.md §30.
 */
function setSessionCookies(c: Parameters<typeof setCookie>[0], pair: Awaited<ReturnType<typeof issueTokens>>) {
  for (const cookie of authCookies(pair)) {
    setCookie(c, cookie.name, cookie.value, {
      path: "/",
      maxAge: cookie.maxAge,
      sameSite: "Lax",
      httpOnly: false,
    });
  }
  setCookie(c, AUTH_IS_HTTPS_COOKIE, "false", { path: "/", maxAge: 86400, sameSite: "Lax" });
}

function clearSessionCookies(c: Parameters<typeof deleteCookie>[0]) {
  for (const name of [AUTH_COOKIE, AUTH_REFRESH_COOKIE, AUTH_IS_HTTPS_COOKIE]) {
    deleteCookie(c, name, { path: "/" });
  }
}

/** Public shape returned to the browser; matches what the panel reads from /user/info. */
function publicUser(user: SessionUser & { credential?: { email_verified: boolean } | null }) {
  return {
    id: user.id,
    email: user.email,
    super_admin: user.super_admin,
    status: user.status,
    api_key: user.api_key,
    subscription_key: user.subscription_key,
    email_verified: user.credential?.email_verified ?? false,
  };
}

/** `ref` cookie → parent_id, but only when this login provisions a new user. */
async function referralParentId(c: Parameters<typeof getCookie>[0]): Promise<number | undefined> {
  const refRaw = getCookie(c, "ref");
  if (!refRaw) return undefined;
  const refId = Number.parseInt(refRaw, 10);
  if (Number.isNaN(refId)) return undefined;
  const parent = await db.user.findUnique({ where: { id: refId } });
  return parent?.id;
}

app.post("/sign-up", zValidator("json", Credentials), async (c) => {
  assertLocalMode();
  const { email, password } = c.req.valid("json");
  const normalized = normalizeEmail(email);

  const allowRegister = await systemConfigService().getConfig(SystemConfigName.ALLOW_REGISTER);
  if (!allowRegister) {
    throw new HTTPException(403, { message: "当前站点不允许注册" });
  }

  const existing = await db.user.findUnique({ where: { email: normalized }, include: { admin_roles: true } });
  if (existing) {
    throw new HTTPException(409, { message: "该邮箱已注册" });
  }

  const superAdmin = await db.user.findFirst({ where: { super_admin: true } });
  const parentId = await referralParentId(c);
  const user = await db.user.create({
    data: {
      email: normalized,
      super_admin: superAdmin ? false : true,
      parent_id: parentId,
      credential: { create: { password_hash: await hashPassword(password), email_verified: false } },
    },
    include: { admin_roles: true, credential: true },
  });

  const pair = await issueTokens(user.id);
  setSessionCookies(c, pair);
  return c.json({ user: publicUser(user) }, 201);
});

app.post("/sign-in", zValidator("json", Credentials), async (c) => {
  assertLocalMode();
  const { email, password } = c.req.valid("json");
  const normalized = normalizeEmail(email);

  const user = await db.user.findUnique({
    where: { email: normalized },
    include: { admin_roles: true, credential: true },
  });
  if (!user?.credential || !(await verifyPassword(password, user.credential.password_hash))) {
    throw new HTTPException(401, { message: "邮箱或密码不正确" });
  }
  if (user.status === "inactive") {
    throw new HTTPException(403, { message: "用户账户已被封禁" });
  }

  const pair = await issueTokens(user.id);
  setSessionCookies(c, pair);
  await redisService().setUserSub(String(user.id), user.id);
  return c.json({ user: publicUser(user) });
});

app.post("/sign-out", (c) => {
  clearSessionCookies(c);
  return c.body(null, 204);
});

/** Rotate the access token from the refresh cookie (the panel's silent refresh). */
app.post("/refresh", async (c) => {
  assertLocalMode();
  const pair = parseTokenCookie(getCookie(c, AUTH_COOKIE));
  const fromCookie = pair?.refreshToken ?? getCookie(c, AUTH_REFRESH_COOKIE);
  if (!fromCookie) throw new HTTPException(401, { message: "Unauthorized" });
  const verified = await verifyToken(fromCookie, "refresh");
  if (!verified) throw new HTTPException(401, { message: "Unauthorized" });
  const user = await db.user.findUnique({
    where: { id: Number(verified.sub) },
    include: { admin_roles: true, credential: true },
  });
  if (!user || user.status === "inactive") throw new HTTPException(401, { message: "Unauthorized" });
  const next = await issueTokens(user.id);
  setSessionCookies(c, next);
  return c.json({ user: publicUser(user) });
});

/** Current session. Mounted behind `authRequired`, so `c.get("user")` is populated. */
app.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  const credential = await db.localCredential.findUnique({ where: { user_id: user.id } });
  return c.json({ user: { ...publicUser(user as SessionUser & { credential?: null }), email_verified: credential?.email_verified ?? true } });
});

/**
 * Mark the address verified.
 *
 * StackAuth sends a signed link; the local mode has no mail transport, so the flag is set
 * directly for the signed-in user (documented deviation §30).
 */
app.post("/verify-email", async (c) => {
  assertLocalMode();
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  await db.localCredential.update({
    where: { user_id: user.id },
    data: { email_verified: true },
  });
  return c.json({ ok: true });
});

export default app;
