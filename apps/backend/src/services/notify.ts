import type { Plan, Ticket, User } from "@prisma/client";
import { NodeType } from "@prisma/client";
import { formatDateTime } from "@relayx/shared/date";
import { escapeMarkdown } from "@relayx/shared/telegram";
import { SITE_URL } from "../config";
import { db } from "../db";
import { service } from "../container";
import {
  getAdminChannels,
  getChannels,
} from "./notify-types";
import { emailService, type EmailService } from "./email";
import { telegramService, type TelegramService } from "./telegram";
import { userService, type UserService } from "./user";

/**
 * Upstream: src/services/notify.ts (471 lines) — ported 1:1.
 *
 * The multi-channel dispatcher: every user- and admin-facing notification renders a
 * Telegram MarkdownV2 message and/or an HTML email, then hands each to the matching
 * channel service. Channel selection comes from the frozen helpers in `notify-types.ts`
 * (`getChannels` / `getAdminChannels`), so this module never redefines the subscription
 * normalisation logic.
 */

export interface NotifyField {
  label: string;
  value: string;
}

export interface NotifyButton {
  text: string;
  url: string;
}

export interface NotifyCallbackButton {
  text: string;
  callback_data: string;
}

export interface NotifyDispatchOptions {
  title: string;
  intro: string;
  fields: NotifyField[];
  buttons?: NotifyButton[];
  email: { to: string; enabled: boolean };
  telegram: { tg_id: string | null; enabled: boolean; replyTicketId?: number };
  emoji?: string;
}

export interface NodeNotifyOptions {
  user: User;
  node_id: string;
  group_name: string;
  node_type: NodeType;
  connect_ip: string | null;
  version: string | null;
  custom_line: string | null;
}

export interface NodeDisconnectNotifyOptions extends NodeNotifyOptions {
  last_active: Date;
  online_since?: Date;
}

export interface NodeOnlineNotifyOptions extends NodeNotifyOptions {
  offline_since?: Date;
}

export interface RenewPlanFailedNotifyOptions {
  user: User;
  plan: Plan;
  reason: string;
  expire_at: Date;
}

export interface PlanExpireNotifyOptions {
  user: User;
  plan: Plan;
  expire_at: Date;
  traffic: number | null;
  traffic_used: number;
}

function formatTrafficGB(gb: number | null | undefined): string {
  if (gb === null || gb === undefined) return "无限制";
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  return `${Number(gb.toFixed(2))} GB`;
}

function formatRemaining2(target: Date): string {
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "已到期";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  return `${mins} 分钟`;
}

function formatDuration2(fromMs: number): string {
  const ms = Date.now() - fromMs;
  if (ms <= 0) return "刚刚";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  return `${mins} 分钟`;
}

