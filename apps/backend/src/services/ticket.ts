import { HTTPException } from "hono/http-exception";
import type { Prisma, TicketStatus } from "@prisma/client";
import { db } from "../db";
import { service, TOKENS } from "../container";
import { notifyService, type NotifyService } from "./notify";

/**
 * Upstream: src/services/ticket.ts (182 lines) — ported 1:1.
 *
 * Ticket CRUD for both the user and the admin surface, plus the Telegram reply path.
 * Every mutation that adds a reply dispatches through `notifyService`, exactly as
 * upstream does.
 */

/** Sort descriptor the table query schemas produce (`TableRequestSchema.sort`). */
export interface SortItem {
  id: string;
  desc?: boolean;
}

export class TicketService {
  private notifyService: NotifyService;

  constructor(notifyService: NotifyService) {
    this.notifyService = notifyService;
  }

  /**
   * `sort` is parsed by `TableRequestSchema` as `[{ id, desc }]` and upstream splats it
   * into an arbitrary Prisma `orderBy`; the cast is needed because the field name is a
   * runtime string.
   */
  private buildOrderBy(
    sort?: SortItem[],
  ): Prisma.TicketOrderByWithRelationInput[] | undefined {
    return sort?.map((s) => ({
      [s.id]: s.desc ? "desc" : "asc",
    })) as unknown as Prisma.TicketOrderByWithRelationInput[];
  }

  async createTicket(userId: number, title: string, content: string) {
    const ticket = await db.ticket.create({
      data: { title, content, user_id: userId },
    });
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    await this.notifyService.notifyTicketCreated(ticket, user);
    return ticket;
  }

  async getUserTickets(
    userId: number,
    page: number,
    perPage: number,
    sort?: SortItem[],
    status?: TicketStatus,
  ) {
    const orderBy = this.buildOrderBy(sort);
    const where = { user_id: userId, status };
    const [data, total] = await db.$transaction([
      db.ticket.findMany({
        where,
        orderBy: orderBy || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      db.ticket.count({ where }),
    ]);
    return { data, total };
  }

  async getUserTicket(userId: number, ticketId: number) {
    const ticket = await db.ticket.findUnique({
      where: { id: ticketId },
      include: {
        replies: {
          orderBy: { id: "asc" },
          include: { user: { select: { email: true } } },
        },
      },
    });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    if (ticket.user_id !== userId) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    return ticket;
  }

  async updateUserTicketStatus(
    userId: number,
    ticketId: number,
    status: TicketStatus,
  ) {
    const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    if (ticket.user_id !== userId) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    return db.ticket.update({ where: { id: ticketId }, data: { status } });
  }

  async userReply(userId: number, ticketId: number, content: string) {
    const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    if (ticket.user_id !== userId) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    const reply = await db.ticketReply.create({
      data: { content, ticket_id: ticketId, user_id: userId, is_admin: false },
    });
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    await this.notifyService.notifyTicketReplied(ticket, user.email, false, content);
    return reply;
  }

  async adminGetTickets(
    page: number,
    perPage: number,
    sort?: SortItem[],
    status?: TicketStatus,
  ) {
    const orderBy = this.buildOrderBy(sort);
    const where = status ? { status } : {};
    const [data, total] = await db.$transaction([
      db.ticket.findMany({
        where,
        orderBy: orderBy || [{ id: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: { user: { select: { email: true } } },
      }),
      db.ticket.count({ where }),
    ]);
    return { data, total };
  }

  async adminGetTicket(ticketId: number) {
    const ticket = await db.ticket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: { email: true } },
        replies: {
          orderBy: { id: "asc" },
          include: { user: { select: { email: true } } },
        },
      },
    });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    return ticket;
  }

  async replyFromTelegram(userId: number, ticketId: number, content: string) {
    const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    if (ticket.user_id === userId) {
      return this.userReply(userId, ticketId, content);
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { super_admin: true },
    });
    if (!user) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    if (!user.super_admin) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    return this.adminReply(userId, ticketId, content);
  }

  async adminReply(adminId: number, ticketId: number, content: string) {
    const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new HTTPException(404, { message: "工单不存在" });
    }
    const reply = await db.ticketReply.create({
      data: { content, ticket_id: ticketId, user_id: adminId, is_admin: true },
    });
    const admin = await db.user.findUnique({
      where: { id: adminId },
      select: { email: true },
    });
    if (!admin) {
      throw new HTTPException(404, { message: "用户不存在" });
    }
    await this.notifyService.notifyTicketReplied(ticket, admin.email, true, content);
    return reply;
  }

  async adminUpdateStatus(ticketId: number, status: TicketStatus) {
    return db.ticket.update({ where: { id: ticketId }, data: { status } });
  }
}

/** Self-registration. */
export const ticketService = service<TicketService>(
  TOKENS.Ticket,
  () => new TicketService(notifyService),
);
