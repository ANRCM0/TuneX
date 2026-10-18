import { HTTPException } from "hono/http-exception";
import { NodeType } from "@prisma/client";
import { AGENT_DOWNLOAD_URL } from "../config";
import { db, type Prisma } from "../db";
import { logger } from "../logger";
import { service, TOKENS } from "../container";
import { inNodeGroupDNSService } from "./in_node_group_dns";
import { redisService, type RedisService } from "./redis";

/**
 * Upstream: src/services/node.ts (148 decompiled lines) — ported 1:1.
 *
 * The `InNodeGroupDNSService` dependency is imported from its own module (owned by the
 * DNS vertical); the constructor takes the structurally-typed interface below.
 */

export interface NodeDnsService {
  nodeDnsRecords(
    nodeGroup: unknown,
    connectIps: string[],
    type: "add" | "delete",
    weight: number,
    nodeId: number,
    customLine: string | null,
  ): Promise<void>;
  updateNodeDnsRecords(
    nodeGroup: unknown,
    oldConnectIps: string[],
    newConnectIps: string[],
    weight: number,
    customLine: string | null,
  ): Promise<void>;
}

export class NodeService {
  constructor(
    private readonly redisService: RedisService,
    private readonly inNodeGroupDNSService: NodeDnsService,
  ) {}

  async checkNodeId(node_id: string): Promise<void> {
    const node = await db.node.findUnique({
      where: {
        node_id,
      },
    });
    if (node) {
      throw new HTTPException(400, {
        message: "节点 ID 已存在",
      });
    }
  }

  async nodeIsAlive(node_group_id: number, node_id: number): Promise<boolean> {
    const sysinfo = await this.redisService.getNodeSysinfo(node_group_id, node_id);
    if (!sysinfo) {
      return false;
    }
    const last_active = new Date(sysinfo.last_active ?? 0);
    return last_active >= new Date(Date.now() - 60 * 1000);
  }

  async deleteNodes(ids: number[], user_id?: number): Promise<void> {
    const nodes = await db.node.findMany({
      where: { id: { in: ids }, node_group: { user_id } },
      include: { node_group: true },
    });
    for (const node of nodes) {
      if (node.node_group.node_type === NodeType.in) {
        try {
          await this.inNodeGroupDNSService.nodeDnsRecords(
            node.node_group,
            node.connect_ip.split(","),
            "delete",
            node.weight,
            node.id,
            node.custom_line,
          );
        } catch (e) {
          logger.error(e, `Failed to delete DNS records for node ${node.id}`);
        }
      }
    }
    await db.$transaction(async (tx) => {
      for (const node of nodes) {
        await tx.node.delete({
          where: { id: node.id },
        });
        await this.redisService.delNodeSysinfo(node.node_group_id, node.id);
      }
    });
  }

  async getNodes(query: Record<string, any>, user_id?: number) {
    const { page, perPage, sort, node_group_id, ip, node_id, status, version, backup, node_type } =
      query;
    const where: Prisma.NodeWhereInput = {
      node_group: {
        user_id,
        node_type: node_type ? node_type : undefined,
      },
      node_group_id: node_group_id ? { in: node_group_id } : undefined,
      connect_ip: ip ? { contains: ip } : undefined,
      node_id: node_id ? { contains: node_id } : undefined,
      status: status ? status : undefined,
      backup: backup !== null && backup !== undefined ? backup : undefined,
    };
    const latest_agent_version = await this.redisService.getLatestAgentVersion();
    if (version !== undefined) {
      if (version) {
        where.version = { not: latest_agent_version };
      } else {
        where.version = { equals: latest_agent_version };
      }
    }
    const orderBy = sort?.map((sort2: { id: string; desc: boolean }) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    }) as Prisma.NodeOrderByWithRelationInput[] | undefined;
    const [data, total] = await db.$transaction([
      db.node.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ order_by: "desc" }, { id: "desc" }],
        where,
        include: {
          node_group: {
            select: {
              name: true,
              traffic_rate: true,
              node_type: true,
            },
          },
        },
      }),
      db.node.count({
        where,
      }),
    ]);
    return {
      data: await Promise.all(
        data.map(async (node) => {
          const sysinfo = await this.redisService.getNodeSysinfo(node.node_group_id, node.id);
          return {
            ...node,
            upgradeable: node.version !== latest_agent_version,
            last_active: sysinfo?.last_active,
          };
        }),
      ),
      total,
    };
  }

  async updateNodeOrder(id: number, order_by: number, user_id?: number): Promise<void> {
    await db.node.update({
      where: { id, node_group: { user_id } },
      data: { order_by },
    });
  }

  async upgradeAllNodes(user_id?: number): Promise<void> {
    const latest_agent_version = await this.redisService.getLatestAgentVersion();
    if (!latest_agent_version) {
      return;
    }
    const nodeGroups = await db.nodeGroup.findMany({
      where: {
        user_id,
      },
      select: {
        id: true,
      },
    });
    for (const nodeGroup of nodeGroups) {
      await this.redisService.publishIoEmit(`node_group/${nodeGroup.id}`, "upgrade", [
        AGENT_DOWNLOAD_URL,
        latest_agent_version,
      ]);
    }
  }
}

/** Self-registration. */
export const nodeService = service<NodeService>(
  TOKENS.Node,
  () =>
    new NodeService(
      redisService,
      inNodeGroupDNSService as unknown as NodeDnsService,
    ),
);
