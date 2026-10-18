import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { showRoutes } from "hono/dev";
import { Scalar } from "@scalar/hono-api-reference";
import { openAPIRouteHandler } from "hono-openapi";
import { NODE_ENV, SENTRY_DSN, isProduction } from "./config";
import { logger } from "./logger";
import { getRequestIP } from "./middlewares/ip";
import { requestLogger } from "./middlewares/request-logger";
import { sentry } from "./middlewares/sentry";
import {
  adminPermissionGuard,
  adminRequired,
  authRequired,
  superAdminRequired,
} from "./middlewares/auth";
import { businessLicenseRequired } from "./middlewares/license";
import { instance, TOKENS } from "./container";
import type { TelegramService } from "./services/telegram";

import health from "./routes/health";
import queuedash from "./bullmq/queuedash";

import adminNode from "./routes/admin/node";
import adminNodeGroup from "./routes/admin/node_group";
import adminPlan from "./routes/admin/plan";
import adminPlanCoupon from "./routes/admin/plan_coupon";
import adminUser from "./routes/admin/user";
import adminUserPlan from "./routes/admin/user_plan";
import adminPay from "./routes/admin/pay";
import adminSystemConfig from "./routes/admin/system_config";
import adminLicense from "./routes/admin/license";
import adminStats from "./routes/admin/stats";
import adminTopup from "./routes/admin/topup";
import adminTopupActivity from "./routes/admin/topup_activity";
import adminTunnel from "./routes/admin/tunnel";
import adminTicket from "./routes/admin/ticket";
import adminWithdraw from "./routes/admin/withdraw";
import adminRole from "./routes/admin/role";

import tunnel from "./routes/tunnel";
import node from "./routes/node";
import nodeGroup from "./routes/node_group";
import user from "./routes/user";
import license from "./routes/license";
import plan from "./routes/plan";
import topup from "./routes/topup";
import pay from "./routes/pay";
import systemConfig from "./routes/system_config";
import planCoupon from "./routes/plan_coupon";
import bot from "./routes/bot";
import inNodeGroupDns from "./routes/in_node_group_dns";
import dnsProvider from "./routes/dns_provider";
import ticket from "./routes/ticket";
import commission from "./routes/commission";

import { initBullMQ } from "./bullmq/queue";

const app = new Hono();

app.use(getRequestIP, requestLogger);
if (!isProduction()) {
  app.use("*", cors());
}

app.route("/queuedash", queuedash);
app.route("/health", health);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const message = err.message;
    if (message) {
      return c.json({ error: message }, err.status);
    }
    return c.json({ error: err }, err.status);
  }
  logger.error(err);
  return c.json({ error: "服务器错误" }, 500);
});

app.use(
  "*",
  sentry({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    enabled: isProduction(),
    beforeSend(event, hint) {
      const err = hint?.originalException;
      if (err instanceof HTTPException && err.status < 500) {
        return null;
      }
      return event;
    },
  }),
  authRequired,
);

app.use("/admin/*", adminRequired);
app.use("/admin/*", adminPermissionGuard);

app.get("/docs", businessLicenseRequired, Scalar({ url: "/openapi.json" }));

app.get(
  "/openapi.json",
  businessLicenseRequired,
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "RelayX API",
        version: "1.0.0",
        description:
          "RelayX API 接口文档，请使用 Bearer Token 进行认证，格式为 `Bearer <apiKey>`",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
      security: [{ bearerAuth: [] }],
      servers: [{ url: "/api" }],
    },
  }),
);

app.use("/admin/pay", businessLicenseRequired);
app.use("/admin/plan/coupon", businessLicenseRequired);
app.use("/admin/topup/activity", businessLicenseRequired);
app.use("/admin/ticket/*", businessLicenseRequired);
app.use("/pay", businessLicenseRequired);
app.use("/plan/coupon", businessLicenseRequired);
app.use("/ticket/*", businessLicenseRequired);
app.use("/commission/*", businessLicenseRequired);
app.use("/admin/withdraw/*", businessLicenseRequired);
app.use("/admin/role", superAdminRequired, businessLicenseRequired);
app.use("/admin/role/*", superAdminRequired, businessLicenseRequired);

const adminRoutes = new Hono()
  .route("/node", adminNode)
  .route("/node/group", adminNodeGroup)
  .route("/plan", adminPlan)
  .route("/plan/coupon", adminPlanCoupon)
  .route("/user", adminUser)
  .route("/user_plan", adminUserPlan)
  .route("/pay", adminPay)
  .route("/system/config", adminSystemConfig)
  .route("/license", adminLicense)
  .route("/stats", adminStats)
  .route("/topup", adminTopup)
  .route("/topup/activity", adminTopupActivity)
  .route("/tunnel", adminTunnel)
  .route("/ticket", adminTicket)
  .route("/withdraw", adminWithdraw)
  .route("/role", adminRole);

const routes = app
  .route("/admin", adminRoutes)
  .route("/tunnel", tunnel)
  .route("/node", node)
  .route("/node/group", nodeGroup)
  .route("/user", user)
  .route("/license", license)
  .route("/plan", plan)
  .route("/topup", topup)
  .route("/pay", pay)
  .route("/system/config", systemConfig)
  .route("/license", license)
  .route("/plan/coupon", planCoupon)
  .route("/bot", bot)
  .route("/in_node_group_dns", inNodeGroupDns)
  .route("/dns_provider", dnsProvider)
  .route("/ticket", ticket)
  .route("/commission", commission);

if (!isProduction()) {
  showRoutes(routes);
}

export default routes;
export { app };

export type AppType = typeof routes;

export async function start(): Promise<void> {
  const telegramService = instance.resolve<TelegramService>(TOKENS.Telegram);
  telegramService.start();
  await initBullMQ();
}
