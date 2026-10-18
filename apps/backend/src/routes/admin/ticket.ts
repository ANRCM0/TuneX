import { Hono } from "hono";
import { z } from "zod";
import { TicketStatus } from "@prisma/client";
import { describeRoute, resolver, zValidator } from "../../openapi";
import { IdSchema, TableRequestSchema } from "../../schemas/request";
import { TicketReplySchema, TicketSchema } from "../../generated/zod";
import { ticketService } from "../../services/ticket";
import type { AppEnv } from "../../types";

/**
 * Upstream: src/routes/admin/ticket.ts (80 lines) — ported 1:1.
 *
 * Mounted at `/admin/ticket` by the frozen `src/app.ts`, behind the admin guard and
 * `businessLicenseRequired`.
 */
const router = new Hono<AppEnv>();

const TicketReplyCreateSchema = z.object({
  content: z.string().min(1),
});

const TicketStatusUpdateSchema = z.object({
  status: z.nativeEnum(TicketStatus),
});

const TicketWithUserSchema = TicketSchema.extend({
  user: z.object({ email: z.string() }),
});

const TicketListResponseSchema = z.object({
  data: z.array(TicketWithUserSchema),
  total: z.number(),
});

const TicketDetailSchema = TicketSchema.extend({
  user: z.object({ email: z.string() }),
  replies: z.array(
    TicketReplySchema.extend({
      user: z.object({ email: z.string() }),
    }),
  ),
});

const AdminTicketQuerySchema = TableRequestSchema.extend({
  status: z.nativeEnum(TicketStatus).nullish(),
});

router.get(
  "",
  describeRoute({
    summary: "获取所有工单",
    tags: ["管理员工单"],
    responses: {
      200: {
        description: "工单列表",
        content: { "application/json": { schema: resolver(TicketListResponseSchema) } },
      },
    },
  }),
  zValidator("query", AdminTicketQuerySchema),
  async (c) => {
    const { page, perPage, sort, status } = c.req.valid("query");
    const result = await ticketService.adminGetTickets(
      page,
      perPage,
      sort ?? undefined,
      status ?? undefined,
    );
    return c.json(result);
  },
);

router.get(
  "/:id",
  describeRoute({
    summary: "获取工单详情",
    tags: ["管理员工单"],
    responses: {
      200: {
        description: "工单详情",
        content: { "application/json": { schema: resolver(TicketDetailSchema) } },
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const ticket = await ticketService.adminGetTicket(id);
    return c.json(ticket);
  },
);

router.post(
  "/:id/reply",
  describeRoute({
    summary: "管理员回复工单",
    tags: ["管理员工单"],
    responses: {
      201: {
        description: "回复成功",
        content: { "application/json": { schema: resolver(TicketReplySchema) } },
      },
    },
  }),
  zValidator("param", IdSchema),
  zValidator("json", TicketReplyCreateSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { content } = c.req.valid("json");
    const reply = await ticketService.adminReply(user.id, id, content);
    return c.json(reply, 201);
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新工单状态",
    tags: ["管理员工单"],
    responses: { 204: { description: "更新成功" } },
  }),
  zValidator("param", IdSchema),
  zValidator("json", TicketStatusUpdateSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    await ticketService.adminUpdateStatus(id, status);
    return c.body(null, 204);
  },
);

export default router;
