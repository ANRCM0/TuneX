import type { Socket } from "socket.io";
import { Prisma, Status } from "@prisma/client";
import { db } from "../../db";
import { logger } from "../../logger";
import { redisService } from "../../services/redis";
import { getNode } from "../utils";

/**
 * Upstream: src/socket-io/handlers/listen.ts (88 decompiled lines) — ported 1:1,
 * including the `listen_error` handler that the upstream connection wiring also registers.
 */

async function repushTunnelGroup(tunnel_id: number): Promise<void> {
  const tunnel = await db.tunnel.findUnique({
    where: { id: tunnel_id },
    select: { category: true, in_node_group_id: true, out_node_group_id: true },
  });
  if (!tunnel) return;
  const group_id = tunnel.category === "port_forward" ? tunnel.in_node_group_id : tunnel.out_node_group_id;
  if (group_id) {
    await redisService.deleteNodeConfigHash([group_id]);
  }
}

export function listen(socket: Socket): void {
  socket.on("listen", async (data: Record<string, any>) => {
    const { port, type } = data;
    let { name } = data;
    const { node_id } = getNode(socket, data);
    const node = await db.node.findUnique({
      where: {
        node_id,
      },
      select: {
        id: true,
        node_group: {
          select: {
            node_type: true,
          },
        },
      },
    });
    if (!node) {
      return;
    }
    name = name.replace("tcp-", "").replace("udp-", "");
    const id = Number(name);
    if (isNaN(id)) {
      await redisService.setOutListen(node.id, port, type);
    } else {
      try {
        await db.tunnel.updateMany({
          where: {
            id,
            listen_port: null,
          },
          data: {
            listen_port: port,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          logger.warn(
            `Tunnel ${id} listen port ${port} conflicts with another tunnel in the same group, repushing config`,
          );
          await db.tunnel.updateMany({
            where: { id },
            data: { port_conflict_at: new Date() },
          });
          await repushTunnelGroup(id);
        } else {
          throw error;
        }
      }
    }
  });
}

export function listenError(socket: Socket): void {
  socket.on("listen_error", async (data: Record<string, any>) => {
    let name = data.name;
    const error = data.error;
    name = name.replace("tcp-", "").replace("udp-", "");
    const id = Number(name);
    if (isNaN(id)) {
      return;
    }
    if (error === "ERR_PORT_IN_USE") {
      await db.tunnel.update({
        where: {
          id,
        },
        data: {
          status: Status.inactive,
          port_conflict_at: new Date(),
        },
      });
    }
  });
}
