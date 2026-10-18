/**
 * Config resolution tests — pins the replica defaults (host/port/db/content mode) and the
 * precedence order `CLI flag > environment variable > default`.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONTENT_MODE,
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  RELAYX_AGENT_LICENSE_SECRET,
  resolveConfig,
} from "../src/config";

const TOUCHED_ENV = [
  "LICENSE_HOST",
  "LICENSE_PORT",
  "LICENSE_DB",
  "LICENSE_CONTENT_MODE",
  "LICENSE_FERNET_SECRET",
];

afterEach(() => {
  for (const name of TOUCHED_ENV) {
    delete process.env[name];
  }
});

describe("resolveConfig", () => {
  it("defaults to the panel-facing 127.0.0.1:3100 with a key2 Fernet license.db", () => {
    const config = resolveConfig();
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.port).toBe(3100);
    expect(config.dbPath).toBe(DEFAULT_DB_PATH);
    expect(config.contentMode).toBe(DEFAULT_CONTENT_MODE);
    expect(config.fernetSecret).toBe(RELAYX_AGENT_LICENSE_SECRET);
    expect(config.quiet).toBe(false);
  });

  it("lets environment variables override the defaults", () => {
    process.env.LICENSE_HOST = "0.0.0.0";
    process.env.LICENSE_PORT = "8899";
    process.env.LICENSE_DB = "/data/license.db";
    process.env.LICENSE_CONTENT_MODE = "fernet";
    process.env.LICENSE_FERNET_SECRET = "AAAA";
    const config = resolveConfig();
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 8899,
      dbPath: "/data/license.db",
      contentMode: "fernet",
      fernetSecret: "AAAA",
    });
  });

  it("lets explicit overrides beat the environment", () => {
    process.env.LICENSE_PORT = "8899";
    process.env.LICENSE_CONTENT_MODE = "fernet";
    const config = resolveConfig({ port: 3901, contentMode: "base64", quiet: true });
    expect(config.port).toBe(3901);
    expect(config.contentMode).toBe("base64");
    expect(config.quiet).toBe(true);
  });

  it("rejects invalid content modes and ports", () => {
    expect(() => resolveConfig({ contentMode: "rot13" })).toThrow(/content 模式非法/);
    expect(() => resolveConfig({ port: 70_000 })).toThrow(/端口非法/);
    expect(() => resolveConfig({ port: 0 })).toThrow(/端口非法/);
  });
});
