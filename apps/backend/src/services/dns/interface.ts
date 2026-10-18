/**
 * Upstream: src/services/dns/interface.ts.
 *
 * The decompiled original only preserved `getRootDomain` (the TS interface itself is
 * erased at build time). The provider contract below is reconstructed from the call
 * sites in `src/services/in_node_group_dns.ts` (module 025): `listRecords`,
 * `createRecord`, `updateRecord`, `deleteRecord`, `deleteRecords`.
 */

export type DNSRecordType = "A" | "AAAA";

/** A single DNS record as the sync service sees it (`ip` + record type). */
export interface DNSRecord {
  ip: string;
  type: string;
}

/**
 * `DNSProvider.config` is a plaintext JSON column (see relayx-analysis/reports/
 * DNS_AUTOMATION.md §1); the request schema constrains it to string values.
 */
export type DNSProviderConfig = Record<string, string>;

/** Provider surface used by InNodeGroupDNSService. */
export interface DNSProvider {
  listRecords(): Promise<DNSRecord[]>;
  createRecord(
    ip: string,
    type: DNSRecordType,
    ttl?: number,
    weight?: number,
    line?: string,
  ): Promise<boolean>;
  updateRecord(
    oldIp: string,
    newIp: string,
    type: DNSRecordType,
    ttl?: number,
    weight?: number,
    line?: string,
  ): Promise<void>;
  deleteRecord(ip: string): Promise<boolean>;
  deleteRecords(): Promise<void>;
}

/** Upstream: `function getRootDomain(domain) { return domain.split(".").slice(-2).join("."); }` */
export function getRootDomain(domain: string): string {
  return domain.split(".").slice(-2).join(".");
}
