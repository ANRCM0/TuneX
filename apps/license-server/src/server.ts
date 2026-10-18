/**
 * Process bootstrap: bind a Hono app to a Node HTTP server.
 *
 * Kept separate from `index.ts` so tests (and the CLI) can start a server on an ephemeral
 * port and shut it down deterministically.
 */

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { Hono } from "hono";
import { DEFAULT_HOST, DEFAULT_PORT } from "./config";

export interface StartLicenseServerOptions {
  host?: string;
  port?: number;
}

export interface RunningLicenseServer {
  readonly host: string;
  readonly port: number;
  /** Base URL, e.g. `http://127.0.0.1:3100` — what the panel should put in LICENSE_URL. */
  readonly url: string;
  close(): Promise<void>;
}

/** Start listening. Rejects on bind errors (EADDRINUSE, EACCES, …). */
export function startLicenseServer(
  app: Hono,
  options: StartLicenseServerOptions = {},
): Promise<RunningLicenseServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;

  return new Promise<RunningLicenseServer>((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, hostname: host, port: requestedPort },
      (info) => {
        resolve({
          host,
          port: info.port,
          url: `http://${host}:${info.port}`,
          close: () => closeServer(server),
        });
      },
    ) as unknown as Server;

    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Drop keep-alive sockets so `close()` cannot hang on a lingering client.
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
