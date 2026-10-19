/**
 * TicketService against a throwaway SQLite database.
 *
 * Tickets are the one place where a normal user and an admin both write rows into the
 * same thread, and the ownership checks are what keep users out of each other's
 * threads. The notification calls are recorded by a stub so the payloads can be
 * asserted too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { TicketService } from "../../apps/backend/src/services/ticket";

const temp: TempDatabase = createTempDatabase("tickets");

let db: PrismaClient;
let service: TicketService;

let userA = 0;
let userB = 0;
let adminId = 0;

const notifications: { kind: string; args: unknown[] }[] = [];

async function makeTicket(userId: number, title = "help", content = "body") {
  return db.ticket.create({ data: { title, content, user_id: userId } });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { TicketService: Service } = await import("../../apps/backend/src/services/ticket");

  userA = (await db.user.create({ data: { email: "a@example.test" } })).id;
  userB = (await db.user.create({ data: { email: "b@example.test" } })).id;
  adminId = (await db.user.create({ data: { email: "admin@example.test", super_admin: true } })).id;

  service = new Service({
    notifyTicketCreated: async (...args: unknown[]) => {
      notifications.push({ kind: "created", args });
    },
    notifyTicketReplied: async (...args: unknown[]) => {
      notifications.push({ kind: "replied", args });
    },
  } as never);
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.ticketReply.deleteMany();
  await db.ticket.deleteMany();
  notifications.length = 0;
});

describe("user side", () => {
  it("creates a ticket and notifies", async () => {
    const ticket = await service.createTicket(userA, "title", "content");
    expect(ticket).toMatchObject({ title: "title", content: "content", user_id: userA, status: "open" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("created");
    expect((notifications[0].args[1] as { email: string }).email).toBe("a@example.test");
  });

  it("lists only the caller's tickets with pagination, status and sort", async () => {
    const first = await makeTicket(userA, "first");
    await makeTicket(userA, "second");
    await makeTicket(userB, "foreign");
    await db.ticket.update({ where: { id: first.id }, data: { status: "closed" } });

    const all = await service.getUserTickets(userA, 1, 10);
    expect(all.total).toBe(2);
    expect(all.data.map((t) => t.title)).toEqual(["second", "first"]);

    const closed = await service.getUserTickets(userA, 1, 10, undefined, "closed");
    expect(closed.data.map((t) => t.title)).toEqual(["first"]);

    const page2 = await service.getUserTickets(userA, 2, 1, [{ id: "id", desc: false }]);
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].title).toBe("second");
  });

  it("returns a thread with its replies and guards ownership", async () => {
    const ticket = await makeTicket(userA);
    await db.ticketReply.create({ data: { content: "first", ticket_id: ticket.id, user_id: userA } });
    await db.ticketReply.create({ data: { content: "answer", ticket_id: ticket.id, user_id: adminId, is_admin: true } });

    const thread = await service.getUserTicket(userA, ticket.id);
    expect(thread.replies.map((r) => r.content)).toEqual(["first", "answer"]);
    expect(thread.replies[0].user).toEqual({ email: "a@example.test" });

    await expect(service.getUserTicket(userB, ticket.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.getUserTicket(userA, 999999)).rejects.toMatchObject({
      status: 404,
      message: "工单不存在",
    });
  });

  it("lets the owner change the status but not someone else", async () => {
    const ticket = await makeTicket(userA);

    const closed = await service.updateUserTicketStatus(userA, ticket.id, "closed");
    expect(closed.status).toBe("closed");

    await expect(service.updateUserTicketStatus(userB, ticket.id, "open")).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.updateUserTicketStatus(userA, 999999, "open")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("replies as the user and notifies with the email", async () => {
    const ticket = await makeTicket(userA);
    const reply = await service.userReply(userA, ticket.id, "more info");
    expect(reply).toMatchObject({ content: "more info", is_admin: false, ticket_id: ticket.id });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("replied");
    expect(notifications[0].args[1]).toBe("a@example.test");
    expect(notifications[0].args[2]).toBe(false);
    expect(notifications[0].args[3]).toBe("more info");

    await expect(service.userReply(userB, ticket.id, "hijack")).rejects.toMatchObject({ status: 403 });
  });
});

describe("admin side", () => {
  it("lists every ticket with the user email and filters by status", async () => {
    const a = await makeTicket(userA, "a");
    await makeTicket(userB, "b");
    await db.ticket.update({ where: { id: a.id }, data: { status: "closed" } });

    const all = await service.adminGetTickets(1, 10);
    expect(all.total).toBe(2);
    expect(all.data[0].user).toEqual({ email: "b@example.test" });

    const closed = await service.adminGetTickets(1, 10, undefined, "closed");
    expect(closed.data.map((t) => t.title)).toEqual(["a"]);
  });

  it("reads any thread", async () => {
    const ticket = await makeTicket(userA);
    await db.ticketReply.create({ data: { content: "hi", ticket_id: ticket.id, user_id: userA } });
    const thread = await service.adminGetTicket(ticket.id);
    expect(thread.user).toEqual({ email: "a@example.test" });
    expect(thread.replies).toHaveLength(1);
    await expect(service.adminGetTicket(999999)).rejects.toMatchObject({ status: 404 });
  });

  it("replies as an admin and notifies as admin", async () => {
    const ticket = await makeTicket(userA);
    const reply = await service.adminReply(adminId, ticket.id, "handled");
    expect(reply).toMatchObject({ is_admin: true, content: "handled" });

    expect(notifications[0].kind).toBe("replied");
    expect(notifications[0].args[1]).toBe("admin@example.test");
    expect(notifications[0].args[2]).toBe(true);
  });

  it("updates the status of any ticket", async () => {
    const ticket = await makeTicket(userA);
    const updated = await service.adminUpdateStatus(ticket.id, "closed");
    expect(updated.status).toBe("closed");
  });

  it("routes a telegram reply by ticket ownership or super-admin flag", async () => {
    const ownTicket = await makeTicket(userA, "own");
    const otherTicket = await makeTicket(userB, "other");

    const ownerReply = await service.replyFromTelegram(userA, ownTicket.id, "owner");
    expect(ownerReply.is_admin).toBe(false);

    const adminReply = await service.replyFromTelegram(adminId, otherTicket.id, "admin");
    expect(adminReply.is_admin).toBe(true);

    await expect(service.replyFromTelegram(userA, otherTicket.id, "nope")).rejects.toMatchObject({
      status: 403,
    });
  });
});
