import type { Socket } from "socket.io";
import { Status } from "@prisma/client";
import { db } from "../../db";
import { redisService, type NodeInfo } from "../../services/redis";
import { getNode } from "../utils";

/**
 * Upstream: src/socket-io/handlers/sysinfo.ts (43 decompiled lines) — ported 1:1.
 */

const NODE_INFO_TTL_MS = 30000;

export function sysinfo(socket: Socket): void {
  socket.on("sysinfo", async (data: Record<string, any>) => {
    const { node_id } = getNode(socket, data);
    const { sysinfo } = data;
    try {
      const cached = socket.data.nodeInfo as
        | { node_id: string; node: NodeInfo; cached_at: number }
        | undefined;
      let node: NodeInfo | null =
        cached && cached.node_id === node_id && Date.now() - cached.cached_at < NODE_INFO_TTL_MS
          ? cached.node
          : null;
      if (!node) {
        node = await redisService.getNodeInfo(node_id);
        if (!node) {
          const dbNode = await db.node.findUnique({
            where: { node_id },
            select: {
              id: true,
              node_group_id: true,
              status: true,
            },
          });
          if (!dbNode) {
            return;
          }
          node = { node_id, ...dbNode };
          await redisService.setNodeInfo(node_id, node);
        }
        socket.data.nodeInfo = { node_id, node, cached_at: Date.now() };
      }
      const node_db_id = node.id as number;
      const node_group_id = node.node_group_id as number;
      const node_status = node.status as Status;
      if (
        node_status === Status.active &&
        !socket.rooms.has(`node_group/${node_group_id}`)
      ) {
        await socket.join(`node_group/${node_group_id}`);
      } else if (
        node_status === Status.inactive &&
        socket.rooms.has(`node_group/${node_group_id}`)
      ) {
        await socket.leave(`node_group/${node_group_id}`);
      }
      await redisService.setSysinfo(node_group_id, node_db_id, sysinfo);
    } catch {
      return;
    }
  });
}
