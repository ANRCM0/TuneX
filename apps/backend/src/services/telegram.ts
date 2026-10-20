import { Status, NodeType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { TELEGRAM_BOT_TOKEN, SITE_URL } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { service, TOKENS } from "../container";
import { escapeMarkdown } from "@relayx/shared/telegram";
import {
  AdminNotifyType,
  NotifyType,
  buildAdminNotifySubscriptionsResponse,
  normalizeNotifySubscriptions,
  supportsEmailNotification,
  type NotifyChannelFlags,
} from "./notify-types";
import { redisService, type RedisService } from "./redis";
import type { NotifyButton, NotifyCallbackButton } from "./notify";

/**
 * Upstream: src/services/telegram.ts (558 lines).
 *
 * DEVIATION (described for docs/DEVIATIONS.md, owned by the verify teammate): upstream
 * builds the bot with `telegraf`. `telegraf` is not part of the frozen dependency set and
 * CONVENTIONS.md forbids adding dependencies, so the replica keeps the exact same handler
 * surface — commands, MarkdownV2 escaping, inline keyboards, callback data and every
 * Chinese string — on top of a small dependency-free client for the Telegram Bot HTTP API
 * (`fetch`). Only the transport differs. `start()` logs once and returns when
 * `TELEGRAM_BOT_TOKEN` is unset, so the server boots with no Telegram configuration.
 */

const USER_NOTIFY_LABELS: Record<NotifyType, string> = {
  [NotifyType.topup]: "充值成功",
  [NotifyType.subscribe_plan]: "套餐订阅",
  [NotifyType.node_register]: "节点注册",
  [NotifyType.renew_plan_failed]: "套餐续费失败",
  [NotifyType.node_disconnect]: "节点断开",
  [NotifyType.node_online]: "节点恢复在线",
  [NotifyType.plan_expire]: "套餐到期",
  [NotifyType.ticket_created]: "工单创建（用户）",
  [NotifyType.ticket_replied]: "工单回复",
};

const ADMIN_NOTIFY_LABELS: Record<AdminNotifyType, string> = {
  [AdminNotifyType.user_topup]: "用户充值",
  [AdminNotifyType.ticket_created]: "新工单",
  [AdminNotifyType.ticket_replied]: "用户回复工单",
};

const esc = escapeMarkdown;

function formatGB(gb: number | null | undefined): string {
  if (gb === null || gb === undefined) return "无限制";
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  return `${Number(gb.toFixed(2))} GB`;
}

function formatRemaining(target: Date | null | undefined): string {
  if (!target) return "永久有效";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "已到期";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

// ── Telegram Bot API transport (dependency-free replacement for telegraf) ──────────────

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

interface TgChat {
  id: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  reply_to_message?: TgMessage;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ReplyMarkup {
  force_reply?: boolean;
  selective?: boolean;
}

interface SendMessageExtra {
  parse_mode?: string;
  reply_markup?: InlineKeyboardMarkup | ReplyMarkup;
  link_preview_options?: { is_disabled: boolean };
}

/**
 * Thin Bot API client. Exported so the integration suite can drive it against a local
 * fixture; the service itself only uses it internally.
 */
export class TelegramApi {
  private readonly base: string;

  constructor(token: string) {
    // Overridable so the integration suite can drive a local Bot API fixture.
    const root = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
    this.base = `${root.replace(/\/$/, "")}/bot${token}`;
  }

  async call<T = unknown>(
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
    }
    return body.result as T;
  }
}

/** Context object mirroring the telegraf `Context` surface the handlers use. */
class BotContext {
  match?: RegExpMatchArray | null;
  botInfo?: TgUser;

  constructor(
    private api: TelegramApi,
    readonly update: TgUpdate,
  ) {}

  get from(): TgUser | undefined {
    return this.update.callback_query?.from ?? this.update.message?.from;
  }

  get message(): TgMessage | undefined {
    return this.update.message;
  }

  get callbackQuery(): TgCallbackQuery | undefined {
    return this.update.callback_query;
  }

  private get chatId(): number | undefined {
    return this.update.callback_query?.message?.chat.id ?? this.update.message?.chat.id;
  }

  async reply(text: string, extra: SendMessageExtra = {}): Promise<void> {
    const chatId = this.chatId;
    if (chatId === undefined) return;
    await this.api.call("sendMessage", { chat_id: chatId, text, ...extra }, 20000);
  }

  async answerCbQuery(text?: string): Promise<void> {
    const query = this.callbackQuery;
    if (!query) return;
    await this.api.call("answerCallbackQuery", {
      callback_query_id: query.id,
      ...(text ? { text } : {}),
    });
  }

  async editMessageText(text: string): Promise<void> {
    const message = this.callbackQuery?.message;
    if (!message) return;
    await this.api.call("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text,
    });
  }

  async editMessageReplyMarkup(reply_markup: InlineKeyboardMarkup): Promise<void> {
    const message = this.callbackQuery?.message;
    if (!message) return;
    await this.api.call("editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup,
    });
  }
}

