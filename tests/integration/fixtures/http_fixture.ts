/**
 * Loopback HTTP fixture for outbound provider clients.
 *
 * The DNS and chat clients talk to fixed vendor hosts. Rather than mocking `fetch` (which
 * proves nothing about paths, headers or bodies), the tests point the clients at this server
 * through their documented `*_API_BASE` overrides and assert the real HTTP conversation.
 *
 * It records every request (method, path, query, headers, parsed JSON body) and answers from
 * a caller-supplied router, so a test can assert both directions.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export class HttpFixture {
  readonly requests: RecordedRequest[] = [];
  private server: Server | null = null;
  private handler: Handler = () => ({ status: 200, body: {} });

  on(handler: Handler): void {
    this.handler = handler;
  }

  /** Route by `"METHOD /path-prefix"`; anything unmatched becomes a 404 JSON reply. */
  route(routes: Record<string, Reply | Handler>): void {
    // Longest path prefix wins, like a real router: otherwise `GET /zones` would also
    // swallow `GET /zones/<id>/dns_records`.
    const prefixLength = (pattern: string) => (pattern.split(" ")[1] ?? "").length;
    const ordered = Object.entries(routes).sort((a, b) => prefixLength(b[0]) - prefixLength(a[0]));
    this.handler = (req) => {
      for (const [pattern, reply] of ordered) {
        const [method, prefix] = pattern.split(" ");
        if (req.method === method && req.path.startsWith(prefix)) {
          return typeof reply === "function" ? reply(req) : reply;
        }
      }
      return { status: 404, body: { error: "no fixture route", method: req.method, path: req.path } };
    };
  }

  get baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("fixture is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  get last(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        const url = new URL(req.url ?? "/", "http://fixture");
        let body: unknown;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        const recorded: RecordedRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          rawBody: raw,
        };
        this.requests.push(recorded);
        try {
          const reply = await this.handler(recorded);
          res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
          res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }
}
