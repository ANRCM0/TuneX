import crypto from "node:crypto";
import { DNSProviderType, type Prisma } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { service } from "../../container";
import { CloudflareDNSProvider } from "./cloudflare";
import { HuaweiDNSProvider } from "./huawei";
import type { DNSProvider, DNSProviderConfig } from "./interface";

/**
 * Upstream: src/services/dns/index.ts (module 024) — ported 1:1.
 *
 * The provider instances are cached process-wide by `type:domain:sha1(config)`, exactly
 * like the original. The cache has no TTL: a config change produces a new fingerprint
 * and therefore a new provider.
 */

const providerCache = new Map<string, DNSProvider>();

function buildProvider(
  type: DNSProviderType,
  domain: string,
  config: DNSProviderConfig,
): DNSProvider {
  switch (type) {
    case DNSProviderType.cloudflare:
      return new CloudflareDNSProvider(domain, config);
    case DNSProviderType.huawei:
      return new HuaweiDNSProvider(domain, config);
    default:
      throw new HTTPException(400, {
        message: `不支持的 DNS 服务商: ${type}`,
      });
  }
}

/**
 * `DNSProvider.config` is a plaintext `Json` column; the request schema constrains it to
 * string values, but the column itself is untyped, so narrow it here.
 */
function normalizeConfig(config: Prisma.JsonValue | null | undefined): DNSProviderConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const result: DNSProviderConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function getDNSProvider(
  type: DNSProviderType,
  domain: string,
  config: Prisma.JsonValue | null | undefined,
): DNSProvider {
  const providerConfig = normalizeConfig(config);
  const configFingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify(providerConfig, Object.keys(providerConfig).sort()))
    .digest("hex");
  const key = `${type}:${domain}:${configFingerprint}`;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = buildProvider(type, domain, providerConfig);
    providerCache.set(key, provider);
  }
  return provider;
}

/** Factory surface, also reachable through the container like every other service. */
export interface DNSProviderFactory {
  get(
    type: DNSProviderType,
    domain: string,
    config: Prisma.JsonValue | null | undefined,
  ): DNSProvider;
}

export const dnsProviderFactory = service<DNSProviderFactory>("DNSProviderFactory", () => ({
  get: getDNSProvider,
}));
