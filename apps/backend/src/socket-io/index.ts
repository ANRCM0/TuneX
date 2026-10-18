import type { Server as HttpServer } from "node:http";
import type { ServerType } from "@hono/node-server";
import { Server } from "socket.io";
import { logger } from "../logger";
import { setIo } from "../services/io-registry";
import { IO_EMIT_CHANNEL, client } from "../services/redis";
import { disconnect } from "./handlers/disconnect";
import { listen, listenError } from "./handlers/listen";
import { register } from "./handlers/register";
import { sysinfo } from "./handlers/sysinfo";

/**
 * Upstream: src/socket-io/index.ts (43 decompiled lines) — ported 1:1, adapted to the
 * replica's `attach(server)` entry point (the frozen `src/index.ts` does
 * `import { attach } from "./socket-io"` and calls `attach(server)`).
 *
 * Deviations: `@socket.io/admin-ui` (non-production `instrument(io, { auth: false })`) is
 * not in the frozen dependency set and is therefore omitted. Everything else matches:
 * CORS `https://admin.socket.io` with credentials, `addTrailingSlash: false`, `setIo(io)`,
 * the `io:emit` Redis subscriber that relays `{ room, event, args }` to `io.local`, the
 * auth middleware requiring `handshake.auth.token`, and the five connection handlers.
 */

interface IoEmitSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

export function attach(server: ServerType): Server {
  const io = new Server(server as unknown as HttpServer, {
    addTrailingSlash: false,
    cors: {
      origin: ["https://admin.socket.io"],
      credentials: true,
    },
  });
  setIo(io);

  const ioEmitSub = client.duplicate() as IoEmitSubscriber;
  ioEmitSub.subscribe(IO_EMIT_CHANNEL).catch((err) => {
    logger.error(err, "Failed to subscribe to io_emit channel");
  });
  ioEmitSub.on("message", (_channel, message) => {
    try {
      const { room, event, args } = JSON.parse(message) as {
        room: string;
        event: string;
        args?: unknown[];
      };
      io.local.to(room).emit(event, ...(args ?? []));
    } catch (err) {
      logger.error(err, "Failed to handle io_emit message");
    }
  });

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: string };
    const token = auth.token;
    if (!token) {
      return next(new Error("Unauthorized"));
    }
    socket.data.token = token;
    next();
  });

  io.on("connection", (socket) => {
    register(socket);
    listen(socket);
    listenError(socket);
    sysinfo(socket);
    disconnect(socket);
  });

  return io;
}

export default attach;
