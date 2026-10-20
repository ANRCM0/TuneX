import { SystemConfigName } from "@prisma/client";
import { bearerAuth } from "hono/bearer-auth";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";
import {
  ADMIN_RESOURCE_KEYS,
  isAdminResourceKey,
  levelSatisfies,
  requiredLevel,
  resolveAdminRoute,
  STAFF_SHARED_KEY,
  SUPER_ADMIN_KEY,
  type PermissionLevel,
} from "@relayx/shared/permissions";
import { AUTH_MODE, STACK_API_URL, STACK_PROJECT_ID } from "../config";
import { instance, TOKENS } from "../container";
import { db } from "../db";
import type { LicenseService } from "../services/license";
import type { RedisService } from "../services/redis";
// Side-effect import: registers `TOKENS.StackAuth` (and Redis/License, which
// stackauth depends on) with the container. Upstream relied on an `@injectable()`
// decorator to do this implicitly; without it the lazy `instance.resolve` below
// throws `nothing registered for token "StackAuthService"` on the cookie path.
import "../services/stackauth";
import type { StackAuthService } from "../services/stackauth";
import type { SystemConfigService } from "../services/system_config";
import type { AppEnv, SessionUser } from "../types";
import { isUUID } from "../utils/uuid";
import { parseTokenCookie, verifyToken } from "../services/local_auth";

/**
 * Upstream: src/middlewares/auth.ts (225 lines).
 *
 * The whole chain is reproduced here: the 9 public-path escapes, the frozen-clock JWT
 * verification against StackAuth's JWKS, the Redis `user:sub` fast path, auto-provisioning
 * (first registrant becomes super admin), the impersonation header, the bearer API-key
 * fallback and the three admin guards.
 *
 * Two implementation notes, both recorded in docs/DEVIATIONS.md §2:
 *   - upstream calls `instance.resolve(...)` at module scope; the replica resolves inside
 *     the handlers so that import order cannot deadlock the container.
 *   - upstream builds the remote JWKS at module scope; the replica builds it lazily so the
 *     process can boot without StackAuth credentials configured.
 */

export const IMPERSONATION_HEADER = "x-impersonation";

/** Paths that bypass `authRequired` entirely, in the recovered order. */
export const noAuthPathsRegex: RegExp[] = [
  /^\/openapi\.json/,
  /^\/docs/,
  /^\/tunnel\/observer/,
  /^\/tunnel\/subscription/,
  /^\/queuedash/,
  /^\/pay\/.*\/callback/,
  /^\/system\/config\/site/,
  /^\/license\/notify/,
  /^\/license/,
  // Prometheus scrape endpoint: gated by DIAG_TOKEN or loopback in routes/metrics.ts.
  /^\/metrics$/,
  // Local auth: the browser has no session yet when it calls these. /auth/me and
  // /auth/verify-email stay protected.
  /^\/auth\/(sign-in|sign-up|sign-out|refresh)$/,
];

const redisService = () => instance.resolve<RedisService>(TOKENS.Redis);
const licenseService = () => instance.resolve<LicenseService>(TOKENS.License);
const systemConfigService = () => instance.resolve<SystemConfigService>(TOKENS.SystemConfig);
const stackAuthService = () => instance.resolve<StackAuthService>(TOKENS.StackAuth);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    if (!STACK_API_URL || !STACK_PROJECT_ID) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    try {
      jwks = createRemoteJWKSet(new URL(stackAuthService().getJWKSUrl()));
    } catch {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
  }
  return jwks;
}

/** Effective admin permission map for a user, honouring `write` over `read`. */
export function getEffectiveAccess(user: SessionUser): Map<string, PermissionLevel> {
  const access = new Map<string, PermissionLevel>();
  if (user.super_admin) {
    for (const key of ADMIN_RESOURCE_KEYS) access.set(key, "write");
    return access;
  }
  for (const role of user.admin_roles ?? []) {
    const permissions = role.permissions as unknown;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) continue;
    for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
      if (!isAdminResourceKey(key)) continue;
      if (value !== "read" && value !== "write") continue;
      const current = access.get(key);
      if (value === "write" || current === undefined) access.set(key, value);
    }
  }
  return access;
}

/** Super admins may act as another (non-inactive) user via the impersonation header. */
async function resolveImpersonation(c: Context<AppEnv>, user: SessionUser): Promise<SessionUser> {
  if (!user.super_admin) return user;
  const token = c.req.header(IMPERSONATION_HEADER);
  if (!token) return user;
  const targetId = await redisService().getImpersonation(token);
  if (!targetId) return user;
  const target = await db.user.findUnique({ where: { id: targetId }, include: { admin_roles: true } });
  if (target && target.status !== "inactive") return target;
  return user;
}

/**
 * Upstream: `const license = await licenseService.getLicense(); return !license || license.type === "business";`
 * A missing license counts as business-licensed.
 */
export async function isBusinessLicense(): Promise<boolean> {
  const license = await licenseService().getLicense();
  return !license || license.type === "business";
}

export const adminRequired = async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (user.super_admin) return next();
  const access = getEffectiveAccess(user);
  if (!(user.admin_roles?.length && (await isBusinessLicense()) && access.size > 0)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return next();
};

export const superAdminRequired = async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (!user.super_admin) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return next();
};

export const adminPermissionGuard = async (c: Context<AppEnv>, next: Next) => {
  const user = c.get("user");
  if (user.super_admin) return next();
  const entry = resolveAdminRoute(c.req.path);
  if (!entry) {
    throw new HTTPException(403, { message: "无权访问该功能" });
  }
  if (entry.key === SUPER_ADMIN_KEY) {
    throw new HTTPException(403, { message: "无权访问该功能" });
  }
  if (entry.key === STAFF_SHARED_KEY) return next();
  if (!(await isBusinessLicense())) {
    throw new HTTPException(403, { message: "请购买商业授权" });
  }
  const granted = getEffectiveAccess(user).get(entry.key);
  const required = requiredLevel(c.req.method);
  if (!granted || !levelSatisfies(granted, required)) {
    throw new HTTPException(403, { message: "无权访问该功能" });
  }
  return next();
};

