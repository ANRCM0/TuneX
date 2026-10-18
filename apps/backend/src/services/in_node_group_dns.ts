import net from "node:net";
import type { z } from "zod";
import { NodeType, Status, type NodeGroup, type Prisma } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { db } from "../db";
import { logger } from "../logger";
import { service } from "../container";
import {
  InNodeGroupDNSQuerySchema,
  InNodeGroupDNSRequestSchema,
} from "../schemas/request";
import { getDNSProvider } from "./dns";
import type { DNSProvider, DNSRecordType } from "./dns/interface";
import { redisService, type RedisService } from "./redis";

/**
 * Upstream: src/services/in_node_group_dns.ts (module 025) — ported 1:1.
 *
 * Keeps DNS records for `in` node groups in sync with the provider: manual sync
 * (`/in_node_group_dns/:id/sync`), IP-change reconciliation during the socket.io
 * register handshake (`updateNodeDnsRecords`), node removal (`nodeDnsRecords`) and the
 * periodic cron sweep (`cronSyncNodeDNS` → `reconcileNodeDNS`), which is guarded by the
 * Redis lock `sync_node_dns:lock` so concurrent runs cannot duplicate records.
 */

/** A/AAAA selection used by every record-synthesis path. */
export function dnsRecordType(ip: string, ipv6: boolean): DNSRecordType | null {
  if (net.isIPv4(ip)) {
    return "A";
  }
  if (net.isIPv6(ip) && ipv6) {
    return "AAAA";
  }
  return null;
}

/** `custom_line` is keyed by `node.id`; an absent/blank entry clears the node's line. */
export function nodeCustomLine(
  customLine: Record<string, string> | null | undefined,
  nodeId: number,
): string | null {
  return customLine?.[nodeId.toString()] ?? null;
}

export type InNodeGroupDNSData = z.infer<typeof InNodeGroupDNSRequestSchema>;
export type InNodeGroupDNSQuery = z.infer<typeof InNodeGroupDNSQuerySchema>;
export type DNSNodeGroup = Pick<NodeGroup, "id" | "connect_ip">;

export class InNodeGroupDNSService {
  constructor(private readonly redisService: RedisService) {}

  async createInNodeGroupDNS(user_id: number, data: InNodeGroupDNSData) {
    const nodeGroup = await db.nodeGroup.findFirst({
      where: {
        id: data.in_node_group_id,
        user_id,
        node_type: NodeType.in,
      },
    });
    if (!nodeGroup) {
      throw new HTTPException(404, { message: "入口节点组不存在" });
    }
    if (!nodeGroup.connect_ip) {
      throw new HTTPException(400, { message: "入口节点组未设置连接域名" });
    }
    const dnsProvider = await db.dNSProvider.findFirst({
      where: { id: data.dns_provider_id, user_id },
    });
    if (!dnsProvider) {
      throw new HTTPException(404, { message: "DNS 授权配置不存在" });
    }
    const result = await db.inNodeGroupDNS.create({
      data: {
        in_node_group_id: data.in_node_group_id,
        dns_provider_id: data.dns_provider_id,
        ttl: data.ttl,
        ipv6: data.ipv6,
        status: data.status,
      },
    });
    await this.syncNodeCustomLines(data.in_node_group_id, data.custom_line);
    return result;
  }