type TgUserRecord = Awaited<ReturnType<typeof db.user.findFirst>>;

export class TelegramService {
  private redisService: RedisService;
  private api?: TelegramApi;
  private me?: TgUser;
  private running = false;

  constructor(redisService: RedisService) {
    this.redisService = redisService;
    if (!TELEGRAM_BOT_TOKEN) return;
    this.api = new TelegramApi(TELEGRAM_BOT_TOKEN);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────

  start(): void {
    if (!this.api) {
      logger.info("Telegram bot disabled (TELEGRAM_BOT_TOKEN is not set); skipping bot startup.");
      return;
    }
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
    this.setBotCommands().catch((err) => console.error("Failed to set Telegram bot commands:", err));
  }

  stop(): void {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    if (!this.api) return;
    const api = this.api;
    let offset = 0;
    try {
      this.me = await api.call<TgUser>("getMe");
    } catch (err) {
      console.error("Telegram bot error:", err);
    }
    while (this.running) {
      try {
        const updates = await api.call<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          40000,
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          const ctx = new BotContext(api, update);
          ctx.botInfo = this.me;
          try {
            await this.handleUpdate(ctx);
          } catch (err) {
            console.error("Telegram bot error:", err);
            try {
              await ctx.reply("处理命令时出错，请稍后重试。");
            } catch {
              // ignored — upstream also swallows failures inside the error handler
            }
          }
        }
      } catch (err) {
        console.error("Telegram bot error:", err);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  /**
   * Upstream wires these through telegraf's router: `command()` handlers terminate the
   * chain, while the catch-all `message("text")` handler only reacts to replies to one of
   * the bot's own ticket-reply prompts.
   */
  private async handleUpdate(ctx: BotContext): Promise<void> {
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data ?? "";
      const notifyMatch = data.match(/^notify:(user|admin):([^:]+):(email|telegram)$/);
      if (notifyMatch) {
        ctx.match = notifyMatch;
        await this.handleNotifyToggle(ctx);
        return;
      }
      const unbindMatch = data.match(/^unbind:(confirm|cancel)$/);
      if (unbindMatch) {
        ctx.match = unbindMatch;
        await this.handleUnbindAction(ctx);
        return;
      }
      const replyMatch = data.match(/^ticket:reply:(\d+)$/);
      if (replyMatch) {
        ctx.match = replyMatch;
        await this.handleTicketReplyPrompt(ctx);
        return;
      }
      await ctx.answerCbQuery();
      return;
    }

    const text = ctx.message?.text;
    if (text === undefined) return;

    if (text.startsWith("/")) {
      const [command] = text.split(" ");
      const name = command.replace(/^\//, "").split("@")[0];
      switch (name) {
        case "start":
          await this.handleStart(ctx);
          return;
        case "help":
          await this.handleHelp(ctx);
          return;
        case "me":
          await this.handleMe(ctx);
          return;
        case "plan":
          await this.handlePlan(ctx);
          return;
        case "unbind":
          await this.handleUnbind(ctx);
          return;
        case "notify":
          await this.handleNotify(ctx);
          return;
        case "tunnels":
          await this.handleTunnels(ctx);
          return;
        case "nodes":
          await this.handleNodes(ctx);
          return;
        case "stats":
          await this.handleStats(ctx);
          return;
        default:
          // Upstream registers no catch-all command handler: an unknown command falls
          // through to the text handler, which ignores it.
          return;
      }
    }

    await this.handleTicketReplyMessage(ctx);
  }

  async getBotInfo(): Promise<string | undefined> {
    const res = await this.api?.call<TgUser>("getMe");
    return res?.username;
  }

  async setBotCommands(): Promise<void> {
    if (!this.api) return;
    await this.api.call("setMyCommands", {
      commands: [
        { command: "me", description: "账户概览" },
        { command: "plan", description: "套餐详情" },
        { command: "tunnels", description: "我的隧道" },
        { command: "nodes", description: "我的节点组" },
        { command: "notify", description: "通知订阅设置" },
        { command: "unbind", description: "解绑当前账户" },
        { command: "stats", description: "系统数据概览（管理员）" },
        { command: "help", description: "查看帮助" },
      ],
    });
  }

  // ── user helpers ─────────────────────────────────────────────────────────────────────

  private async getUser(ctx: BotContext): Promise<TgUserRecord> {
    const tg_id = ctx.from?.id?.toString();
    if (!tg_id) return null;
    return db.user.findFirst({ where: { tg_id } });
  }

  private async requireUser(ctx: BotContext): Promise<TgUserRecord> {
    const user = await this.getUser(ctx);
    if (!user) {
      await ctx.reply("尚未绑定账户，请前往网页后台 → 个人中心点击绑定。");
      return null;
    }
    return user;
  }

  private async requireAdmin(ctx: BotContext): Promise<TgUserRecord> {
    const user = await this.requireUser(ctx);
    if (!user) return null;
    if (!user.super_admin) {
      await ctx.reply("该命令仅限管理员使用。");
      return null;
    }
    return user;
  }

  // ── command handlers ─────────────────────────────────────────────────────────────────

  private async handleStart(ctx: BotContext): Promise<void> {
    const messageText = ctx.message?.text;
    const [, token] = messageText?.split(" ") ?? [];
    if (token) {
      const userId = await this.redisService.consumeTgBindToken(token);
      const user = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
      if (!user) {
        await ctx.reply("绑定码无效或已过期，请前往个人中心重新点击绑定。");
        return;
      }
      if (!ctx.from?.id) return;
      await db.user.update({
        where: { id: user.id },
        data: { tg_id: ctx.from.id.toString() },
      });
      await ctx.reply("✅ 绑定成功！发送 /help 查看可用命令。");
      return;
    }
    await this.handleHelp(ctx);
  }

  private async handleHelp(ctx: BotContext): Promise<void> {
    const user = await this.getUser(ctx);
    const lines = [
      "*RelayX 机器人命令*",
      "",
      "/start — 前往个人中心点击绑定",
      "/me — 账户概览",
      "/plan — 套餐详情",
      "/tunnels — 我的隧道",
      "/nodes — 我的节点组",
      "/notify — 通知订阅设置",
      "/unbind — 解绑当前账户",
      "/help — 查看帮助",
    ];
    if (user?.super_admin) {
      lines.push("", "*管理员命令*", "/stats — 系统数据概览");
    }
    await ctx.reply(lines.join("\n").replace(/\./g, "\\."), { parse_mode: "MarkdownV2" });
  }

  private async handleMe(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    const userPlan = await db.userPlan.findUnique({
      where: { user_id: user.id },
      include: { plan: { select: { name: true } } },
    });
    const tunnelCount = await db.tunnel.count({ where: { user_id: user.id } });
    const lines = [
      "*👤 账户概览*",
      "",
      `📧 邮箱：*${esc(user.email)}*`,
      `💰 余额：*¥${esc(user.balance.toString())}*`,
      `🎁 佣金余额：*¥${esc(user.commission_balance.toString())}*`,
      `📋 当前套餐：*${esc(userPlan?.plan.name ?? "无")}*`,
      `📊 流量使用：*${esc(formatGB(userPlan?.traffic_used ?? 0))} / ${esc(formatGB(userPlan?.traffic ?? null))}*`,
      `🕐 套餐到期：*${esc(userPlan?.expired_at ? formatRemaining(userPlan.expired_at) : userPlan ? "永久有效" : "—")}*`,
      `🔗 隧道数量：*${tunnelCount}*`,
      `🔁 自动续费：*${user.auto_renew ? "已开启" : "未开启"}*`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "查看后台", url: `${SITE_URL}/account` },
            { text: "充值", url: `${SITE_URL}/topups` },
          ],
        ],
      },
    });
  }

  private async handlePlan(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    const userPlan = await db.userPlan.findUnique({
      where: { user_id: user.id },
      include: { plan: true },
    });
    if (!userPlan) {
      await ctx.reply("您暂未订阅任何套餐。", {
        reply_markup: {
          inline_keyboard: [[{ text: "前往订阅", url: `${SITE_URL}/plans` }]],
        },
      });
      return;
    }
    const lines = [
      `*📋 ${esc(userPlan.plan.name)}*`,
      "",
      `💸 价格：*¥${esc(userPlan.plan.price.toString())} / ${esc(userPlan.plan.billing_cycle)}*`,
      `📊 流量：*${esc(formatGB(userPlan.traffic_used))} / ${esc(formatGB(userPlan.traffic))}*`,
      `🔗 隧道上限：*${esc(userPlan.max_tunnels !== null ? `${userPlan.max_tunnels} 条` : "无限制")}*`,
      `🕐 到期时间：*${esc(userPlan.expired_at ? formatRemaining(userPlan.expired_at) : "永久有效")}*`,
      `🔁 自动续费：*${user.auto_renew ? "已开启" : "未开启"}*`,
      `✅ 可续费：*${userPlan.plan.renewable && userPlan.plan.status === Status.active ? "是" : "否"}*`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "续费/换套餐", url: `${SITE_URL}/plans` },
            { text: "充值", url: `${SITE_URL}/topups` },
          ],
        ],
      },
    });
  }

  private async handleUnbind(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    await ctx.reply(`确认解绑账户 ${user.email}？解绑后将不再收到任何通知。`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 确认解绑", callback_data: "unbind:confirm" },
            { text: "❌ 取消", callback_data: "unbind:cancel" },
          ],
        ],
      },
    });
  }

  private async handleUnbindAction(ctx: BotContext): Promise<void> {
    const action = ctx.match?.[1];
    await ctx.answerCbQuery();
    if (action === "cancel") {
      await ctx.editMessageText("已取消解绑操作。");
      return;
    }
    const tg_id = ctx.from?.id?.toString();
    if (!tg_id) return;
    await db.user.updateMany({ where: { tg_id }, data: { tg_id: null } });
    await ctx.editMessageText("✅ 已解绑账户，前往个人中心重新点击绑定即可。");
  }

  private async handleTicketReplyPrompt(ctx: BotContext): Promise<void> {
    const ticketId = ctx.match?.[1];
    await ctx.answerCbQuery();
    if (!ticketId) return;
    const user = await this.getUser(ctx);
    if (!user) {
      await ctx.reply("请先绑定账户后再回复工单。");
      return;
    }
    await ctx.reply(`请直接回复本条消息，输入对工单 #${ticketId} 的回复内容：`, {
      reply_markup: { force_reply: true, selective: true },
    });
  }

  private async handleTicketReplyMessage(ctx: BotContext): Promise<void> {
    const msg = ctx.message;
    const replyTo = msg?.reply_to_message;
    if (!replyTo?.text) return;
    if (ctx.botInfo && replyTo.from?.id !== ctx.botInfo.id) return;
    const matched = replyTo.text.match(/对工单 #(\d+)/);
    if (!matched) return;
    const ticketId = Number(matched[1]);
    const content = msg?.text?.trim();
    const user = await this.requireUser(ctx);
    if (!user) return;
    if (!content) {
      await ctx.reply("回复内容不能为空。");
      return;
    }
    try {
      const { ticketService } = await import("./ticket");
      await ticketService.replyFromTelegram(user.id, ticketId, content);
      await ctx.reply(`✅ 已回复工单 #${ticketId}。`);
    } catch {
      await ctx.reply("回复失败，您可能无权回复该工单或工单不存在。");
    }
  }

  private buildNotifyKeyboard(
    userSubs: Partial<Record<string, NotifyChannelFlags>>,
    adminSubs: Record<string, NotifyChannelFlags> | null,
  ): InlineKeyboardButton[][] {
    const rows: InlineKeyboardButton[][] = [];
    for (const type of Object.values(NotifyType)) {
      const flags = userSubs[type] ?? { email: false, telegram: false };
      rows.push([
        { text: USER_NOTIFY_LABELS[type], callback_data: `notify:user:${type}:nop` },
        ...(supportsEmailNotification(type)
          ? [
              {
                text: `📧 ${flags.email ? "✅" : "❌"}`,
                callback_data: `notify:user:${type}:email`,
              },
            ]
          : []),
        {
          text: `💬 ${flags.telegram ? "✅" : "❌"}`,
          callback_data: `notify:user:${type}:telegram`,
        },
      ]);
    }
    if (adminSubs) {
      for (const type of Object.values(AdminNotifyType)) {
        const flags = adminSubs[type] ?? { email: false, telegram: false };
        rows.push([
          {
            text: `[管理员] ${ADMIN_NOTIFY_LABELS[type]}`,
            callback_data: `notify:admin:${type}:nop`,
          },
          {
            text: `📧 ${flags.email ? "✅" : "❌"}`,
            callback_data: `notify:admin:${type}:email`,
          },
          {
            text: `💬 ${flags.telegram ? "✅" : "❌"}`,
            callback_data: `notify:admin:${type}:telegram`,
          },
        ]);
      }
    }
    return rows;
  }

  private async handleNotify(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    const userSubs = normalizeNotifySubscriptions(user.notify_subscriptions);
    const adminSubs = user.super_admin
      ? buildAdminNotifySubscriptionsResponse(user.admin_notify_subscriptions)
      : null;
    await ctx.reply("点击对应按钮切换通知渠道，节点通知仅支持 Telegram：", {
      reply_markup: { inline_keyboard: this.buildNotifyKeyboard(userSubs, adminSubs) },
    });
  }

  private async handleNotifyToggle(ctx: BotContext): Promise<void> {
    const match = ctx.match;
    if (!match) return;
    const [, scope, typeStr, channelRaw] = match;
    const channel = channelRaw as "email" | "telegram";
    if (channelRaw === "nop") {
      await ctx.answerCbQuery();
      return;
    }
    const user = await this.getUser(ctx);
    if (!user) {
      await ctx.answerCbQuery("请先绑定账户");
      return;
    }
    if (scope === "admin" && !user.super_admin) {
      await ctx.answerCbQuery("无权限");
      return;
    }
    if (scope === "user") {
      if (channel === "email" && !supportsEmailNotification(typeStr)) {
        await ctx.answerCbQuery("节点通知仅支持 Telegram");
        return;
      }
      const subs = normalizeNotifySubscriptions(user.notify_subscriptions);
      const flags = subs[typeStr] ?? { email: false, telegram: false };
      flags[channel] = !flags[channel];
      subs[typeStr] = flags;
      await db.user.update({
        where: { id: user.id },
        data: { notify_subscriptions: subs as unknown as Prisma.InputJsonValue },
      });
      const adminSubs = user.super_admin
        ? buildAdminNotifySubscriptionsResponse(user.admin_notify_subscriptions)
        : null;
      await ctx.editMessageReplyMarkup({
        inline_keyboard: this.buildNotifyKeyboard(subs, adminSubs),
      });
    } else {
      const subs = buildAdminNotifySubscriptionsResponse(user.admin_notify_subscriptions);
      const flags = subs[typeStr] ?? { email: false, telegram: false };
      flags[channel] = !flags[channel];
      subs[typeStr] = flags;
      await db.user.update({
        where: { id: user.id },
        data: { admin_notify_subscriptions: subs as unknown as Prisma.InputJsonValue },
      });
      const userSubs = normalizeNotifySubscriptions(user.notify_subscriptions);
      await ctx.editMessageReplyMarkup({
        inline_keyboard: this.buildNotifyKeyboard(userSubs, subs),
      });
    }
    await ctx.answerCbQuery("已更新");
  }

  private async handleTunnels(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    const tunnels = await db.tunnel.findMany({
      where: { user_id: user.id },
      orderBy: [{ order_by: "desc" }, { id: "desc" }],
      take: 10,
      include: { in_node_group: { select: { name: true } } },
    });
    if (tunnels.length === 0) {
      await ctx.reply("您还没有创建任何隧道。", {
        reply_markup: {
          inline_keyboard: [[{ text: "前往创建", url: `${SITE_URL}/tunnels` }]],
        },
      });
      return;
    }
    const total = await db.tunnel.count({ where: { user_id: user.id } });
    const lines = [`*🔗 我的隧道 \\(共 ${total} 条，显示前 ${tunnels.length} 条\\)*`, ""];
    for (const t of tunnels) {
      const statusIcon = t.status === Status.active ? "🟢" : "⚪️";
      lines.push(
        `${statusIcon} *${esc(t.name)}* \\| ${esc(t.tunnel_type)} \\| ${esc(t.in_node_group.name)}${t.listen_port ? ` \\| 端口 ${t.listen_port}` : ""} \\| ${esc(formatGB(t.traffic))}`,
      );
    }
    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[{ text: "查看全部", url: `${SITE_URL}/tunnels` }]],
      },
    });
  }

  private async handleNodes(ctx: BotContext): Promise<void> {
    const user = await this.requireUser(ctx);
    if (!user) return;
    const [groups, allSysinfo] = await Promise.all([
      db.nodeGroup.findMany({
        where: { user_id: user.id },
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        include: { nodes: { select: { id: true } } },
      }),
      this.redisService.getSysinfo(),
    ]);
    if (groups.length === 0) {
      await ctx.reply("您还没有创建任何节点组。", {
        reply_markup: {
          inline_keyboard: [[{ text: "前往创建", url: `${SITE_URL}/node-groups` }]],
        },
      });
      return;
    }
    const cutoff = Date.now() - 60000;
    const lines = ["*📁 我的节点组*", ""];
    for (const group of groups) {
      const groupSysinfo = allSysinfo[group.id] ?? [];
      const onlineCount = groupSysinfo.filter((s) => new Date(s.last_active ?? 0).getTime() >= cutoff).length;
      const typeLabel = group.node_type === NodeType.in ? "入" : "出";
      const healthIcon =
        group.nodes.length === 0
          ? "⚪️"
          : onlineCount === group.nodes.length
            ? "🟢"
            : onlineCount > 0
              ? "🟡"
              : "🔴";
      lines.push(
        `${healthIcon} *${esc(group.name)}* \\[${typeLabel}\\] — 在线 ${onlineCount}/${group.nodes.length}`,
      );
    }
    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[{ text: "查看全部", url: `${SITE_URL}/node-groups` }]],
      },
    });
  }

  private async handleStats(ctx: BotContext): Promise<void> {
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [userCount, nodeCount, allSysinfo, todayTopup, openTickets, activeTunnels] = await Promise.all([
      db.user.count(),
      db.node.count(),
      this.redisService.getSysinfo(),
      db.topupOrder.aggregate({
        where: { status: "success", updated_at: { gte: startOfDay } },
        _sum: { price: true },
        _count: { _all: true },
      }),
      db.ticket.count({ where: { status: "open" } }),
      db.tunnel.count({ where: { status: Status.active } }),
    ]);
    const cutoff = Date.now() - 60000;
    let onlineNodes = 0;
    for (const nodes of Object.values(allSysinfo)) {
      for (const sysinfo of nodes) {
        if (new Date(sysinfo.last_active ?? 0).getTime() >= cutoff) onlineNodes++;
      }
    }
    const lines = [
      "*📊 系统数据概览*",
      "",
      `👥 用户总数：*${userCount}*`,
      `🖥 节点：*在线 ${onlineNodes} / 共 ${nodeCount}*`,
      `🔗 活跃隧道：*${activeTunnels}*`,
      `💰 今日充值：*¥${esc((todayTopup._sum.price ?? 0).toString())}* \\(${todayTopup._count._all} 笔\\)`,
      `🎫 待处理工单：*${openTickets}*`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "管理后台", url: `${SITE_URL}/admin` },
            { text: "工单", url: `${SITE_URL}/admin/tickets` },
          ],
        ],
      },
    });
  }

  async sendMessage(
    tg_id: number,
    message: string,
    buttons?: NotifyButton[],
    callbackButtons?: NotifyCallbackButton[],
  ): Promise<void> {
    const inline_keyboard: InlineKeyboardButton[][] = [];
    if (buttons?.length) {
      inline_keyboard.push(buttons.map((b) => ({ text: b.text, url: b.url })));
    }
    if (callbackButtons?.length) {
      inline_keyboard.push(callbackButtons.map((b) => ({ text: b.text, callback_data: b.callback_data })));
    }
    await this.api?.call(
      "sendMessage",
      {
        chat_id: tg_id,
        text: message,
        parse_mode: "MarkdownV2",
        ...(inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {}),
        link_preview_options: { is_disabled: true },
      },
      20000,
    );
  }
}

/** Self-registration. */
export const telegramService = service<TelegramService>(
  TOKENS.Telegram,
  () => new TelegramService(redisService),
);