/**
 * Local mode: `sub` is the local user id, so no remote lookup is needed.
 * The upstream auto-provisioning path only exists because StackAuth owns the identities.
 */
async function resolveLocalUser(sub: string): Promise<SessionUser> {
  const id = Number.parseInt(sub, 10);
  if (Number.isNaN(id)) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const user = await db.user.findUnique({ where: { id }, include: { admin_roles: true } });
  if (!user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (user.status === "inactive") {
    throw new HTTPException(403, { message: "用户账户已被封禁" });
  }
  return user;
}

/** Resolve (and if needed provision) the local user behind a verified JWT payload. */
async function resolveCookieUser(payload: JWTPayload, parentId?: number): Promise<SessionUser> {
  const sub = payload.sub;
  if (!sub) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const cachedId = await redisService().getUserSub(sub);
  if (cachedId) {
    const cached = await db.user.findUnique({ where: { id: cachedId }, include: { admin_roles: true } });
    if (cached) return cached;
  }

  const me = await stackAuthService().getUserMe(
    // `payload` came from a verified token; re-read the raw token from the caller instead.
    (payload as JWTPayload & { __raw?: string }).__raw ?? "",
  );
  const email = (me as { primary_email?: string }).primary_email ?? "";
  const uid = (me as { id?: string }).id;

  // `uid` is nullable and not unique upstream (a StackAuth account can be linked to one
  // RelayX user), so this is a `findFirst`, not a `findUnique`.
  let user = uid ? await db.user.findFirst({ where: { uid }, include: { admin_roles: true } }) : null;

  if (!user) {
    const existingByEmail = await db.user.findUnique({ where: { email }, include: { admin_roles: true } });
    if (existingByEmail) {
      if (existingByEmail.status === "inactive") {
        throw new HTTPException(403, { message: "用户账户已被封禁" });
      }
      user = await db.user.update({
        where: { id: existingByEmail.id },
        data: { uid },
        include: { admin_roles: true },
      });
    } else {
      const allowRegister = await systemConfigService().getConfig(SystemConfigName.ALLOW_REGISTER);
      if (!allowRegister) {
        throw new HTTPException(403, { message: "当前站点不允许注册" });
      }
      const superAdmin = await db.user.findFirst({ where: { super_admin: true } });
      user = await db.user.create({
        data: { email, uid, super_admin: superAdmin ? false : true, parent_id: parentId },
        include: { admin_roles: true },
      });
    }
  } else if (user.status === "inactive") {
    throw new HTTPException(403, { message: "用户账户已被封禁" });
  }

  await redisService().setUserSub(sub, user.id);
  return user;
}

export const authRequired = async (c: Context<AppEnv>, next: Next) => {
  const path = c.req.path;
  if (noAuthPathsRegex.some((regex) => regex.test(path))) {
    return next();
  }

  const cookie = getCookie(c, "stack-access");
  if (cookie) {
    let token: string | undefined;
    try {
      // StackAuth writes raw JSON; a proxy or another client may percent-encode it.
      token = JSON.parse(decodeURIComponent(cookie))[1];
    } catch {
      token = undefined;
    }
    if (!token) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    let payload: JWTPayload;
    if (AUTH_MODE === "local") {
      // Local sessions are our own HS256 tokens; `sub` is the local user id.
      const verified = await verifyToken(token, "access", { freezeClock: true });
      if (!verified) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      const localUser = await resolveLocalUser(verified.sub);
      c.set("user", await resolveImpersonation(c, localUser));
      return next();
    }
    try {
      // `currentDate: new Date(0)` freezes the clock so `exp`/`nbf` are never enforced —
      // recovered verbatim from the upstream middleware.
      ({ payload } = await jwtVerify(token, getJwks(), { currentDate: new Date(0) }));
    } catch {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    // Upstream 062__src__middlewares__auth.ts:160-180: a `ref` cookie names the referrer
    // and is written onto `parent_id` only when this login provisions a new user.
    const refRaw = getCookie(c, "ref");
    let parentId: number | undefined;
    if (refRaw) {
      const refId = Number.parseInt(refRaw, 10);
      if (!Number.isNaN(refId)) {
        const parentUser = await db.user.findUnique({ where: { id: refId } });
        if (parentUser?.id) parentId = parentUser.id;
      }
    }
    const user = await resolveCookieUser(Object.assign(payload, { __raw: token }), parentId);
    c.set("user", await resolveImpersonation(c, user));
  }

  if (c.get("user") === undefined) {
    // `bearerAuth` declares its own env; cast so it can run inside `AppEnv`.
    const bearer = bearerAuth({
      verifyToken: async (token, ctx) => {
        const context = ctx as unknown as Context<AppEnv>;
        if (isUUID(token)) {
          const license = await licenseService().getLicense();
          if (license && license.type !== "business") {
            throw new HTTPException(403, { message: "请购买商业授权" });
          }
        }
        const user = await db.user.findUnique({ where: { api_key: token }, include: { admin_roles: true } });
        if (!user) return false;
        if (user.status === "inactive") {
          throw new HTTPException(403, { message: "用户账户已被封禁" });
        }
        context.set("user", await resolveImpersonation(context, user));
        return true;
      },
    });
    return (bearer as unknown as (c: Context<AppEnv>, next: Next) => Promise<Response>)(c, next);
  }

  return next();
};
