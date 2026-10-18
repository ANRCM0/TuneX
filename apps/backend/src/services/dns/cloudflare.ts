import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { HTTPException } from "hono/http-exception";
import { logger } from "../logger";
import {
  getRootDomain,
  type DNSProvider,
  type DNSProviderConfig,
  type DNSRecord,
  type DNSRecordType,
} from "./interface";

/**
 * Upstream: src/services/dns/cloudflare.ts (module 022).
 *
 * Deviation: the original used the `cloudflare` npm SDK v5.2.0. The replica's
 * dependency set is frozen (no new packages), so the SDK surface used by the provider
 * is re-implemented here as a thin Cloudflare API v4 client with the same shapes
 * (`cloudflare.zones.list(...)`, `cloudflare.dns.records.list/create/update/delete`).
 * Endpoints, filters, defaults and error handling match the SDK call sites exactly.
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareZone {
  id: string;
}

interface CloudflareRecord {
  id: string;
  type: string;
  content: string;
}

interface CloudflareListResponse<T> {
  result: T[];
}

interface ListZonesParams {
  name?: string;
  status?: string;
  per_page?: number;
}

interface ExactFilter {
  exact?: string;
}

interface ListRecordsParams {
  zone_id: string;
  name?: string | ExactFilter;
  content?: string | ExactFilter;
  per_page?: number;
}

interface CreateRecordParams {
  zone_id: string;
  name: string;
  ttl: number;
  type: string;
  content: string;
}

interface UpdateRecordParams {
  zone_id: string;
  name: string;
  ttl: number;
  type: string;
  content: string;
}

interface DeleteRecordParams {
  zone_id: string;
}

/** The SDK sends `{ exact: value }` as a plain equality filter on the query string. */
function exactValue(value: string | ExactFilter | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.exact;
}

class CloudflareClient {
  private readonly http: AxiosInstance;

  readonly zones: { list(params: ListZonesParams): Promise<CloudflareListResponse<CloudflareZone>> };

  readonly dns: {
    records: {
      list(params: ListRecordsParams): Promise<CloudflareListResponse<CloudflareRecord>>;
      create(params: CreateRecordParams): Promise<CloudflareRecord>;
      update(recordId: string, params: UpdateRecordParams): Promise<CloudflareRecord>;
      delete(recordId: string, params: DeleteRecordParams): Promise<unknown>;
    };
  };

  constructor(apiToken: string) {
    this.http = axios.create({
      baseURL: CLOUDFLARE_API_BASE,
      headers: { Authorization: `Bearer ${apiToken}` },
      timeout: 15_000,
    });
    this.zones = {
      list: (params) =>
        this.request<CloudflareListResponse<CloudflareZone>>({
          method: "GET",
          url: "/zones",
          params,
        }),
    };
    this.dns = {
      records: {
        list: (params) =>
          this.request<CloudflareListResponse<CloudflareRecord>>({
            method: "GET",
            url: `/zones/${params.zone_id}/dns_records`,
            params: {
              name: exactValue(params.name),
              content: exactValue(params.content),
              per_page: params.per_page,
            },
          }),
        create: (params) =>
          this.request<CloudflareRecord>({
            method: "POST",
            url: `/zones/${params.zone_id}/dns_records`,
            data: {
              name: params.name,
              ttl: params.ttl,
              type: params.type,
              content: params.content,
            },
          }),
        update: (recordId, params) =>
          this.request<CloudflareRecord>({
            method: "PUT",
            url: `/zones/${params.zone_id}/dns_records/${recordId}`,
            data: {
              name: params.name,
              ttl: params.ttl,
              type: params.type,
              content: params.content,
            },
          }),
        delete: (recordId, params) =>
          this.request<unknown>({
            method: "DELETE",
            url: `/zones/${params.zone_id}/dns_records/${recordId}`,
          }),
      },
    };
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.http.request<T>(config);
    return response.data;
  }
}

export class CloudflareDNSProvider implements DNSProvider {
  cloudflare: CloudflareClient;
  domain: string;
  rootDomain: string;

  constructor(domain: string, config: DNSProviderConfig) {
    this.domain = domain;
    this.rootDomain = getRootDomain(domain);
    this.cloudflare = new CloudflareClient(config.api_token);
  }

  async getZoneId(): Promise<string> {
    const zones = await this.cloudflare.zones.list({
      name: this.rootDomain,
      status: "active",
      per_page: 50,
    });
    if (zones.result.length === 0) {
      throw new HTTPException(400, {
        message: `域名 ${this.rootDomain} 未在 Cloudflare 中找到`,
      });
    }
    return zones.result[0].id;
  }

  async listRecords(): Promise<DNSRecord[]> {
    const zoneId = await this.getZoneId();
    const records = await this.cloudflare.dns.records.list({
      zone_id: zoneId,
      name: { exact: this.domain },
      per_page: 500,
    });
    return records.result
      .filter((record) => record.type === "A" || record.type === "AAAA")
      .map((record) => ({
        ip: record.content,
        type: record.type,
      }));
  }

  async createRecord(
    ip: string,
    type: DNSRecordType,
    ttl?: number,
    weight?: number,
    _line?: string,
  ): Promise<boolean> {
    try {
      const zoneId = await this.getZoneId();
      await this.cloudflare.dns.records.create({
        zone_id: zoneId,
        name: this.domain,
        ttl: typeof ttl === "number" ? ttl : 1,
        type,
        content: ip,
      });
      return true;
    } catch (error) {
      logger.error(error, `Failed to create record: ${ip} ${type} ${ttl}`);
      return false;
    }
  }

  async updateRecord(
    oldIp: string,
    newIp: string,
    type: DNSRecordType,
    ttl?: number,
    _weight?: number,
    _line?: string,
  ): Promise<void> {
    const zoneId = await this.getZoneId();
    try {
      const recordId = await this.getRecordId(oldIp);
      await this.cloudflare.dns.records.update(recordId, {
        zone_id: zoneId,
        name: this.domain,
        ttl: typeof ttl === "number" ? ttl : 1,
        type,
        content: newIp,
      });
    } catch (error) {
      logger.error(error, `Failed to update record: ${oldIp} -> ${newIp} ${type} ${ttl}`);
    }
  }

  async deleteRecord(ip: string): Promise<boolean> {
    try {
      const zone_id = await this.getZoneId();
      const recordId = await this.getRecordId(ip);
      await this.cloudflare.dns.records.delete(recordId, { zone_id });
      return true;
    } catch (error) {
      logger.error(error, `Failed to delete record: ${ip}`);
      return false;
    }
  }

  async getRecordId(ip: string): Promise<string> {
    const zoneId = await this.getZoneId();
    const records = await this.cloudflare.dns.records.list({
      zone_id: zoneId,
      name: { exact: this.domain },
      content: { exact: ip },
    });
    if (records.result.length === 0) {
      throw new HTTPException(400, { message: "DNS 记录不存在" });
    }
    return records.result[0].id;
  }

  async deleteRecords(): Promise<void> {
    const zoneId = await this.getZoneId();
    const records = await this.cloudflare.dns.records.list({
      zone_id: zoneId,
      name: { exact: this.domain },
    });
    for (const record of records.result) {
      await this.cloudflare.dns.records.delete(record.id, { zone_id: zoneId });
    }
  }
}
