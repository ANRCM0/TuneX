/**
 * Notification channel selection, message rendering and the business notifications.
 *
 * Channel resolution is pure, so it is asserted directly. Rendering and the DB-backed
 * notifications run against the temp database with the Telegram and email services
 * stubbed, which lets the actual message text and recipients be checked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { NotifyService } from "../../apps/backend/src/services/notify";

const temp: TempDatabase = createTempDatabase("notify");

let db: PrismaClient;
let service: NotifyService;
let notifyTypes: typeof import("../../apps/backend/src/services/notify-types");

let userId = 0;
let adminId = 0;
let planId = 0;
let paymentId = 0;

const telegramCalls: { chatId: number; message: string; buttons?: unknown; callback?: unknown }[] = [];
const emailCalls: { to: string; subject: string; text: string; html?: string }[] = [];
let superAdmins: { id: number; email: string; tg_id: string | null; admin_notify_subscriptions: unknown }[] = [];

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.test";
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  notifyTypes = await import("../../apps/backend/src/services/notify-types");
  const { NotifyService: Service } = await import("../../apps/backend/src/services/notify");

  service = new Service(
    {
      sendMessage: async (chatId: number, message: string, buttons?: unknown, callback?: unknown) => {
        telegramCalls.push({ chatId, message, buttons, callback });
      },
    } as never,
    { getSuperAdmins: async () => superAdmins } as never,
    {
      sendEmail: async (to: string, subject: string, text: string, html?: string) => {
        emailCalls.push({ to, subject, text, html });
        return true;
      },
    } as never,
  );

  userId = (await db.user.create({ data: { email: "user@example.test" } })).id;
  adminId = (await db.user.create({ data: { email: "admin@example.test", super_admin: true } })).id;
  planId = (
    await db.plan.create({
      data: {
        name: "Basic",
        price: 100,
        allow_custom_in_node_group: false,
        allow_custom_out_node_group: false,
        all_in_node_groups: false,
        all_out_node_groups: false,
      },
    })
  ).id;
  paymentId = (
    await db.payment.create({
      data: { name: "Alipay", url: "https://pay.example.test", config: {}, method: "epay" },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(() => {
  telegramCalls.length = 0;
  emailCalls.length = 0;
  superAdmins = [];
});

describe("channel selection", () => {
  it("normalises the legacy array and the record shape", () => {
    const legacy = notifyTypes.normalizeNotifySubscriptions(["topup", "node_register"]);
    expect(legacy.topup).toEqual({ email: true, telegram: true });
    expect(legacy.node_register).toEqual({ email: false, telegram: true });

    const record = notifyTypes.normalizeNotifySubscriptions({
      topup: { email: true, telegram: false },
      node_register: { email: true, telegram: true },
    });
    expect(record.topup).toEqual({ email: true, telegram: false });
    expect(record.node_register).toEqual({ email: false, telegram: true });
  });

  it("defaults user channels off and admin channels on", () => {
    expect(notifyTypes.getChannels(null, "topup")).toEqual({ email: false, telegram: false });
    expect(notifyTypes.getChannels({}, "topup")).toEqual({ email: false, telegram: false });
    expect(notifyTypes.getAdminChannels(null, "user_topup")).toEqual({ email: true, telegram: true });

    const explicit = { user_topup: { email: true, telegram: false } };
    expect(notifyTypes.getAdminChannels(explicit, "user_topup")).toEqual({ email: true, telegram: false });
    expect(notifyTypes.getAdminChannels(explicit, "ticket_created")).toEqual({
      email: false,
      telegram: false,
    });

    const response = notifyTypes.buildAdminNotifySubscriptionsResponse(null);
    expect(Object.keys(response).sort()).toEqual(["ticket_created", "ticket_replied", "user_topup"]);
  });
});

describe("dispatch", () => {
  it("renders the telegram message with escaping and a ticket callback button", async () => {
    await service.dispatch({
      title: "New ticket",
      intro: "intro",
      fields: [{ label: "ticket", value: "a_b*c" }],
      buttons: [{ text: "Open", url: "https://panel.test/t" }],
      email: { to: "x@example.test", enabled: false },
      telegram: { tg_id: "42", enabled: true, replyTicketId: 9 },
      emoji: "🎫",
    });

    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chatId).toBe(42);
    expect(telegramCalls[0].message).toContain("🎫 New ticket");
    expect(telegramCalls[0].message).toContain("a\\_b\\*c");
    expect(telegramCalls[0].callback).toEqual([
      { text: "💬 快捷回复", callback_data: "ticket:reply:9" },
    ]);
    expect(emailCalls).toHaveLength(0);
  });

  it("renders the email template with escaped HTML and buttons", async () => {
    await service.dispatch({
      title: "Title <x>",
      intro: "Intro & more",
      fields: [{ label: "field", value: "<b>value</b>" }],
      buttons: [{ text: "Button", url: "https://panel.test/b" }],
      email: { to: "x@example.test", enabled: true },
      telegram: { tg_id: null, enabled: true },
    });

    expect(telegramCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(1);
    const { to, subject, text, html } = emailCalls[0];
    expect(to).toBe("x@example.test");
    expect(subject).toBe("Title <x>");
    expect(text).toContain("field：<b>value</b>");
    expect(text).toContain("Button：https://panel.test/b");
    expect(html).toContain("Title &lt;x&gt;");
    expect(html).toContain("&lt;b&gt;value&lt;/b&gt;");
    expect(html).toContain('href="https://panel.test/b"');
  });
});

describe("business notifications", () => {
  it("notifies the buyer and the admins about a topup", async () => {
    await db.user.update({
      where: { id: userId },
      data: {
        balance: 105,
        tg_id: "1001",
        notify_subscriptions: { topup: { email: true, telegram: true } },
      },
    });
    await db.user.update({
      where: { id: adminId },
      data: { tg_id: "2002", admin_notify_subscriptions: null },
    });
    superAdmins = [
      { id: adminId, email: "admin@example.test", tg_id: "2002", admin_notify_subscriptions: null },
    ];

    await service.notifyTopup({
      user_id: userId,
      payment_id: paymentId,
      price: 100,
      bonus: 5,
      order_id: "ORDER-1",
    });

    // Admin dispatch (both channels by default) plus the buyer's dispatch.
    expect(emailCalls.map((c) => c.to).sort()).toEqual(["admin@example.test", "user@example.test"]);
    expect(telegramCalls.map((c) => c.chatId).sort()).toEqual([1001, 2002]);

    const buyerMail = emailCalls.find((c) => c.to === "user@example.test")!;
    expect(buyerMail.text).toContain("订单号：ORDER-1");
    expect(buyerMail.text).toContain("支付方式：Alipay");
    expect(buyerMail.text).toContain("充值金额：¥100");
    expect(buyerMail.text).toContain("赠送金额：¥5");
    expect(buyerMail.text).toContain("充值前余额：¥0.00");
    expect(buyerMail.text).toContain("当前余额：¥105");
    expect(buyerMail.text).toContain("https://panel.test/topups");

    const adminMail = emailCalls.find((c) => c.to === "admin@example.test")!;
    expect(adminMail.text).toContain("用户邮箱：user@example.test");
    expect(adminMail.text).toContain("https://panel.test/admin/topups");
  });

  it("does nothing when the buyer has no channels", async () => {
    await db.user.update({ where: { id: userId }, data: { notify_subscriptions: null } });
    superAdmins = [];

    await service.notifyTopup({ user_id: userId, payment_id: paymentId, price: 10, bonus: 0, order_id: "O-2" });

    expect(emailCalls).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
  });

  it("renders the plan subscription fields including unlimited placeholders", async () => {
    await db.userPlan.deleteMany({ where: { user_id: userId } });
    await db.userPlan.create({
      data: { user_id: userId, plan_id: planId, traffic: null, max_tunnels: null, expired_at: null },
    });
    await db.user.update({
      where: { id: userId },
      data: { notify_subscriptions: { subscribe_plan: { email: true, telegram: false } } },
    });

    const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
    const subscribed = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await service.notifySubscribePlan({ ...subscribed, auto_renew: true } as never, plan, 100, 50);

    expect(emailCalls).toHaveLength(1);
    const text = emailCalls[0].text;
    expect(text).toContain("套餐名称：Basic");
    expect(text).toContain("套餐价格：¥100");
    expect(text).toContain("当前余额：¥50");
    expect(text).toContain("流量额度：");
    expect(text).toContain("隧道上限：无限制");
    expect(text).toContain("到期时间：永久有效");
    expect(text).toContain("自动续费：已开启");
  });

  it("notifies admins of a new ticket with a reply callback and truncated content", async () => {
    const ticket = await db.ticket.create({
      data: {
        title: "Help me",
        content: "x".repeat(300),
        user_id: userId,
      },
    });
    superAdmins = [
      { id: adminId, email: "admin@example.test", tg_id: "2002", admin_notify_subscriptions: null },
    ];

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await service.notifyTicketCreated(ticket, user);

    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chatId).toBe(2002);
    expect(telegramCalls[0].message).toContain("新工单通知");
    expect(telegramCalls[0].message).toContain("x".repeat(120));
    expect(telegramCalls[0].callback).toEqual([
      { text: "💬 快捷回复", callback_data: `ticket:reply:${ticket.id}` },
    ]);
    expect(emailCalls[0].text).toContain("工单标题：Help me");
    expect(emailCalls[0].text).toContain("…");
  });

  it("routes a reply to the owner or the admins by who replied", async () => {
    const ticket = await db.ticket.create({ data: { title: "T", content: "c", user_id: userId } });
    await db.user.update({
      where: { id: userId },
      data: { notify_subscriptions: { ticket_replied: { email: true, telegram: false } }, tg_id: "1001" },
    });

    await service.notifyTicketReplied(ticket, "admin@example.test", true, "handled");
    expect(emailCalls.map((c) => c.to)).toEqual(["user@example.test"]);
    expect(emailCalls[0].text).toContain("回复人：管理员");

    emailCalls.length = 0;
    superAdmins = [
      { id: adminId, email: "admin@example.test", tg_id: "2002", admin_notify_subscriptions: null },
    ];
    await service.notifyTicketReplied(ticket, "user@example.test", false, "more info");
    expect(emailCalls.map((c) => c.to)).toEqual(["admin@example.test"]);
    expect(emailCalls[0].text).toContain("用户邮箱：user@example.test");
    expect(telegramCalls[0].chatId).toBe(2002);
  });
});
