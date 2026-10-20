/**
 * Runtime configuration.
 *
 * Recovered evidence: relayx-analysis/work/modules/001__src__config.ts (17 lines) and
 * relayx-analysis/reports/BACKEND_REPORT.md §2. The exported names and default values
 * below match the recovered module verbatim; the only additions are the replica-only
 * knobs appended at the bottom (marked "replica-only").
 */
import dotenv from "dotenv";

// The repository keeps a single .env at the workspace root; load it first, then let a
// package-local .env override it.
dotenv.config({ path: new URL("../../../.env", import.meta.url) });
dotenv.config();

/** Process-wide timezone. The original pins it at module load. */
export const TZ = "Asia/Shanghai";
process.env.TZ = process.env.TZ || TZ;

export const NODE_ENV = process.env.NODE_ENV || "production";
export const SENTRY_DSN = process.env.SENTRY_DSN || "";
export const SITE_URL = process.env.SITE_URL || "http://127.0.0.1:3000";
export const STACK_SECRET_SERVER_KEY = process.env.STACK_SECRET_SERVER_KEY || "";
export const STACK_PROJECT_ID = process.env.STACK_PROJECT_ID || "";
export const STACK_API_URL = process.env.STACK_API_URL || "";
export const REDIS_URL = process.env.REDIS_URL || "";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const DIAG_TOKEN = process.env.DIAG_TOKEN || "";
// The replica points at a self-hosted license server by default (see docs/DEPLOY.md).
// Upstream's `https://license.relayx.cc` is a third-party deployment the operator does
// not control; set LICENSE_URL explicitly to use it.
export const LICENSE_URL = process.env.LICENSE_URL || "http://127.0.0.1:8899";
export const AGENT_VERSION_URL = "https://dl.relayx.cc/VERSION";
export const AGENT_DOWNLOAD_URL = "https://dl.relayx.cc/relayx-agent";

export function isProduction(): boolean {
  return NODE_ENV === "production";
}

/** Directory of the backend package (…/apps/backend). */
export const BACKEND_ROOT = new URL("../", import.meta.url).pathname;

// ── replica-only ───────────────────────────────────────────────────────────────
// Switches that do not exist upstream but are needed to run without the original
// managed infrastructure. Defaults keep upstream behaviour.
/** Bearer token required by /health/diag and /health/heap; empty disables both. */
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
/**
 * Authentication backend.
 *
 * `stack` — verify StackAuth JWTs against its JWKS (upstream behaviour; needs a project).
 * `local` — passwords + HS256 sessions issued by this process (see services/local_auth.ts).
 *
 * Defaults to `local` when no StackAuth project is configured, so a fresh checkout can log
 * in; set `AUTH_MODE=stack` to force the upstream path.
 */
export const AUTH_MODE: "local" | "stack" =
  (process.env.AUTH_MODE as "local" | "stack" | undefined) ??
  (process.env.STACK_API_URL && process.env.STACK_PROJECT_ID ? "stack" : "local");
/**
 * Signing key for local sessions. The default is a fixed development value: production
 * deployments must override it (same policy as CONFIG_SECRET).
 */
export const AUTH_SECRET = process.env.AUTH_SECRET || "relayx-local-auth-dev-secret-change-me-0123456789";
export const AUTH_ACCESS_TTL_SECONDS = Number.parseInt(process.env.AUTH_ACCESS_TTL_SECONDS || "86400", 10);
export const AUTH_REFRESH_TTL_SECONDS = Number.parseInt(
  process.env.AUTH_REFRESH_TTL_SECONDS || "2592000",
  10,
);
/**
 * How a local account proves it owns its address.
 *
 * `email` — mail a one-time link (needs SMTP or Resend configured in /admin/settings).
 * `direct` — mark the address verified from the signed-in session (no mail transport).
 *
 * Defaults to `email`; `services/local_auth.ts` falls back to `direct` when no provider is
 * configured so a fresh checkout is usable. Override with `AUTH_VERIFY_MODE`.
 */
export const AUTH_VERIFY_MODE: "email" | "direct" =
  (process.env.AUTH_VERIFY_MODE as "email" | "direct" | undefined) ?? "email";
/** Lifetime of a mailed verification link, in seconds. */
export const AUTH_VERIFY_TTL_SECONDS = Number.parseInt(process.env.AUTH_VERIFY_TTL_SECONDS || "86400", 10);
/** Minimum seconds between two verification mails for the same account. */
export const AUTH_VERIFY_RESEND_SECONDS = Number.parseInt(process.env.AUTH_VERIFY_RESEND_SECONDS || "60", 10);

/** Port the HTTP server listens on. */
export const PORT = Number.parseInt(process.env.PORT || "3000", 10);
/**
 * Secret used to encrypt payment gateway configs at rest and to decrypt the
 * config pushed to agents.
 *
 * `fernet.Secret` rejects anything that is not exactly 32 url-safe base64-encoded
 * bytes, and `services/fernet.ts` constructs it at import time — an invalid value
 * aborts the whole process.
 *
 * Production requires an explicit value. The recovered upstream key below is only
 * a development fallback: it is published in the analysis tree, so any deployment
 * that keeps it can have its node configs decrypted by anyone with this repository.
 * Generate a real one with:
 *
 *   node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
 *
 * and set both `CONFIG_SECRET` (panel) and the agent's `--config-secret` to it.
 */
export const RECOVERED_FERNET_KEY = "KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4=";

/** Resolve `CONFIG_SECRET`, refusing to boot in production when it is unset. */
export function resolveConfigSecret(env: NodeJS.ProcessEnv = process.env): string {
  const provided = (env.CONFIG_SECRET ?? "").trim();
  if (provided) return provided;
  if ((env.NODE_ENV ?? "production") === "production") {
    throw new Error(
      "CONFIG_SECRET is required when NODE_ENV=production; generate one with " +
        '`node -e \'console.log(require("crypto").randomBytes(32).toString("base64url"))\'`',
    );
  }
  return RECOVERED_FERNET_KEY;
}

export const CONFIG_SECRET = resolveConfigSecret();
