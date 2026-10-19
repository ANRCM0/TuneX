/**
 * The panel↔agent Fernet key must be the same constant on both sides.
 *
 * Upstream hardcodes one key in the panel (`work/modules/006__src__services__fernet.ts:2`)
 * and the same literal as key1 in the agent. A previous replica revision used a
 * derived panel key, so a fresh `pnpm dev` plus a default agent could not decrypt the
 * config push at all. This suite pins the constant in every place it is repeated
 * (backend default, agent default, `.env`, the E2E harness) and against the
 * decompiled original when the analysis tree is available.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ANALYSIS = fileURLToPath(new URL("../../../relayx-analysis/", import.meta.url));

function backendDefault(): string {
  const source = readFileSync(`${ROOT}apps/backend/src/config.ts`, "utf8");
  const match = /export const RECOVERED_FERNET_KEY = "([^"]+)"/.exec(source);
  if (!match) throw new Error("RECOVERED_FERNET_KEY not found in backend config");
  return match[1];
}

function agentDefault(): string {
  const source = readFileSync(`${ROOT}apps/agent/internal/config/config.go`, "utf8");
  const match = /DefaultConfigSecret\s*=\s*"([^"]+)"/.exec(source);
  if (!match) throw new Error("DefaultConfigSecret not found in agent config");
  return match[1];
}

function envValue(): string {
  const source = readFileSync(`${ROOT}.env`, "utf8");
  const match = /^CONFIG_SECRET=(.+)$/m.exec(source);
  if (!match) throw new Error("CONFIG_SECRET missing from .env");
  return match[1].trim();
}

describe("panel/agent Fernet key parity", () => {
  it("uses one valid 32-byte key everywhere", () => {
    const key = backendDefault();
    expect(key).toBe(agentDefault());
    expect(key).toBe(envValue());

    const decoded = Buffer.from(key, "base64url");
    expect(decoded).toHaveLength(32);
    // The upstream literal uses the standard alphabet and padding; both peers
    // accept it, so compare after normalising to unpadded base64url.
    const normalised = key.replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/, "");
    expect(decoded.toString("base64url")).toBe(normalised);
  });

  it("matches the decompiled panel literal", () => {
    const file = `${ANALYSIS}work/modules/006__src__services__fernet.ts`;
    if (!existsSync(file)) return; // standalone clone of the replica
    const source = readFileSync(file, "utf8");
    const match = /var SECRET = "([^"]+)"/.exec(source);
    expect(match, "SECRET literal not found in the decompiled module").toBeTruthy();
    expect(backendDefault()).toBe(match![1]);
  });

  it("keeps the E2E harness default in sync", () => {
    const source = readFileSync(`${ROOT}scripts/e2e-local.sh`, "utf8");
    const fallbacks = [...source.matchAll(/CONFIG_SECRET="\$\{CONFIG_SECRET:-([^}]+)\}"/g)].map(
      (match) => match[1],
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    // The harness may read .env first; any literal fallback must be the same key.
    const literal = fallbacks.find((value) => !value.startsWith("$("));
    if (literal) expect(literal).toBe(backendDefault());
  });
});
