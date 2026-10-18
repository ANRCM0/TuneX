import type { Server } from "socket.io";

/** Upstream: src/services/io-registry.ts (11 lines) — ported verbatim. */
let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function getIo(): Server {
  if (!io) {
    throw new Error("Socket.IO server not initialized");
  }
  return io;
}
