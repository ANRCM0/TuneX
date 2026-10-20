/**
 * Replica-local authentication.
 *
 * Upstream has no password handling of its own: StackAuth issues the session and the
 * panel only verifies its JWTs against StackAuth's JWKS. This service replaces that
 * hosted dependency with an equivalent local contract, so the panel can be run end to end
 * without a StackAuth project:
 *
 *   - passwords are stored as scrypt hashes (`LocalCredential.password_hash`);
 *   - the session cookie keeps the upstream name and shape — `stack-access` holds the JSON
 *     array `[refreshToken, accessToken]`, which is what `apps/web` and the middleware read;
 *   - both tokens are HS256 JWTs signed with `AUTH_SECRET`, with `sub` = local user id.
 *
 * Consequences (documented in docs/DEVIATIONS.md §30): tokens cannot be validated by
 * StackAuth, and a mixed deployment must pick one mode with `AUTH_MODE`.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { AUTH_ACCESS_TTL_SECONDS, AUTH_REFRESH_TTL_SECONDS, AUTH_SECRET } from "../config";

const scryptAsync = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Cookie name upstream uses for the token pair. */
export const AUTH_COOKIE = "stack-access";
/** Second cookie upstream sets; kept so the frontend/impersonation paths behave the same. */
export const AUTH_REFRESH_COOKIE = "stack-refresh";
export const AUTH_IS_HTTPS_COOKIE = "stack-is-https";

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function secret(): Uint8Array {
  return new TextEncoder().encode(AUTH_SECRET);
}

/** `scrypt$N$r$p$saltB64$hashB64` — self-describing so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export type TokenPair = { accessToken: string; refreshToken: string };

async function sign(sub: string, kind: "access" | "refresh", ttl: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret());
}

export async function issueTokens(userId: number): Promise<TokenPair> {
  const sub = String(userId);
  return {
    accessToken: await sign(sub, "access", AUTH_ACCESS_TTL_SECONDS),
    refreshToken: await sign(sub, "refresh", AUTH_REFRESH_TTL_SECONDS),
  };
}

export type VerifiedToken = { sub: string; kind: "access" | "refresh"; payload: JWTPayload };

/**
 * Verify a token and require the expected kind.
 *
 * `freezeClock` mirrors the upstream middleware's `currentDate: new Date(0)`: expiry is
 * not enforced there either. Kept off by default for the local mode (a real session should
 * expire), and exposed so callers can reproduce the upstream behaviour when needed.
 */
export async function verifyToken(
  token: string,
  expected: "access" | "refresh" = "access",
  options: { freezeClock?: boolean } = {},
): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      ...(options.freezeClock ? { currentDate: new Date(0) } : {}),
    });
    const kind = payload.kind === "refresh" ? "refresh" : "access";
    if (kind !== expected || !payload.sub) return null;
    return { sub: payload.sub, kind, payload };
  } catch {
    return null;
  }
}

/** Serialize the cookie pair exactly like StackAuth's token store does. */
export function tokenCookieValue(pair: TokenPair): string {
  return JSON.stringify([pair.refreshToken, pair.accessToken]);
}

export function parseTokenCookie(value: string | undefined): TokenPair | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const [refreshToken, accessToken] = parsed;
    if (typeof refreshToken !== "string" || typeof accessToken !== "string") return null;
    return { refreshToken, accessToken };
  } catch {
    return null;
  }
}

export function authCookies(pair: TokenPair): { name: string; value: string; maxAge: number }[] {
  return [
    { name: AUTH_COOKIE, value: tokenCookieValue(pair), maxAge: AUTH_REFRESH_TTL_SECONDS },
    { name: AUTH_REFRESH_COOKIE, value: pair.refreshToken, maxAge: AUTH_REFRESH_TTL_SECONDS },
  ];
}
