import { HTTPException } from "hono/http-exception";
import { LICENSE_URL, SITE_URL } from "../config";
import type { RedisService } from "./redis";
import { instance, service, TOKENS } from "../container";

/**
 * Upstream: src/services/license.ts (127 lines).
 *
 * Upstream talks to the hosted license server through a Hono `hc()` typed client. The
 * replica keeps the exact same wire contract but issues the requests with `fetch` so the
 * backend does not have to import types across app boundaries (see docs/DEVIATIONS.md §3).
 */

export const LicenseType = {
  Personal: "personal",
  Business: "business",
} as const;
export type LicenseType = (typeof LicenseType)[keyof typeof LicenseType];

export const CouponValidCycle = {
  Month: "month",
  Year: "year",
  Lifetime: "lifetime",
} as const;
export type CouponValidCycle = (typeof CouponValidCycle)[keyof typeof CouponValidCycle];

export interface LicenseContent {
  expired_at: string | Date;
  created_at: string | Date;
  site_url: string;
  type: LicenseType;
  content: string;
}

export interface LicenseHistoryItem {
  id: string;
  created_at: string;
  [key: string]: unknown;
}

interface WireResponse {
  ok: boolean;
  status: number;
  data: unknown;
  error?: { status: number; value: { error?: string } };
}

async function call(
  method: string,
  path: string,
  init?: { query?: Record<string, unknown>; body?: unknown },
): Promise<WireResponse> {
  const url = new URL(path, LICENSE_URL || "http://127.0.0.1:3100");
  for (const [key, value] of Object.entries(init?.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: init?.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (response.ok) {
    return { ok: true, status: response.status, data };
  }
  return {
    ok: false,
    status: response.status,
    data,
    error: { status: response.status, value: (data as { error?: string }) ?? {} },
  };
}

export class LicenseService {
  constructor(private readonly redisService: RedisService) {}

  async payLicense(
    payment_id: string,
    pay_type: string,
    cycle: CouponValidCycle,
    redirect_url: string,
    client_ip: string,
    type: LicenseType,
    coupon?: string,
  ): Promise<unknown> {
    const response = await call("POST", "/license", {
      body: {
        site_url: SITE_URL,
        payment_id,
        pay_type,
        cycle,
        redirect_url,
        client_ip,
        type,
        coupon,
      },
    });
    return response.data;
  }

  async getLicenseFromServer(): Promise<LicenseContent | null> {
    const response = await call("GET", "/license", { query: { site_url: SITE_URL } });
    return (response.data as LicenseContent | null) ?? null;
  }

  async getPay(): Promise<unknown> {
    const response = await call("GET", "/pay");
    return response.data;
  }

  async getCoupon(coupon: string, type: LicenseType, cycle: CouponValidCycle): Promise<unknown> {
    const response = await call("GET", "/coupon", {
      query: { code: coupon, type, site_url: SITE_URL, cycle },
    });
    if (response.ok) {
      return response.data;
    }
    throw new HTTPException(response.error!.status as 400, {
      message: response.error!.value.error ?? "获取优惠码失败",
    });
  }

  async getLicense(force = false): Promise<LicenseContent | null> {
    if (!force) {
      const license = ((await this.redisService.getLicense()) as unknown as LicenseContent | null);
      if (license && license.site_url === SITE_URL) {
        return license;
      }
    }
    let remoteLicense: LicenseContent | null = null;
    try {
      remoteLicense = await this.getLicenseFromServer();
    } catch (error) {
      throw new HTTPException(500, { message: "获取远程 License 失败", cause: error });
    }
    if (!remoteLicense) {
      await this.redisService.delLicense();
      return null;
    }
    await this.redisService.setLicense(remoteLicense);
    return remoteLicense;
  }

  async updateLicense(new_site_url: string): Promise<void> {
    const content = ((await this.redisService.getLicense()) as unknown as LicenseContent | null);
    if (!content) {
      throw new HTTPException(404, { message: "请先购买 License" });
    }
    const response = await call("PUT", "/license", {
      body: { site_url: new_site_url, content: content.content },
    });
    if (response.ok) {
      await this.redisService.delLicense();
    } else {
      throw new HTTPException(response.error!.status as 400, {
        message: response.error!.value.error ?? "更新 License 失败",
      });
    }
  }

  async getHistory(
    page = 1,
    limit = 10,
    sort?: string,
    status?: string,
    order_id?: string,
  ): Promise<unknown> {
    const response = await call("GET", "/license/history", {
      query: { site_url: SITE_URL, page, limit, sort, status, order_id },
    });
    if (response.ok) {
      return response.data;
    }
    throw new HTTPException(response.error!.status as 400, {
      message: response.error!.value.error ?? "获取 License 历史失败",
    });
  }
}

/** Self-registration. */
export const licenseService = service<LicenseService>(TOKENS.License, () => new LicenseService(instance.resolve<RedisService>(TOKENS.Redis)));
