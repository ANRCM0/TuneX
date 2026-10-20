/**
 * Upstream: src/services/notify-types.ts (90 lines) — ported verbatim.
 *
 * Shared by the notify service, the user/admin route schemas and the subscription
 * normalisation helpers. Kept in the kernel because `src/schemas/*` depends on it.
 */

export const NotifyType = {
  topup: "topup",
  subscribe_plan: "subscribe_plan",
  node_register: "node_register",
  renew_plan_failed: "renew_plan_failed",
  node_disconnect: "node_disconnect",
  node_online: "node_online",
  plan_expire: "plan_expire",
  ticket_created: "ticket_created",
  ticket_replied: "ticket_replied",
} as const;
export type NotifyType = (typeof NotifyType)[keyof typeof NotifyType];

export const AdminNotifyType = {
  user_topup: "user_topup",
  ticket_created: "ticket_created",
  ticket_replied: "ticket_replied",
} as const;
export type AdminNotifyType = (typeof AdminNotifyType)[keyof typeof AdminNotifyType];

export interface NotifyChannelFlags {
  email: boolean;
  telegram: boolean;
}

/** Node lifecycle notifications are the only ones with no email channel. */
export function supportsEmailNotification(type: string): boolean {
  const emailless: NotifyType[] = [
    NotifyType.node_register,
    NotifyType.node_disconnect,
    NotifyType.node_online,
  ];
  return !emailless.includes(type as NotifyType);
}

/** Accepts both the legacy string[] shape and the current record shape. */
export function normalizeNotifySubscriptions(raw: unknown): Partial<Record<string, NotifyChannelFlags>> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const result: Partial<Record<string, NotifyChannelFlags>> = {};
    for (const type of raw) {
      if (typeof type === "string") {
        result[type] = { email: supportsEmailNotification(type), telegram: true };
      }
    }
    return result;
  }
  if (typeof raw === "object") {
    const result: Partial<Record<string, NotifyChannelFlags>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const v = value as { email?: unknown; telegram?: unknown };
        result[key] = {
          email: supportsEmailNotification(key) && Boolean(v.email),
          telegram: Boolean(v.telegram),
        };
      }
    }
    return result;
  }
  return {};
}

export function getChannels(raw: unknown, type: string): NotifyChannelFlags {
  const map = normalizeNotifySubscriptions(raw);
  return map[type] ?? { email: false, telegram: false };
}

export function normalizeAdminNotifySubscriptions(raw: unknown): Partial<Record<string, NotifyChannelFlags>> {
  const result: Partial<Record<string, NotifyChannelFlags>> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const v = value as { email?: unknown; telegram?: unknown };
        result[key] = { email: Boolean(v.email), telegram: Boolean(v.telegram) };
      }
    }
  }
  return result;
}

/** Unlike user channels, admin channels default to *on* when nothing is stored. */
export function getAdminChannels(raw: unknown, type: string): NotifyChannelFlags {
  if (!raw) {
    return { email: true, telegram: true };
  }
  const map = normalizeAdminNotifySubscriptions(raw);
  return map[type] ?? { email: false, telegram: false };
}

export function buildAdminNotifySubscriptionsResponse(raw: unknown): Record<string, NotifyChannelFlags> {
  const defaults: Record<string, NotifyChannelFlags> = {};
  for (const type of Object.values(AdminNotifyType)) {
    defaults[type] = getAdminChannels(raw, type);
  }
  return defaults;
}
