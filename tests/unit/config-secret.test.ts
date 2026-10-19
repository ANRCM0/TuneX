/**
 * `resolveConfigSecret` — the production guard on the Fernet key.
 *
 * Development keeps the recovered upstream key so a fresh clone works, but a
 * production process must supply its own: the recovered key is published, so any
 * deployment that kept it could have its agent configs decrypted by a reader of
 * this repository.
 */
import { describe, expect, it } from "vitest";
import { RECOVERED_FERNET_KEY, resolveConfigSecret } from "../../apps/backend/src/config";

describe("resolveConfigSecret", () => {
  it("returns an explicit value in any environment", () => {
    const own = "A".repeat(43) + "=";
    expect(resolveConfigSecret({ NODE_ENV: "production", CONFIG_SECRET: own })).toBe(own);
    expect(resolveConfigSecret({ NODE_ENV: "development", CONFIG_SECRET: own })).toBe(own);
  });

  it("falls back to the recovered key outside production", () => {
    expect(resolveConfigSecret({ NODE_ENV: "development" })).toBe(RECOVERED_FERNET_KEY);
    expect(resolveConfigSecret({ NODE_ENV: "test" })).toBe(RECOVERED_FERNET_KEY);
  });

  it("refuses to boot in production without a secret", () => {
    expect(() => resolveConfigSecret({ NODE_ENV: "production" })).toThrow(/CONFIG_SECRET is required/);
    expect(() => resolveConfigSecret({})).toThrow(/CONFIG_SECRET is required/);
  });

  it("ignores a blank value", () => {
    expect(() => resolveConfigSecret({ NODE_ENV: "production", CONFIG_SECRET: "   " })).toThrow(
      /CONFIG_SECRET is required/,
    );
  });
});
