import { HTTPException } from "hono/http-exception";
import { NodeType } from "@prisma/client";
import { db, type Prisma } from "../db";
import { service, TOKENS, instance } from "../container";
import { redisService, type RedisService } from "./redis";

/**
 * Upstream: src/services/node_group.ts (393 decompiled lines) — ported 1:1.
 *
 * Deviations: `lodash.isEmpty(where)` (a plain-object key check) is inlined. `where.OR`
 * is always present on the recovered object, so the guard only fires for the empty shape.
 */

const DEBUG_NODE_GROUP_SELECT = {
  id: true,
  user_id: true,
  name: true,
  node_type: true,
  traffic_rate: true,
  need_out_node_group: true,
  allow_tunnel_types: true,
  allow_out_node_groups: true,
  allow_in_node_groups: true,
  block_protocols: true,
  allow_listen_protocol: true,
  allow_listen_protocols: true,
  admission: true,
} as const;

export class NodeGroupService {
  constructor(private readonly redisService: RedisService) {}

  async checkUserNodeGroup(
    user: { id: number },
    in_node_group_id: number,
    out_node_group_id?: number | null,
  ): Promise<void> {
    const groups = await this.getUserNodeGroups(user);
    const in_node_group = groups.find((group) => group.id === in_node_group_id);
    const out_node_group = out_node_group_id
      ? groups.find((group) => group.id === out_node_group_id)
      : null;
    if (!in_node_group || (out_node_group_id && !out_node_group)) {
      throw new HTTPException(403, { message: "节点组无权限" });
    }
    if (out_node_group_id && in_node_group.allow_out_node_groups) {
      const allowedOutNodeGroups = in_node_group.allow_out_node_groups as number[];
      if (!allowedOutNodeGroups.includes(out_node_group_id)) {
        throw new HTTPException(403, {
          message: "该入口节点组不允许使用此出口节点组",
        });
      }
    }
  }

  async getUserNodeGroups(user: { id: number; super_admin?: boolean }) {
    const user_plan = await db.userPlan.findUnique({
      where: {
        user_id: user.id,
        OR: [
          {
            expired_at: {
              gt: new Date(),
            },
          },
          {
            expired_at: null,
          },
        ],
      },
      include: {
        plan: true,
      },
    });
    if (!user_plan) {
      return [];
    }
    const user_traffic = user_plan.traffic_used;
    if (user_plan.plan.traffic && user_traffic >= user_plan.plan.traffic) {
      return [];
    }
    const plan = user_plan.plan;
    const all_in_node_groups = plan.all_in_node_groups;
    const all_out_node_groups = plan.all_out_node_groups;
    const allow_custom_in_node_group = plan.allow_custom_in_node_group;
    const allow_custom_out_node_group = plan.allow_custom_out_node_group;
    const where: Prisma.NodeGroupWhereInput = { OR: [] };
    if (allow_custom_in_node_group) {
      where.OR?.push({
        node_type: NodeType.in,
        user_id: user.id,
      });
    }
    if (allow_custom_out_node_group) {
      where.OR?.push({
        node_type: NodeType.out,
        user_id: user.id,
      });
    }
    if (all_in_node_groups) {
      where.OR?.push({
        node_type: NodeType.in,
        user: {
          super_admin: true,
        },
      });
    } else {
      const ids = await db.planNodeGroup.findMany({
        where: {
          plan_id: user_plan.plan_id,
          node_group: {
            node_type: NodeType.in,
          },
        },
        select: {
          node_group_id: true,
        },
      });
      if (ids.length > 0) {
        where.OR?.push({
          id: {
            in: ids.map((item) => item.node_group_id),
          },
        });
      }
    }
    if (all_out_node_groups) {
      where.OR?.push({
        node_type: NodeType.out,
        user: {
          super_admin: true,
        },
      });
    } else {
      const ids = await db.planNodeGroup.findMany({
        where: {
          plan_id: user_plan.plan_id,
          node_group: {
            node_type: NodeType.out,
          },
        },
        select: {
          node_group_id: true,
        },
      });
      if (ids.length > 0) {
        where.OR?.push({
          id: {
            in: ids.map((item) => item.node_group_id),
          },
        });
      }
    }
    if (Object.keys(where).length === 0) {
      return [];
    }
    const nodeGroups = await db.nodeGroup.findMany({
      where,
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
      select: DEBUG_NODE_GROUP_SELECT,
    });
    const nodes = await db.node.groupBy({
      where: {
        node_group_id: { in: nodeGroups.map((item) => item.id) },
      },
      by: ["node_group_id"],
      _count: true,
    });
    return nodeGroups.map((item) => ({
      ...item,
      node_count: nodes.find((node) => node.node_group_id === item.id)?._count,
    }));
  }