function truncate(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export class NotifyService {
  private telegramService: TelegramService;
  private userService: UserService;
  private emailService: EmailService;

  constructor(
    telegramService: TelegramService,
    userService: UserService,
    emailService: EmailService,
  ) {
    this.telegramService = telegramService;
    this.userService = userService;
    this.emailService = emailService;
  }

  private esc(value: unknown): string {
    return escapeMarkdown(String(value));
  }

  private buildTelegramMessage(
    title: string,
    fields: NotifyField[],
    emoji?: string,
  ): string {
    const heading = emoji ? `${emoji} ${title}` : title;
    const lines = [`*${this.esc(heading)}*`, ""];
    for (const f of fields) {
      lines.push(`${f.label}：*${this.esc(f.value)}*`);
    }
    return lines.join("\n");
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private renderEmailTemplate(
    title: string,
    intro: string,
    fields: NotifyField[],
    buttons?: NotifyButton[],
  ): { text: string; html: string } {
    const text = [
      title,
      "",
      intro,
      "",
      ...fields.map((field) => `${field.label}：${field.value}`),
      ...(buttons?.length ? ["", ...buttons.map((b) => `${b.text}：${b.url}`)] : []),
    ].join("\n");
    const buttonHtml = buttons?.length
      ? `<div style="margin-top:24px;">${buttons
          .map(
            (b) =>
              `<a href="${b.url}" style="display:inline-block;padding:10px 20px;margin-right:8px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">${this.escapeHtml(b.text)}</a>`,
          )
          .join("")}</div>`
      : "";
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif;line-height:1.6;color:#0f172a;background:#f8fafc;padding:24px;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <div style="padding:20px 24px;background:#0f172a;color:#ffffff;">
            <h2 style="margin:0;font-size:20px;">${this.escapeHtml(title)}</h2>
          </div>
          <div style="padding:20px 24px;">
            <p style="margin:0 0 16px 0;color:#334155;">${this.escapeHtml(intro)}</p>
            <table style="width:100%;border-collapse:collapse;">
              <tbody>
                ${fields
                  .map(
                    (field) => `
                      <tr>
                        <td style="padding:10px 0;border-top:1px solid #e2e8f0;color:#64748b;width:128px;vertical-align:top;">${this.escapeHtml(field.label)}</td>
                        <td style="padding:10px 0;border-top:1px solid #e2e8f0;color:#0f172a;white-space:pre-wrap;">${this.escapeHtml(field.value)}</td>
                      </tr>
                    `,
                  )
                  .join("")}
              </tbody>
            </table>
            ${buttonHtml}
          </div>
        </div>
      </div>
    `;
    return { text, html };
  }

  async dispatch(opts: NotifyDispatchOptions): Promise<void> {
    const { title, intro, fields, buttons, email, telegram: tg, emoji } = opts;
    if (tg.enabled && tg.tg_id) {
      const message = this.buildTelegramMessage(title, fields, emoji);
      const callbackButtons: NotifyCallbackButton[] | undefined = tg.replyTicketId
        ? [{ text: "💬 快捷回复", callback_data: `ticket:reply:${tg.replyTicketId}` }]
        : undefined;
      await this.telegramService.sendMessage(Number(tg.tg_id), message, buttons, callbackButtons);
    }
    if (email.enabled) {
      const { text, html } = this.renderEmailTemplate(title, intro, fields, buttons);
      await this.emailService.sendEmail(email.to, title, text, html);
    }
  }

  async notifyTopup(order: {
    user_id: number;
    payment_id: number;
    price: number;
    bonus: number;
    order_id: string;
  }): Promise<void> {
    const user = await db.user.findUnique({
      where: { id: order.user_id },
      select: {
        email: true,
        tg_id: true,
        balance: true,
        notify_subscriptions: true,
      },
    });
    if (!user) return;

    const payment = await db.payment.findUnique({
      where: { id: order.payment_id },
      select: { name: true },
    });

    const totalAmount = order.price + order.bonus;
    const balanceBefore = user.balance - totalAmount;
    const time = formatDateTime(new Date());
    const paymentName = payment?.name ?? "未知";
    const sharedFields: NotifyField[] = [
      { label: "订单号", value: order.order_id },
      { label: "支付方式", value: paymentName },
      { label: "充值金额", value: `¥${order.price}` },
      { label: "赠送金额", value: `¥${order.bonus}` },
      { label: "充值前余额", value: `¥${balanceBefore.toFixed(2)}` },
      { label: "当前余额", value: `¥${user.balance}` },
      { label: "充值时间", value: time },
    ];

    const superAdmins = await this.userService.getSuperAdmins();
    if (superAdmins.length > 0) {
      const adminFields: NotifyField[] = [
        { label: "用户邮箱", value: user.email },
        ...sharedFields,
      ];
      const adminButtons: NotifyButton[] = [
        { text: "查看充值记录", url: `${SITE_URL}/admin/topups` },
      ];
      for (const admin of superAdmins) {
        const channels = getAdminChannels(admin.admin_notify_subscriptions, "user_topup");
        await this.dispatch({
          title: "用户充值通知",
          intro: "有用户完成充值，请关注资金变动。",
          fields: adminFields,
          buttons: adminButtons,
          email: { to: admin.email, enabled: channels.email },
          telegram: { tg_id: admin.tg_id, enabled: channels.telegram },
          emoji: "💰",
        });
      }
    }

    const channels = getChannels(user.notify_subscriptions, "topup");
    if (!channels.email && !channels.telegram) return;
    await this.dispatch({
      title: "充值成功通知",
      intro: "您的账户余额已更新。",
      fields: sharedFields,
      buttons: [
        { text: "查看充值记录", url: `${SITE_URL}/topups` },
        { text: "查看账户", url: `${SITE_URL}/account` },
      ],
      email: { to: user.email, enabled: channels.email },
      telegram: { tg_id: user.tg_id, enabled: channels.telegram },
      emoji: "✅",
    });
  }

  async notifySubscribePlan(
    user: User,
    plan: Plan,
    price: number,
    balance: number,
  ): Promise<void> {
    const channels = getChannels(user.notify_subscriptions, "subscribe_plan");
    if (!channels.email && !channels.telegram) return;

    const userPlan = await db.userPlan.findUnique({ where: { user_id: user.id } });
    if (!userPlan) return;

    const fields: NotifyField[] = [
      { label: "套餐名称", value: plan.name },
      { label: "计费周期", value: plan.billing_cycle },
      { label: "套餐价格", value: `¥${price}` },
      { label: "当前余额", value: `¥${balance}` },
      { label: "流量额度", value: formatTrafficGB(userPlan.traffic) },
      {
        label: "隧道上限",
        value: userPlan.max_tunnels !== null ? `${userPlan.max_tunnels} 条` : "无限制",
      },
      {
        label: "到期时间",
        value: userPlan.expired_at ? formatDateTime(userPlan.expired_at) : "永久有效",
      },
      { label: "自动续费", value: user.auto_renew ? "已开启" : "未开启" },
      { label: "订阅时间", value: formatDateTime(new Date()) },
    ];

    await this.dispatch({
      title: "套餐订阅成功",
      intro: "您的套餐已生效。",
      fields,
      buttons: [
        { text: "查看我的套餐", url: `${SITE_URL}/account` },
        { text: "管理隧道", url: `${SITE_URL}/tunnels` },
      ],
      email: { to: user.email, enabled: channels.email },
      telegram: { tg_id: user.tg_id, enabled: channels.telegram },
      emoji: "🎁",
    });
  }

  async notifyNodeRegister(opts: NodeNotifyOptions): Promise<void> {
    const channels = getChannels(opts.user.notify_subscriptions, "node_register");
    if (!channels.email && !channels.telegram) return;

    const fields: NotifyField[] = [
      { label: "节点 ID", value: opts.node_id },
      { label: "节点组", value: opts.group_name },
      { label: "节点类型", value: opts.node_type === NodeType.in ? "入口节点" : "出口节点" },
      { label: "连接地址", value: opts.connect_ip || "未知" },
      { label: "节点版本", value: opts.version || "unknown" },
      ...(opts.custom_line ? [{ label: "线路", value: opts.custom_line }] : []),
      { label: "注册时间", value: formatDateTime(new Date()) },
    ];

    await this.dispatch({
      title: "节点注册通知",
      intro: "检测到节点注册成功。",
      fields,
      buttons: [{ text: "查看节点组", url: `${SITE_URL}/node-groups` }],
      email: { to: opts.user.email, enabled: channels.email },
      telegram: { tg_id: opts.user.tg_id, enabled: channels.telegram },
      emoji: "🟢",
    });
  }

  async notifyRenewPlanFailed(opts: RenewPlanFailedNotifyOptions): Promise<void> {
    const { user, plan, reason, expire_at } = opts;
    const channels = getChannels(user.notify_subscriptions, "renew_plan_failed");
    if (!channels.email && !channels.telegram) return;

    const shortfall = Math.max(0, plan.price - user.balance);
    const fields: NotifyField[] = [
      { label: "套餐名称", value: plan.name },
      { label: "计费周期", value: plan.billing_cycle },
      { label: "续费金额", value: `¥${plan.price}` },
      { label: "当前余额", value: `¥${user.balance}` },
      ...(shortfall > 0 ? [{ label: "差额", value: `¥${shortfall.toFixed(2)}` }] : []),
      { label: "失败原因", value: reason },
      { label: "到期时间", value: formatDateTime(expire_at) },
      { label: "续费时间", value: formatDateTime(new Date()) },
    ];

    const buttons: NotifyButton[] =
      reason === "余额不足"
        ? [
            { text: "立即充值", url: `${SITE_URL}/topups` },
            { text: "查看套餐", url: `${SITE_URL}/plans` },
          ]
        : [{ text: "查看套餐", url: `${SITE_URL}/plans` }];

    await this.dispatch({
      title: "套餐续费失败通知",
      intro: "自动续费失败，请尽快处理。",
      fields,
      buttons,
      email: { to: user.email, enabled: channels.email },
      telegram: { tg_id: user.tg_id, enabled: channels.telegram },
      emoji: "❌",
    });
  }

  async notifyNodeDisconnect(opts: NodeDisconnectNotifyOptions): Promise<void> {
    const channels = getChannels(opts.user.notify_subscriptions, "node_disconnect");
    if (!channels.email && !channels.telegram) return;

    const fields: NotifyField[] = [
      { label: "节点 ID", value: opts.node_id },
      { label: "节点组", value: opts.group_name },
      { label: "节点类型", value: opts.node_type === NodeType.in ? "入口节点" : "出口节点" },
      { label: "连接地址", value: opts.connect_ip || "未知" },
      { label: "节点版本", value: opts.version || "unknown" },
      ...(opts.custom_line ? [{ label: "线路", value: opts.custom_line }] : []),
      { label: "最后活跃", value: formatDateTime(opts.last_active) },
      ...(opts.online_since
        ? [{ label: "本次在线时长", value: formatDuration2(opts.online_since.getTime()) }]
        : []),
      { label: "断开时长", value: formatDuration2(opts.last_active.getTime()) },
    ];

    await this.dispatch({
      title: "节点断开连接通知",
      intro: "检测到节点连接中断，请尽快排查。",
      fields,
      buttons: [{ text: "查看节点组", url: `${SITE_URL}/node-groups` }],
      email: { to: opts.user.email, enabled: channels.email },
      telegram: { tg_id: opts.user.tg_id, enabled: channels.telegram },
      emoji: "🔴",
    });
  }

  async notifyNodeOnline(opts: NodeOnlineNotifyOptions): Promise<void> {
    const channels = getChannels(opts.user.notify_subscriptions, "node_online");
    if (!channels.email && !channels.telegram) return;

    const fields: NotifyField[] = [
      { label: "节点 ID", value: opts.node_id },
      { label: "节点组", value: opts.group_name },
      { label: "节点类型", value: opts.node_type === NodeType.in ? "入口节点" : "出口节点" },
      { label: "连接地址", value: opts.connect_ip || "未知" },
      { label: "节点版本", value: opts.version || "unknown" },
      ...(opts.custom_line ? [{ label: "线路", value: opts.custom_line }] : []),
      ...(opts.offline_since
        ? [{ label: "离线时长", value: formatDuration2(opts.offline_since.getTime()) }]
        : []),
      { label: "恢复时间", value: formatDateTime(new Date()) },
    ];

    await this.dispatch({
      title: "节点恢复在线通知",
      intro: "节点已重新连接。",
      fields,
      buttons: [{ text: "查看节点组", url: `${SITE_URL}/node-groups` }],
      email: { to: opts.user.email, enabled: channels.email },
      telegram: { tg_id: opts.user.tg_id, enabled: channels.telegram },
      emoji: "🟢",
    });
  }

  async notifyPlanExpire(opts: PlanExpireNotifyOptions): Promise<void> {
    const { user, plan, expire_at, traffic, traffic_used } = opts;
    const channels = getChannels(user.notify_subscriptions, "plan_expire");
    if (!channels.email && !channels.telegram) return;

    const trafficLine =
      traffic !== null
        ? `${formatTrafficGB(traffic_used)} / ${formatTrafficGB(traffic)}`
        : `${formatTrafficGB(traffic_used)} / 无限制`;
    const renewable = plan.renewable && plan.status === "active";

    const fields: NotifyField[] = [
      { label: "套餐名称", value: plan.name },
      { label: "续费金额", value: `¥${plan.price}` },
      { label: "当前余额", value: `¥${user.balance}` },
      { label: "流量使用", value: trafficLine },
      { label: "到期时间", value: formatDateTime(expire_at) },
      { label: "剩余时间", value: formatRemaining2(expire_at) },
      { label: "自动续费", value: user.auto_renew ? "已开启" : "未开启" },
      { label: "可续费", value: renewable ? "是" : "否" },
    ];

    const buttons: NotifyButton[] = [];
    if (user.balance < plan.price) {
      buttons.push({ text: "立即充值", url: `${SITE_URL}/topups` });
    }
    buttons.push({ text: "查看套餐", url: `${SITE_URL}/plans` });

    await this.dispatch({
      title: "套餐到期提醒",
      intro: "您的套餐即将到期，请及时续费。",
      fields,
      buttons,
      email: { to: user.email, enabled: channels.email },
      telegram: { tg_id: user.tg_id, enabled: channels.telegram },
      emoji: "⏰",
    });
  }

  async notifyTicketCreated(ticket: Ticket, user: User): Promise<void> {
    const superAdmins = await this.userService.getSuperAdmins();
    if (superAdmins.length === 0) return;

    const adminTicketUrl = `${SITE_URL}/admin/tickets/${ticket.id}`;
    const userPlan = await db.userPlan.findUnique({
      where: { user_id: user.id },
      include: { plan: { select: { name: true } } },
    });

    const fields: NotifyField[] = [
      { label: "用户邮箱", value: user.email },
      { label: "用户余额", value: `¥${user.balance}` },
      { label: "当前套餐", value: userPlan?.plan.name ?? "无" },
      { label: "工单标题", value: ticket.title },
      { label: "工单内容", value: truncate(ticket.content, 200) },
      { label: "提交时间", value: formatDateTime(new Date()) },
    ];
    const buttons: NotifyButton[] = [{ text: "立即处理", url: adminTicketUrl }];

    for (const admin of superAdmins) {
      const channels = getAdminChannels(admin.admin_notify_subscriptions, "ticket_created");
      await this.dispatch({
        title: "新工单通知",
        intro: "有用户提交了新的支持工单，请及时处理。",
        fields,
        buttons,
        email: { to: admin.email, enabled: channels.email },
        telegram: {
          tg_id: admin.tg_id,
          enabled: channels.telegram,
          replyTicketId: ticket.id,
        },
        emoji: "🎫",
      });
    }
  }

  async notifyTicketReplied(
    ticket: Ticket,
    replierEmail: string,
    isAdmin: boolean,
    replyContent: string,
  ): Promise<void> {
    if (isAdmin) {
      const owner = await db.user.findUnique({
        where: { id: ticket.user_id },
        select: { email: true, tg_id: true, notify_subscriptions: true },
      });
      if (!owner) return;

      const channels = getChannels(owner.notify_subscriptions, "ticket_replied");
      if (!channels.email && !channels.telegram) return;

      const userTicketUrl = `${SITE_URL}/tickets/${ticket.id}`;
      const fields: NotifyField[] = [
        { label: "工单标题", value: ticket.title },
        { label: "回复人", value: "管理员" },
        { label: "回复内容", value: truncate(replyContent, 200) },
        { label: "回复时间", value: formatDateTime(new Date()) },
      ];

      await this.dispatch({
        title: "工单回复通知",
        intro: "您的工单收到了管理员的回复，请登录查看。",
        fields,
        buttons: [{ text: "查看工单", url: userTicketUrl }],
        email: { to: owner.email, enabled: channels.email },
        telegram: {
          tg_id: owner.tg_id,
          enabled: channels.telegram,
          replyTicketId: ticket.id,
        },
        emoji: "💬",
      });
    } else {
      const superAdmins = await this.userService.getSuperAdmins();
      if (superAdmins.length === 0) return;

      const adminTicketUrl = `${SITE_URL}/admin/tickets/${ticket.id}`;
      const fields: NotifyField[] = [
        { label: "用户邮箱", value: replierEmail },
        { label: "工单标题", value: ticket.title },
        { label: "回复内容", value: truncate(replyContent, 200) },
        { label: "回复时间", value: formatDateTime(new Date()) },
      ];

      for (const admin of superAdmins) {
        const channels = getAdminChannels(admin.admin_notify_subscriptions, "ticket_replied");
        await this.dispatch({
          title: "工单用户回复通知",
          intro: "用户对工单进行了回复，请及时处理。",
          fields,
          buttons: [{ text: "立即回复", url: adminTicketUrl }],
          email: { to: admin.email, enabled: channels.email },
          telegram: {
            tg_id: admin.tg_id,
            enabled: channels.telegram,
            replyTicketId: ticket.id,
          },
          emoji: "💬",
        });
      }
    }
  }
}

/**
 * Self-registration. `TOKENS` has no dedicated Notify entry (upstream resolves the class
 * itself), so the replica uses the class-derived token name, which the container's
 * `Token` type accepts as a plain string.
 */
export const notifyService = service<NotifyService>(
  "NotifyService",
  () => new NotifyService(telegramService, userService, emailService),
);
