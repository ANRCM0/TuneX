/**
 * Configuration for the self-hosted RelayX license server.
 *
 * Ported from `relayx-analysis/relayx_license_server.py` (`main()` / `cli()`). The Python
 * reference takes everything from CLI flags; the TS port keeps the same flags and adds an
 * environment-variable layer so the Docker image can be configured without a shell.
 *
 * Deviation: the Python reference defaults to 127.0.0.1:8899. The replica's frozen
 * `.env` points `LICENSE_URL` at http://127.0.0.1:3100, so the default port here is 3100
 * (the server still accepts `--port 8899` for parity with the reference deployment).
 */

export const CONTENT_MODES = ["plain", "base64", "fernet"] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

/**
 * Upstream key1. The panel uses it for the Redis `license` cache and for the
 * `config` push. It is NOT the key the agent uses to decrypt `license.content`.
 * Kept so Fernet tokens stay byte-compatible with `forge_license.py`.
 */
export const RELAYX_FERNET_SECRET = "KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4=";

/**
 * Upstream key2 (agent VA 0x18d9f20). The license server encrypts `content`
 * with this key; the agent decrypts the register ack's `license` field with it.
 * The panel never decrypts `content` — it forwards the string as-is.
 */
export const RELAYX_AGENT_LICENSE_SECRET = "ejNiBvHNYvHSJ307kwKzdFn70XYgnJR8eIzbApWF8Vg=";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3100;
export const DEFAULT_DB_PATH = "license.db";
/** `fernet` so a default `serve` issues tokens the agent can decrypt (key2). */
export const DEFAULT_CONTENT_MODE: ContentMode = "fernet";

export interface LicenseServerConfig {
  host: string;
  port: number;
  dbPath: string;
  contentMode: ContentMode;
  fernetSecret: string;
  quiet: boolean;
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  dbPath?: string;
  contentMode?: string;
  fernetSecret?: string;
  quiet?: boolean;
}

export function isContentMode(value: string): value is ContentMode {
  return (CONTENT_MODES as readonly string[]).includes(value);
}

export function normalizeContentMode(value: string): ContentMode {
  if (!isContentMode(value)) {
    throw new Error(`content 模式非法: ${value}（可选: ${CONTENT_MODES.join(" / ")}）`);
  }
  return value;
}

function parsePort(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口非法: ${String(value)}`);
  }
  return port;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** CLI flag > environment variable > default. */
export function resolveConfig(overrides: ConfigOverrides = {}): LicenseServerConfig {
  return {
    host: overrides.host ?? env("LICENSE_HOST") ?? DEFAULT_HOST,
    port: parsePort(overrides.port ?? env("LICENSE_PORT"), DEFAULT_PORT),
    dbPath: overrides.dbPath ?? env("LICENSE_DB") ?? DEFAULT_DB_PATH,
    contentMode: normalizeContentMode(
      overrides.contentMode ?? env("LICENSE_CONTENT_MODE") ?? DEFAULT_CONTENT_MODE,
    ),
    fernetSecret: overrides.fernetSecret ?? env("LICENSE_FERNET_SECRET") ?? RELAYX_AGENT_LICENSE_SECRET,
    quiet: overrides.quiet ?? false,
  };
}