  async getAdminNodeGroupSummary() {
    return await db.nodeGroup.findMany({
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        node_type: true,
        traffic_rate: true,
        need_out_node_group: true,
        allow_tunnel_types: true,
        allow_out_node_groups: true,
        allow_in_node_groups: true,
        block_protocols: true,
        allow_listen_protocol: true,
        allow_listen_protocols: true,
        admission: true,
      },
    });
  }

  async createNodeGroup(user_id: number, data: Record<string, any>): Promise<void> {
    const {
      name,
      node_type,
      traffic_rate,
      load_balance_type,
      connect_ip,
      need_out_node_group,
      allow_tunnel_types,
      port_range,
      allow_out_node_groups,
      allow_in_node_groups,
      block_protocols,
      allow_listen_protocol,
      allow_listen_protocols,
      bypass_type,
      bypass_list,
      admission,
    } = data;
    this.checkPortRange(port_range);
    await db.nodeGroup.create({
      data: {
        name,
        node_type,
        traffic_rate: traffic_rate || 1,
        load_balance_type,
        user_id,
        connect_ip,
        need_out_node_group,
        allow_tunnel_types,
        port_range,
        allow_out_node_groups,
        allow_in_node_groups,
        block_protocols,
        allow_listen_protocol,
        allow_listen_protocols,
        bypass_type,
        bypass_list,
        admission,
        order_by: (await db.nodeGroup.count()) * 1000,
      },
    });
  }

  async getNodeGroups(query: Record<string, any>, user_id?: number | null) {
    const { page, perPage, sort, name, connect_ip, node_type, email } = query;
    const orderBy = sort?.map((sort2: { id: string; desc: boolean }) => {
      return {
        [sort2.id]: sort2.desc ? "desc" : "asc",
      };
    }) as Prisma.NodeGroupOrderByWithRelationInput[] | undefined;
    const where: Prisma.NodeGroupWhereInput = {};
    if (name) {
      where.name = {
        contains: name,
      };
    }
    if (user_id) {
      where.user_id = user_id;
    }
    if (connect_ip) {
      where.connect_ip = {
        contains: connect_ip,
      };
    }
    if (node_type) {
      where.node_type = node_type;
    }
    if (email) {
      where.user = {
        email: {
          contains: email,
        },
      };
    }
    return await db.$transaction(async (tx) => {
      const data = await tx.nodeGroup.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: orderBy || [{ order_by: "desc" }, { id: "desc" }],
        include: {
          nodes: {
            select: {
              connect_ip: true,
            },
          },
          user: {
            select: {
              email: true,
            },
          },
        },
      });
      const total = await tx.nodeGroup.count({
        where,
      });
      return {
        data,
        total,
      };
    });
  }

  async deleteNodeGroups(ids: number[], user_id?: number): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.planNodeGroup.deleteMany({
        where: {
          node_group_id: { in: ids },
        },
      });
      await tx.tunnelTraffic.deleteMany({
        where: {
          tunnel: {
            OR: [{ in_node_group_id: { in: ids } }, { out_node_group_id: { in: ids } }],
          },
        },
      });
      await tx.tunnelChain.deleteMany({
        where: {
          node_group_id: { in: ids },
        },
      });
      await tx.tunnel.deleteMany({
        where: {
          OR: [
            {
              in_node_group_id: { in: ids },
            },
            {
              out_node_group_id: { in: ids },
            },
          ],
        },
      });
      await tx.node.deleteMany({
        where: {
          node_group_id: { in: ids },
        },
      });
      await tx.nodeGroup.deleteMany({
        where: {
          id: { in: ids },
          user_id,
        },
      });
      await this.redisService.delSysinfoByNodeGroups(ids);
    });
  }

  async updateNodeGroup(id: number, data: Record<string, any>, user_id?: number): Promise<void> {
    this.checkPortRange(data.port_range);
    await db.nodeGroup.update({
      where: { id, user_id },
      data: {
        ...data,
        allow_tunnel_types: data.allow_tunnel_types,
        allow_out_node_groups: data.allow_out_node_groups,
        allow_in_node_groups: data.allow_in_node_groups,
        block_protocols: data.block_protocols,
        allow_listen_protocols: data.allow_listen_protocols,
        bypass_list: data.bypass_list,
      },
    });
  }

  async updateNodeGroupOrder(id: number, order_by: number, user_id?: number): Promise<void> {
    await db.nodeGroup.update({
      where: { id, user_id },
      data: { order_by },
    });
  }

  checkPortRange(port_range?: string | null, port?: number | null): boolean | undefined {
    if (!port_range) {
      return;
    }
    try {
      const ports = port_range.split(",").map((s) => s.trim());
      const allPorts: number[] = [];
      for (const port2 of ports) {
        if (port2.includes("-")) {
          const [start, end] = port2.split("-").map((s) => Number(s.trim()));
          if (!start || !end) {
            continue;
          }
          if (start > end) {
            throw new HTTPException(400, { message: "端口范围不合法" });
          }
          for (let i = start; i <= end; i++) {
            allPorts.push(i);
          }
        } else {
          const portNumber = Number(port2);
          if (isNaN(portNumber)) {
            continue;
          }
          allPorts.push(portNumber);
        }
      }
      if (allPorts.length === 0) {
        throw new HTTPException(400, { message: "端口范围不合法" });
      }
      if (port) {
        return allPorts.includes(port);
      }
    } catch {
      throw new HTTPException(400, { message: "端口范围不合法" });
    }
    return false;
  }
}

/** Self-registration. */
export const nodeGroupService = service<NodeGroupService>(
  TOKENS.NodeGroup,
  () => new NodeGroupService(instance.resolve<RedisService>(TOKENS.Redis)),
);
