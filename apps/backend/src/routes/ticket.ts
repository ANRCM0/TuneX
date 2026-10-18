import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { TicketStatus } from "@prisma/client";
import { describeRoute, resolver, zValidator } from "../openapi";
import { IdSchema, TableRequestSchema } from "../schemas/request";
import { TicketReplySchema, TicketSchema } from "../generated/zod";
import { ticketService } from "../services/ticket";
import type { AppEnv } from "../types";

/**
 * Upstream: src/routes/ticket.ts (110 lines) — ported 1:1.
 *
 * Mounted at `/ticket` by the frozen `src/app.ts`, behind `businessLicenseRequired`.
 */
const router = new Hono<AppEnv>();

const TicketCreateSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1),
});

const TicketReplyCreateSchema = z.object({
  content: z.string().min(1),
});

const TicketStatusUpdateSchema = z.object({
  status: z.nativeEnum(TicketStatus),
});

const TicketListResponseSchema = z.object({
  data: z.array(TicketSchema),
  total: z.number(),
});

const TicketDetailSchema = TicketSchema.extend({
  replies: z.array(
    TicketReplySchema.extend({
      user: z.object({ email: z.string() }),
    }),
  ),
});

const UserTicketQuerySchema = TableRequestSchema.extend({
  status: z.nativeEnum(TicketStatus).nullish(),
});

router.get(
  "",
  describeRoute({
    summary: "获取工单列表",
    tags: ["工单"],
    responses: {
      200: {
        description: "工单列表",
        content: { "application/json": { schema: resolver(TicketListResponseSchema) } },
      },
    },
  }),
  zValidator("query", UserTicketQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { page, perPage, sort, status } = c.req.valid("query");
    const result = await ticketService.getUserTickets(
      user.id,
      page,
      perPage,
      sort ?? undefined,
      status ?? undefined,
    );
    return c.json(result);
  },
);

router.post(
  "",
  describeRoute({
    summary: "创建工单",
    tags: ["工单"],
    responses: {
      201: {
        description: "工单创建成功",
        content: { "application/json": { schema: resolver(TicketSchema) } },
      },
    },
  }),
  zValidator("json", TicketCreateSchema),
  async (c) => {
    const user = c.get("user");
    const { title, content } = c.req.valid("json");
    const ticket = await ticketService.createTicket(user.id, title, content);
    return c.json(ticket, 201);
  },
);

router.get(
  "/:id",
  describeRoute({
    summary: "获取工单详情",
    tags: ["工单"],
    responses: {
      200: {
        description: "工单详情",
        content: { "application/json": { schema: resolver(TicketDetailSchema) } },
      },
    },
  }),
  zValidator("param", IdSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    try {
      const ticket = await ticketService.getUserTicket(user.id, id);
      return c.json(ticket);
    } catch {
      throw new HTTPException(403, { message: "无权限访问此工单" });
    }
  },
);

router.patch(
  "/:id",
  describeRoute({
    summary: "更新工单状态",
    tags: ["工单"],
    responses: { 204: { description: "更新成功" } },
  }),
  zValidator("param", IdSchema),
  zValidator("json", TicketStatusUpdateSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    try {
      await ticketService.updateUserTicketStatus(user.id, id, status);
    } catch {
      throw new HTTPException(403, { message: "无权限操作此工单" });
    }
    return c.body(null, 204);
  },
);

router.post(
  "/:id/reply",
  describeRoute({
    summary: "回复工单",
    tags: ["工单"],
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
    try {
      const reply = await ticketService.userReply(user.id, id, content);
      return c.json(reply, 201);
    } catch {
      throw new HTTPException(403, { message: "无权限操作此工单" });
    }
  },
);

export default router;
