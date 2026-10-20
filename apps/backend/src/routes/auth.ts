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
import {
  AUTH_MODE,
  AUTH_VERIFY_MODE,
  AUTH_VERIFY_RESEND_SECONDS,
  AUTH_VERIFY_TTL_SECONDS,
  SITE_URL,
} from "../config";
import { db } from "../db";
import { instance, TOKENS } from "../container";
import type { RedisService } from "../services/redis";
import type { SystemConfigService } from "../services/system_config";
import {
  AUTH_COOKIE,
  AUTH_IS_HTTPS_COOKIE,
  AUTH_REFRESH_COOKIE,
  authCookies,
  createEmailToken,
  emailTokenMatches,
  hashPassword,
  issueTokens,
  parseTokenCookie,
  verifyPassword,
  verifyToken,
} from "../services/local_auth";
import type { AppEnv, SessionUser } from "../types";
import { clearFailures, isLocked, LOGIN_MAX_FAILURES, recordFailure } from "../middlewares/rate_limit";

const systemConfigService = () => instance.resolve<SystemConfigService>(TOKENS.SystemConfig);
const mailService = () =>
  instance.resolve<{
    sendEmail: (to: string, subject: string, text: string, html?: string) => Promise<boolean>;
  }>(TOKENS.Mail);
const redisService = () => instance.resolve<RedisService>(TOKENS.Redis);

const app = new Hono<AppEnv>();

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const normalizeEmail = (email: string) => email.trim().toLowerCase();
/** Lock duration in seconds; mirrors `middlewares/rate_limit.ts`. */
const LOGIN_LOCK_SECONDS_DEFAULT = Number.parseInt(process.env.LOGIN_LOCK_SECONDS || "900", 10);

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
function setSessionCookies(
  c: Parameters<typeof setCookie>[0],
  pair: Awaited<ReturnType<typeof issueTokens>>,
) {
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

  // Account lockout is keyed on the submitted address, so it holds across source IPs.
  const lock = isLocked(normalized);
  if (lock.locked) {
    c.header("Retry-After", String(lock.retryAfter));
    throw new HTTPException(429, {
      message: `尝试次数过多，请 ${Math.ceil(lock.retryAfter / 60)} 分钟后再试`,
    });
  }

  const user = await db.user.findUnique({
    where: { email: normalized },
    include: { admin_roles: true, credential: true },
  });
  if (!user?.credential || !(await verifyPassword(password, user.credential.password_hash))) {
    const result = recordFailure(normalized);
    if (result.locked) {
      c.header("Retry-After", String(LOGIN_LOCK_SECONDS_DEFAULT));
      throw new HTTPException(429, {
        message: `连续 ${LOGIN_MAX_FAILURES} 次失败，账户已锁定 ${Math.ceil(LOGIN_LOCK_SECONDS_DEFAULT / 60)} 分钟`,
      });
    }
    throw new HTTPException(401, { message: "邮箱或密码不正确" });
  }
  if (user.status === "inactive") {
    throw new HTTPException(403, { message: "用户账户已被封禁" });
  }

  clearFailures(normalized);
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
  return c.json({
    user: {
      ...publicUser(user as SessionUser & { credential?: null }),
      email_verified: credential?.email_verified ?? true,
    },
  });
});

/**
 * Send (or resend) the verification mail.
 *
 * Only meaningful in `email` mode with a configured provider. The response never leaks the
 * token in that mode; when no provider is configured the endpoint falls back to returning it
 * so a fresh checkout stays usable (`AUTH_VERIFY_MODE=direct` semantics).
 */
app.post("/verify-email/request", async (c) => {
  assertLocalMode();
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });

  const credential = await db.localCredential.findUnique({ where: { user_id: user.id } });
  if (!credential) throw new HTTPException(400, { message: "该账户不支持邮箱验证" });
  if (credential.email_verified) return c.json({ ok: true, alreadyVerified: true });

  const now = Date.now();
  if (
    credential.verification_sent_at &&
    now - credential.verification_sent_at.getTime() < AUTH_VERIFY_RESEND_SECONDS * 1000
  ) {
    throw new HTTPException(429, { message: "发送过于频繁，请稍后再试" });
  }

  const { token, hash } = createEmailToken();
  const expiresAt = new Date(now + AUTH_VERIFY_TTL_SECONDS * 1000);
  await db.localCredential.update({
    where: { user_id: user.id },
    data: {
      verification_token_hash: hash,
      verification_token_expires_at: expiresAt,
      verification_sent_at: new Date(now),
    },
  });

  const link = `${SITE_URL}/handler/verify-email?token=${encodeURIComponent(token)}`;
  const sent =
    AUTH_VERIFY_MODE === "email"
      ? await mailService().sendEmail(
          user.email,
          "验证你的 RelayX 邮箱",
          `点击链接完成邮箱验证（${Math.round(AUTH_VERIFY_TTL_SECONDS / 3600)} 小时内有效）：${link}`,
          `<p>点击下面的链接完成邮箱验证（${Math.round(AUTH_VERIFY_TTL_SECONDS / 3600)} 小时内有效）：</p><p><a href="${link}">${link}</a></p>`,
        )
      : false;

  if (sent) return c.json({ ok: true, sent: true, expiresAt: expiresAt.toISOString() });

  // No transport (or direct mode): hand the token back so the caller can finish the flow.
  return c.json({
    ok: true,
    sent: false,
    token,
    link,
    expiresAt: expiresAt.toISOString(),
    hint: "未配置邮件服务：已直接返回验证链接（AUTH_VERIFY_MODE=direct）",
  });
});

/**
 * Complete the verification.
 *
 * With `{token}` the mailed link is honoured (hash + expiry). Without a token the call is
 * the direct-mode shortcut, allowed only when no mail transport is configured — otherwise a
 * caller could skip ownership proof by simply omitting the token.
 */
app.post(
  "/verify-email",
  zValidator("json", z.object({ token: z.string().min(16).max(128).optional() }).partial()),
  async (c) => {
    assertLocalMode();
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "Unauthorized" });

    const credential = await db.localCredential.findUnique({ where: { user_id: user.id } });
    if (!credential) throw new HTTPException(400, { message: "该账户不支持邮箱验证" });
    if (credential.email_verified) return c.json({ ok: true, alreadyVerified: true });

    const { token } = c.req.valid("json");

    if (token) {
      const expired =
        credential.verification_token_expires_at !== null &&
        credential.verification_token_expires_at.getTime() < Date.now();
      if (expired || !emailTokenMatches(token, credential.verification_token_hash)) {
        throw new HTTPException(400, { message: "验证链接无效或已过期" });
      }
      await db.localCredential.update({
        where: { user_id: user.id },
        data: {
          email_verified: true,
          verification_token_hash: null,
          verification_token_expires_at: null,
        },
      });
      return c.json({ ok: true });
    }

    if (AUTH_VERIFY_MODE !== "direct") {
      throw new HTTPException(400, { message: "请使用邮件中的链接验证" });
    }
    await db.localCredential.update({
      where: { user_id: user.id },
      data: { email_verified: true, verification_token_hash: null, verification_token_expires_at: null },
    });
    return c.json({ ok: true, direct: true });
  },
);

export default app;
