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
export const LICENSE_URL = process.env.LICENSE_URL || "https://license.relayx.cc";
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
/** Port the HTTP server listens on. */
export const PORT = Number.parseInt(process.env.PORT || "3000", 10);
/**
 * Secret used to encrypt payment gateway configs at rest.
 *
 * `fernet.Secret` rejects anything that is not exactly 32 url-safe base64-encoded
 * bytes, and `services/fernet.ts` constructs it at import time — an invalid value
 * here aborts the whole process. Upstream shipped no default (the variable is
 * mandatory in production); the replica default below is a fixed, valid key so
 * `pnpm dev` works out of the box. Override it in production.
 */
export const CONFIG_SECRET =
  process.env.CONFIG_SECRET || "5HVa-B4kYWf9qI524XABW2lg0g5OZZfyq9BoZWNrHp0=";
