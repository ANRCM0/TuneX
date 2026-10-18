import type { Socket } from "socket.io";
import { logger } from "../../logger";
import { redisService } from "../../services/redis";

/**
 * Upstream: src/socket-io/handlers/disconnect.ts (17 decompiled lines) — ported 1:1.
 *
 * Upstream calls `queueDefault.add("notify_node_disconnect", { node_id }, { delay: 60000 })`
 * directly. `src/bullmq/queue.ts` belongs to another vertical and is still a placeholder in
 * this replica, so the enqueue is resolved dynamically and tolerated when the queue module
 * is not available (no Redis / not yet ported). Deviation recorded in docs/DEVIATIONS.md.
 */

const NOTIFY_NODE_DISCONNECT_DELAY_MS = 60 * 1000;

async function enqueueNodeDisconnect(node_id: number): Promise<void> {
  try {
    const mod = (await import("../../bullmq/queue")) as unknown as {
      queue?: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
      queueDefault?: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
      default?: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
    };
    const queue = mod.queue ?? mod.queueDefault ?? mod.default;
    await queue?.add(
      "notify_node_disconnect",
      { node_id },
      { delay: NOTIFY_NODE_DISCONNECT_DELAY_MS },
    );
  } catch (e) {
    logger.error(e, "Failed to enqueue notify_node_disconnect");
  }
}

export function disconnect(socket: Socket): void {
  socket.on("disconnect", async () => {
    const node_id = await redisService.getSocketIdNodeId(socket.id);
    if (node_id) {
      await redisService.delSocketIdNodeId(socket.id);
      await enqueueNodeDisconnect(Number(node_id));
    }
  });
}
