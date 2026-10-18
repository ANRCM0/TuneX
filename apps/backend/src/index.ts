import { serve } from "@hono/node-server";
import app, { start } from "./app";
import { logger } from "./logger";
import { attach } from "./socket-io";

/**
 * 部署层 `/api` 前缀剥离的等价实现。
 *
 * 原生应用把全部路由挂在根路径（app.ts），但向外部宣告的自指 URL 带 `/api`
 * 前缀（observer 上报 `${SITE_URL}/api/tunnel/observer`、支付回调
 * `${SITE_URL}/api/pay/:id/callback`，以及 openapi `servers: [{url: "/api"}]`）。
 * 分析报告判定前缀在生产环境由反向代理/网关剥离，应用内不存在（见
 * relayx-analysis reports/BUSINESS_LOGIC_DEEP.md 的 U1 与 work/verify_live/01_api_prefix.sh）。
 *
 * 这里在服务入口做同样的一次性剥离，使自指的 `/api/...` URL 在没有外置反向代理时
 * 也能命中根路径路由；同时保留根路径直连的可用性。注意必须透传 node-server 提供的
 * `env`（getConnInfo 依赖它读取对端地址）。
 */
const appFetch = (request: Request, env?: unknown) => {
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice("/api".length) || "/";
    return app.fetch(new Request(url, request), env);
  }
  return app.fetch(request, env);
};

process.on("unhandledRejection", (reason) => {
  logger.error(reason, "unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error(err, "uncaughtException");
});

const server = serve(
  {
    fetch: appFetch,
    port: parseInt(process.env.PORT || "3000"),
  },
  async (info) => {
    await start();
    console.log(
      `Server is running in ${process.env.NODE_ENV} mode: http://localhost:${info.port}`,
    );
  },
);

attach(server);

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close((err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
});
