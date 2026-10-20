import crypto from "node:crypto";
import axios from "axios";
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
 * Upstream: src/services/dns/huawei.ts (module 023).
 *
 * Deviation: the original used `@huaweicloud/huaweicloud-sdk-dns` + `BasicCredentials`.
 * The replica's dependency set is frozen, so the SDK surface used by the provider is
 * re-implemented here over the Huawei Cloud DNS REST API with the AK/SK
 * (`SDK-HMAC-SHA256`) request signature. The provider body below mirrors the recovered
 * call sequence one-to-one (same request builders, same endpoints, same error strings
 * and log lines).
 *
 * NOTE: the wire protocol cannot be exercised without a real Huawei Cloud account; the
 * provider is covered by unit tests only through its pure helpers (see tests/unit/dns.test.ts).
 */

const DNS_SERVICE = "dns";

type QueryParams = Record<string, string | number | undefined>;

interface HuaweiCredentials {
  accessKey: string;
  secretKey: string;
  projectId: string;
  region: string;
}

interface HuaweiZone {
  id?: string;
  name?: string;
}

interface HuaweiRecordSet {
  id?: string;
  name?: string;
  type?: string;
  records?: string[];
}

interface ListPublicZonesResponse {
  zones?: HuaweiZone[];
}

interface ListRecordSetsResponse {
  recordsets?: HuaweiRecordSet[];
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 3986 encoding, as required for the canonical request. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Sorted `key=value` pairs with encoded keys and values (values may be empty). */
function canonicalQuery(params: QueryParams): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(String(params[key]))}`)
    .join("&");
}

// ── request builders (shape-compatible with the Huawei SDK classes) ──────────────

class ListPublicZonesRequest {
  params: QueryParams = {};
  withName(name: string): this {
    this.params.name = name;
    return this;
  }
  withLimit(limit: number): this {
    this.params.limit = limit;
    return this;
  }
  withOffset(offset: number): this {
    this.params.offset = offset;
    return this;
  }
}

class ListRecordSetsWithLineRequest {
  params: QueryParams = {};
  withName(name: string): this {
    this.params.name = name;
    return this;
  }
  withRecords(records: string): this {
    this.params.records = records;
    return this;
  }
  withLimit(limit: number): this {
    this.params.limit = limit;
    return this;
  }
  withOffset(offset: number): this {
    this.params.offset = offset;
    return this;
  }
}

interface RecordSetBody {
  name?: string;
  type?: string;
  weight?: number;
  ttl?: number;
  records?: string[];
  line?: string;
}

class CreateRecordSetWithLineRequestBody {
  body: RecordSetBody = {};
  withName(name: string): this {
    this.body.name = name;
    return this;
  }
  withType(type: string): this {
    this.body.type = type;
    return this;
  }
  withWeight(weight?: number): this {
    this.body.weight = weight;
    return this;
  }
  withTtl(ttl?: number): this {
    this.body.ttl = ttl;
    return this;
  }
  withRecords(records: string[]): this {
    this.body.records = records;
    return this;
  }
  withLine(line: string): this {
    this.body.line = line;
    return this;
  }
}

class CreateRecordSetWithLineRequest {
  zoneId = "";
  body?: CreateRecordSetWithLineRequestBody;
  withZoneId(zoneId: string): this {
    this.zoneId = zoneId;
    return this;
  }
  withBody(body: CreateRecordSetWithLineRequestBody): this {
    this.body = body;
    return this;
  }
}

class UpdateRecordSetsReq {
  body: RecordSetBody = {};
  withName(name: string): this {
    this.body.name = name;
    return this;
  }
  withType(type: string): this {
    this.body.type = type;
    return this;
  }
  withWeight(weight?: number): this {
    this.body.weight = weight;
    return this;
  }
  withTtl(ttl?: number): this {
    this.body.ttl = ttl;
    return this;
  }
  withRecords(records: string[]): this {
    this.body.records = records;
    return this;
  }
}

class UpdateRecordSetsRequest {
  zoneId = "";
  recordsetId = "";
  body?: UpdateRecordSetsReq;
  withZoneId(zoneId: string): this {
    this.zoneId = zoneId;
    return this;
  }
  withRecordsetId(recordsetId: string): this {
    this.recordsetId = recordsetId;
    return this;
  }
  withBody(body: UpdateRecordSetsReq): this {
    this.body = body;
    return this;
  }
}

class DeleteRecordSetsRequest {
  zoneId = "";
  recordsetId = "";
  withZoneId(zoneId: string): this {
    this.zoneId = zoneId;
    return this;
  }
  withRecordsetId(recordsetId: string): this {
    this.recordsetId = recordsetId;
    return this;
  }
}

class BatchDeleteRecordSetWithLineRequestBody {
  body: { recordsets: string[] } = { recordsets: [] };
  withRecordsetIds(recordsetIds: string[]): this {
    this.body.recordsets = recordsetIds;
    return this;
  }
}

class BatchDeleteRecordSetWithLineRequest {
  zoneId = "";
  body?: BatchDeleteRecordSetWithLineRequestBody;
  withZoneId(zoneId: string): this {
    this.zoneId = zoneId;
    return this;
  }
  withBody(body: BatchDeleteRecordSetWithLineRequestBody): this {
    this.body = body;
    return this;
  }
}

/** Minimal stand-in for `@huaweicloud/huaweicloud-sdk-dns`'s `DnsClient`. */
class DnsClient {
  private readonly credentials: HuaweiCredentials;
  private readonly baseUrl: string;

  constructor(credentials: HuaweiCredentials) {
    this.credentials = credentials;
    // Overridable for the integration fixture and for private endpoints.
    this.baseUrl = process.env.HUAWEI_DNS_API_BASE || `https://dns.${credentials.region}.myhuaweicloud.com`;
  }

  async listPublicZones(request: ListPublicZonesRequest): Promise<ListPublicZonesResponse> {
    return this.request<ListPublicZonesResponse>("GET", "/v2/zones", request.params);
  }

  async listRecordSetsWithLine(request: ListRecordSetsWithLineRequest): Promise<ListRecordSetsResponse> {
    return this.request<ListRecordSetsResponse>("GET", "/v2.1/recordsets", request.params);
  }

  async createRecordSetWithLine(request: CreateRecordSetWithLineRequest): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/v2.1/zones/${request.zoneId}/recordsets`,
      undefined,
      request.body?.body,
    );
  }

  async updateRecordSets(request: UpdateRecordSetsRequest): Promise<unknown> {
    return this.request<unknown>(
      "PUT",
      `/v2.1/zones/${request.zoneId}/recordsets/${request.recordsetId}`,
      undefined,
      request.body?.body,
    );
  }

  async deleteRecordSets(request: DeleteRecordSetsRequest): Promise<unknown> {
    return this.request<unknown>(
      "DELETE",
      `/v2.1/zones/${request.zoneId}/recordsets/${request.recordsetId}`,
      undefined,
    );
  }

  async batchDeleteRecordSetWithLine(request: BatchDeleteRecordSetWithLineRequest): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/v2.1/zones/${request.zoneId}/recordsets/batch-delete`,
      undefined,
      request.body?.body,
    );
  }

  /** Huawei Cloud AK/SK (`SDK-HMAC-SHA256`) signed request. */
  private async request<T>(method: string, path: string, params?: QueryParams, body?: unknown): Promise<T> {
    const query = canonicalQuery(params ?? {});
    const payload = body === undefined ? "" : JSON.stringify(body);
    const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;

    const xSdkDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const headers: Record<string, string> = {
      "content-type": "application/json;charset=utf8",
      host: `dns.${this.credentials.region}.myhuaweicloud.com`,
      "x-sdk-date": xSdkDate,
    };

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = `${signedHeaderNames.map((name) => `${name}:${headers[name]}`).join("\n")}\n`;
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, sha256Hex(payload)].join(
      "\n",
    );
    const stringToSign = ["SDK-HMAC-SHA256", xSdkDate, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = this.signingKey(xSdkDate);
    const signature = hmacSha256(signingKey, stringToSign).toString("hex");
    headers.authorization = `SDK-HMAC-SHA256 Access=${this.credentials.accessKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await axios.request<T>({
      method,
      url,
      data: payload === "" ? undefined : payload,
      headers,
      timeout: 15_000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return response.data;
  }

  private signingKey(xSdkDate: string): Buffer {
    const date = xSdkDate.slice(0, 8);
    const kDate = hmacSha256(`SDK${this.credentials.secretKey}`, date);
    const kRegion = hmacSha256(kDate, this.credentials.region);
    const kService = hmacSha256(kRegion, DNS_SERVICE);
    return hmacSha256(kService, "sdk_request");
  }
}

export class HuaweiDNSProvider implements DNSProvider {
  domain: string;
  client: DnsClient;
  rootDomain: string;

  constructor(domain: string, config: DNSProviderConfig) {
    this.domain = domain;
    this.rootDomain = getRootDomain(domain);
    const credentials: HuaweiCredentials = {
      accessKey: config.access_key,
      secretKey: config.secret_key,
      projectId: config.project_id,
      region: config.region_id,
    };
    this.client = new DnsClient(credentials);
  }

  async getZoneId(): Promise<string> {
    const request = new ListPublicZonesRequest().withName(this.rootDomain).withLimit(100).withOffset(0);
    const response = await this.client.listPublicZones(request);
    if (response.zones?.length === 0) {
      throw new HTTPException(400, {
        message: `域名 ${this.rootDomain} 未在华为云中找到`,
      });
    }
    return response.zones?.[0]?.id ?? "";
  }

  async listRecords(): Promise<DNSRecord[]> {
    const request = new ListRecordSetsWithLineRequest().withName(this.domain).withLimit(500).withOffset(0);
    const response = await this.client.listRecordSetsWithLine(request);
    const fqdn = `${this.domain}.`;
    const records: DNSRecord[] = [];
    for (const recordset of response.recordsets ?? []) {
      if (recordset.name !== fqdn && recordset.name !== this.domain) continue;
      if (recordset.type !== "A" && recordset.type !== "AAAA") continue;
      for (const ip of recordset.records ?? []) {
        records.push({ ip, type: recordset.type });
      }
    }
    return records;
  }

  async createRecord(
    ip: string,
    type: DNSRecordType,
    ttl?: number,
    weight?: number,
    line?: string,
  ): Promise<boolean> {
    try {
      const zoneId = await this.getZoneId();
      const body = new CreateRecordSetWithLineRequestBody()
        .withName(this.domain)
        .withType(type)
        .withWeight(weight)
        .withTtl(typeof ttl === "number" ? ttl : 60)
        .withRecords([ip]);
      if (line) {
        body.withLine(line);
      }
      const request = new CreateRecordSetWithLineRequest().withZoneId(zoneId).withBody(body);
      await this.client.createRecordSetWithLine(request);
      return true;
    } catch (error) {
      logger.error(error, `Failed to create record: ${ip} ${type} ${ttl} ${weight} ${line}`);
      return false;
    }
  }

  async getRecordsetId(ip: string): Promise<string | null> {
    const request = new ListRecordSetsWithLineRequest()
      .withName(this.domain)
      .withRecords(ip)
      .withLimit(100)
      .withOffset(0);
    const response = await this.client.listRecordSetsWithLine(request);
    const fqdn = `${this.domain}.`;
    for (const recordset of response.recordsets ?? []) {
      if (recordset.name !== fqdn && recordset.name !== this.domain) continue;
      if (!recordset.records?.includes(ip)) continue;
      return recordset.id ?? null;
    }
    return null;
  }

  async updateRecord(
    oldIp: string,
    newIp: string,
    type: DNSRecordType,
    ttl?: number,
    weight?: number,
    _line?: string,
  ): Promise<void> {
    try {
      const zoneId = await this.getZoneId();
      const recordsetId = await this.getRecordsetId(oldIp);
      if (!recordsetId) {
        throw new HTTPException(400, { message: `DNS 记录 ${oldIp} 不存在` });
      }
      const body = new UpdateRecordSetsReq()
        .withName(this.domain)
        .withType(type)
        .withWeight(weight)
        .withTtl(typeof ttl === "number" ? ttl : 60)
        .withRecords([newIp]);
      const request = new UpdateRecordSetsRequest()
        .withZoneId(zoneId)
        .withRecordsetId(recordsetId)
        .withBody(body);
      await this.client.updateRecordSets(request);
    } catch (error) {
      logger.error(error, `Failed to update record: ${oldIp} -> ${newIp} ${type} ${ttl} ${weight}`);
    }
  }

  async deleteRecord(ip: string): Promise<boolean> {
    try {
      const recordsetId = await this.getRecordsetId(ip);
      if (!recordsetId) {
        return true;
      }
      const zoneId = await this.getZoneId();
      const request = new DeleteRecordSetsRequest().withZoneId(zoneId).withRecordsetId(recordsetId);
      await this.client.deleteRecordSets(request);
      return true;
    } catch (error) {
      logger.error(error, `Failed to delete record: ${ip}`);
      return false;
    }
  }

  async deleteRecords(): Promise<void> {
    const request = new ListRecordSetsWithLineRequest().withName(this.domain).withLimit(100).withOffset(0);
    const response = await this.client.listRecordSetsWithLine(request);
    const fqdn = `${this.domain}.`;
    const recordsetIds =
      response.recordsets
        ?.filter((recordset) => recordset.name === fqdn || recordset.name === this.domain)
        .map((recordset) => recordset.id ?? "")
        .filter(Boolean) ?? [];
    if (recordsetIds.length === 0) {
      return;
    }
    const zoneId = await this.getZoneId();
    const deleteRequest = new BatchDeleteRecordSetWithLineRequest()
      .withZoneId(zoneId)
      .withBody(new BatchDeleteRecordSetWithLineRequestBody().withRecordsetIds(recordsetIds));
    await this.client.batchDeleteRecordSetWithLine(deleteRequest);
  }
}
