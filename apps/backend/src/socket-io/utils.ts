import type { Socket } from "socket.io";

/**
 * Upstream: src/socket-io/utils.ts (15 decompiled lines) — ported 1:1.
 */

export function getNode(
  socket: Socket,
  data: Record<string, any>,
): { node_id: string; connect_ips: string[] } {
  const client_ip = socket.handshake.address;
  const forwarded_for = socket.handshake.headers["x-forwarded-for"];
  const ip = Array.isArray(forwarded_for)
    ? forwarded_for[0]
    : forwarded_for
      ? forwarded_for.split(",")[0]
      : client_ip;
  let connect_ips = data.connect_ip;
  const node_id = data.node_id;
  if (!connect_ips) {
    connect_ips = [ip ?? ""];
  }
  return {
    node_id,
    connect_ips,
  };
}