  async getInNodeGroupDNSList(user_id: number, query: InNodeGroupDNSQuery) {
    const { page, perPage, sort, in_node_group_id, dns_provider_id, status } = query;
    const orderBy = sort?.map((sort2: { id: string; desc?: boolean }) => ({
      [sort2.id]: sort2.desc ? "desc" : "asc",
    })) as Prisma.InNodeGroupDNSOrderByWithRelationInput[] | undefined;
    const where: Prisma.InNodeGroupDNSWhereInput = {
      in_node_group: {
        user_id,
      },
    };
    if (in_node_group_id) {
      where.in_node_group_id = in_node_group_id;
    }
    if (dns_provider_id) {
      where.dns_provider_id = dns_provider_id;
    }
    if (status) {
      where.status = status;
    }
    return await db.$transaction(async (tx) => {
      const data = await tx.inNodeGroupDNS.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ id: "desc" }],
        include: {
          in_node_group: {
            select: {
              id: true,
              name: true,
              connect_ip: true,
              nodes: {
                select: {
                  id: true,
                  node_id: true,
                  custom_line: true,
                  dns_status: true,
                },
              },
            },
          },
          dns_provider: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
        },
      });
      const total = await tx.inNodeGroupDNS.count({ where });
      return { data, total };
    });
  }

  async updateInNodeGroupDNS(user_id: number, id: number, data: InNodeGroupDNSData) {
    const existing = await db.inNodeGroupDNS.findFirst({
      where: {
        id,
        in_node_group: {
          user_id,
        },
      },
    });
    if (!existing) {
      throw new HTTPException(404, { message: "入口保活配置不存在" });
    }
    const result = await db.inNodeGroupDNS.update({
      where: { id },
      data: {
        in_node_group_id: data.in_node_group_id,
        dns_provider_id: data.dns_provider_id,
        ttl: data.ttl,
        ipv6: data.ipv6,
        status: data.status,
      },
    });
    await this.syncNodeCustomLines(data.in_node_group_id, data.custom_line);
    return result;
  }

  async syncNodeCustomLines(
    node_group_id: number,
    custom_line: Record<string, string> | null | undefined,
  ) {
    const nodes = await db.node.findMany({
      where: { node_group_id },
      select: { id: true },
    });
    for (const node of nodes) {
      await db.node.update({
        where: { id: node.id },
        data: { custom_line: nodeCustomLine(custom_line, node.id) },
      });
    }
  }

  async deleteInNodeGroupDNS(user_id: number, ids: number[]) {
    await db.inNodeGroupDNS.deleteMany({
      where: {
        id: { in: ids },
        in_node_group: {
          user_id,
        },
      },
    });
  }

  /**
   * Called by the network vertical during the socket.io register handshake when an
   * `in` node's `connect_ip` changes. Reuses existing records pair-wise (update) and
   * creates/deletes the leftovers.
   */
  async updateNodeDnsRecords(
    in_node_group: DNSNodeGroup,
    oldIps: string[],
    newIps: string[],
    weight: number,
    customLine: string | null,
  ): Promise<void> {
    if (!in_node_group.connect_ip) {
      return;
    }
    const newIpSet = new Set(newIps);
    if (oldIps.length === newIps.length && oldIps.every((ip) => newIpSet.has(ip))) {
      return;
    }
    const inNodeGroupDNSs = await db.inNodeGroupDNS.findMany({
      where: {
        in_node_group_id: in_node_group.id,
        status: Status.active,
      },
      include: {
        dns_provider: true,
      },
    });
    if (inNodeGroupDNSs.length === 0) {
      return;
    }
    const oldV4 = oldIps.filter((ip) => net.isIPv4(ip));
    const newV4 = newIps.filter((ip) => net.isIPv4(ip));
    const oldV6 = oldIps.filter((ip) => net.isIPv6(ip));
    const newV6 = newIps.filter((ip) => net.isIPv6(ip));
    const line = customLine ?? undefined;
    for (const inNodeGroupDNS of inNodeGroupDNSs) {
      const provider = getDNSProvider(
        inNodeGroupDNS.dns_provider.type,
        in_node_group.connect_ip,
        inNodeGroupDNS.dns_provider.config,
      );
      const ttl = inNodeGroupDNS.ttl;
      await this.syncIpSet(provider, oldV4, newV4, "A", ttl, weight, line);
      if (inNodeGroupDNS.ipv6) {
        await this.syncIpSet(provider, oldV6, newV6, "AAAA", ttl, weight, line);
      }
    }
  }

  async syncIpSet(
    provider: DNSProvider,
    oldIps: string[],
    newIps: string[],
    type: DNSRecordType,
    ttl: number,
    weight: number,
    line?: string,
  ): Promise<void> {
    const newSet = new Set(newIps);
    const oldSet = new Set(oldIps);
    const toDelete = oldIps.filter((ip) => !newSet.has(ip));
    const toCreate = newIps.filter((ip) => !oldSet.has(ip));
    const pairs = Math.min(toDelete.length, toCreate.length);
    for (let i = 0; i < pairs; i++) {
      await provider.updateRecord(toDelete[i], toCreate[i], type, ttl, weight, line);
    }
    for (let i = pairs; i < toDelete.length; i++) {
      await provider.deleteRecord(toDelete[i]);
    }
    for (let i = pairs; i < toCreate.length; i++) {
      await provider.createRecord(toCreate[i], type, ttl, weight, line);
    }
  }

  async nodeDnsRecords(
    in_node_group: DNSNodeGroup,
    ips: string[],
    type: "create" | "delete",
    weight: number,
    nodeId?: number | null,
    customLine?: string | null,
  ): Promise<void> {
    if (!in_node_group.connect_ip) {
      return;
    }
    const inNodeGroupDNSs = await db.inNodeGroupDNS.findMany({
      where: {
        in_node_group_id: in_node_group.id,
        status: Status.active,
      },
      include: {
        dns_provider: true,
      },
    });
    if (inNodeGroupDNSs.length === 0) {
      return;
    }
    for (const inNodeGroupDNS of inNodeGroupDNSs) {
      const provider = getDNSProvider(
        inNodeGroupDNS.dns_provider.type,
        in_node_group.connect_ip,
        inNodeGroupDNS.dns_provider.config,
      );
      const ttl = inNodeGroupDNS.ttl;
      const line = customLine ?? undefined;
      for (const ip of ips) {
        const recordType = dnsRecordType(ip, inNodeGroupDNS.ipv6);
        if (!recordType) {
          continue;
        }
        if (type === "create") {
          await provider.createRecord(ip, recordType, ttl, weight, line);
        } else {
          await provider.deleteRecord(ip);
        }
      }
    }
    if (nodeId) {
      await db.node.update({
        where: { id: nodeId },
        data: { dns_status: type === "create" },
      });
    }
  }

  async syncDNSRecords(user_id: number, id: number) {
    const inNodeGroupDNS = await db.inNodeGroupDNS.findFirst({
      where: {
        id,
        status: Status.active,
        in_node_group: {
          user_id,
        },
      },
      include: {
        in_node_group: {
          select: {
            connect_ip: true,
            nodes: {
              where: {
                status: Status.active,
              },
            },
          },
        },
        dns_provider: true,
      },
    });
    if (!inNodeGroupDNS) {
      throw new HTTPException(404, { message: "入口保活配置不存在或未启用" });
    }
    const domain = inNodeGroupDNS.in_node_group.connect_ip;
    if (!domain) {
      throw new HTTPException(400, { message: "入口节点组未配置连接域名" });
    }
    const provider = getDNSProvider(
      inNodeGroupDNS.dns_provider.type,
      domain,
      inNodeGroupDNS.dns_provider.config,
    );
    const nodes = inNodeGroupDNS.in_node_group.nodes;
    const ipv6 = inNodeGroupDNS.ipv6;
    const ttl = inNodeGroupDNS.ttl;
    await provider.deleteRecords();
    const normalNodes = nodes.filter((n) => !n.backup);
    const backupNodes = nodes.filter((n) => n.backup);
    const hasAliveNormalNode = (
      await Promise.all(normalNodes.map((n) => this.redisService.nodeIsAlive(n.node_group_id, n.id)))
    ).some(Boolean);
    const nodesToSync = [...normalNodes, ...(hasAliveNormalNode ? [] : backupNodes)];
    for (const node of nodesToSync) {
      if (!(await this.redisService.nodeIsAlive(node.node_group_id, node.id))) {
        continue;
      }
      const ips = node.connect_ip.split(",");
      const line = node.custom_line ?? undefined;
      for (const ip of ips) {
        const recordType = dnsRecordType(ip, ipv6);
        if (!recordType) {
          continue;
        }
        await provider.createRecord(ip, recordType, ttl, node.weight, line);
      }
    }
    return { synced: nodes.length };
  }

  async cronSyncNodeDNS(): Promise<void> {
    if (!(await this.redisService.tryLockSyncNodeDNS())) {
      logger.warn("cronSyncNodeDNS: previous round still running, skipping");
      return;
    }
    try {
      await this.reconcileNodeDNS();
    } finally {
      await this.redisService.unlockSyncNodeDNS();
    }
  }

  async reconcileNodeDNS(): Promise<void> {
    const inNodeGroupDNSs = await db.inNodeGroupDNS.findMany({
      where: { status: Status.active },
      include: {
        in_node_group: {
          include: { nodes: true },
        },
        dns_provider: true,
      },
    });
    const aliveMap = new Map<number, boolean>();
    for (const inNodeGroupDNS of inNodeGroupDNSs) {
      for (const node of inNodeGroupDNS.in_node_group.nodes) {
        if (aliveMap.has(node.id)) continue;
        const isAlive =
          node.status === Status.active &&
          (await this.redisService.nodeIsAlive(node.node_group_id, node.id));
        aliveMap.set(node.id, isAlive);
      }
    }
    const dnsStatus = new Map<number, boolean>();
    const unknown = new Set<number>();
    const currentStatus = new Map<number, boolean>();
    for (const inNodeGroupDNS of inNodeGroupDNSs) {
      const nodeGroup = inNodeGroupDNS.in_node_group;
      if (!nodeGroup.connect_ip) continue;
      const provider = getDNSProvider(
        inNodeGroupDNS.dns_provider.type,
        nodeGroup.connect_ip,
        inNodeGroupDNS.dns_provider.config,
      );
      let actualIps: Set<string>;
      try {
        actualIps = new Set((await provider.listRecords()).map((record) => record.ip));
      } catch (error) {
        logger.error(
          error,
          `cronSyncNodeDNS: failed to list records for config ${inNodeGroupDNS.id}`,
        );
        for (const node of nodeGroup.nodes) {
          unknown.add(node.id);
        }
        continue;
      }
      const hasAliveNormalNode = nodeGroup.nodes.some(
        (node) => !node.backup && aliveMap.get(node.id),
      );
      for (const node of nodeGroup.nodes) {
        currentStatus.set(node.id, node.dns_status);
        const isAlive = aliveMap.get(node.id) ?? false;
        const shouldBeInDNS = node.backup ? isAlive && !hasAliveNormalNode : isAlive;
        const ips = node.connect_ip
          .split(",")
          .filter((ip) => net.isIPv4(ip) || (net.isIPv6(ip) && inNodeGroupDNS.ipv6));
        let hasRecords: boolean;
        if (shouldBeInDNS) {
          let synced = true;
          for (const ip of ips) {
            if (actualIps.has(ip)) continue;
            const created = await provider.createRecord(
              ip,
              net.isIPv4(ip) ? "A" : "AAAA",
              inNodeGroupDNS.ttl,
              node.weight,
              node.custom_line ?? undefined,
            );
            if (!created) synced = false;
          }
          hasRecords = synced;
        } else {
          let cleaned = true;
          for (const ip of ips) {
            if (!actualIps.has(ip)) continue;
            const deleted = await provider.deleteRecord(ip);
            if (!deleted) cleaned = false;
          }
          hasRecords = !cleaned;
        }
        const prev = dnsStatus.get(node.id);
        dnsStatus.set(
          node.id,
          shouldBeInDNS ? (prev ?? true) && hasRecords : (prev ?? false) || hasRecords,
        );
      }
      const groupIps = new Set(nodeGroup.nodes.flatMap((node) => node.connect_ip.split(",")));
      for (const ip of actualIps) {
        if (groupIps.has(ip)) continue;
        await provider.deleteRecord(ip);
      }
    }
    for (const [nodeId, status] of dnsStatus) {
      if (unknown.has(nodeId)) continue;
      if (currentStatus.get(nodeId) === status) continue;
      await db.node.update({
        where: { id: nodeId },
        data: { dns_status: status },
      });
    }
  }
}

/** Self-registration (container has no dedicated in-node-group DNS token). */
export const inNodeGroupDNSService = service<InNodeGroupDNSService>(
  "InNodeGroupDNSService",
  () => new InNodeGroupDNSService(redisService),
);
