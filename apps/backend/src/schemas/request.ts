import { z } from "zod";
import {
  BypassType,
  DNSProviderType,
  IpType,
  LoadBalanceType,
  NodeType,
  Status,
  SystemConfigName,
  TopupActivityType,
  TopupOrderStatus,
  TunnelType,
  BalanceLogType,
  CommissionLogType,
} from "@prisma/client";
import { AdminNotifyType, NotifyType } from "../services/notify-types";
import {
  NodeGroupSchema,
  PaymentSchema,
  TunnelSchema,
  UserSchema,
} from "../generated/zod";

/**
 * Upstream: src/schemas/request.ts (277 lines) — ported 1:1.
 *
 * These schemas are the API's input contract and are wired into the routes through
 * `@hono/zod-validator`, so unlike the response schemas they must reject exactly what the
 * original rejects.
 */

export const IdSchema = z.object({ id: z.coerce.number().int() });

export const TableRequestSchema = z.object({
  page: z.coerce.number().positive().default(1),
  perPage: z.coerce.number().int().default(10),
  sort: z
    .string()
    .transform((val) => JSON.parse(val))
    .nullish(),
});

export const TunnelChainSchema = z.object({
  node_group_id: z.number(),
  node_type: z.nativeEnum(NodeType),
});

export const ALLOWED_SHADOWSOCKS_METHODS = [
  "chacha20-ietf-poly1305",
  "aes-128-gcm",
  "aes-256-gcm",
];

export const WireGuardPeerSchema = z.object({
  publicKey: z.string(),
  allowedIPs: z.array(z.string()).default([]),
  presharedKey: z.string().nullish(),
  persistentKeepalive: z.number().int().nullish(),
});

export const ProtocolSchema = z
  .object({
    type: z.string().nullish(),
    username: z.string().nullish(),
    password: z.string().nullish(),
    privateKey: z.string().nullish(),
    publicKey: z.string().nullish(),
    clientPrivateKey: z.string().nullish(),
    mtu: z.number().int().nullish(),
    clientAllowedIPs: z.array(z.string()).nullish(),
    dns: z.array(z.string()).nullish(),
    peers: z.array(WireGuardPeerSchema).nullish(),
    ca: z.string().nullish(),
    cert: z.string().nullish(),
    key: z.string().nullish(),
    clientCert: z.string().nullish(),
    clientKey: z.string().nullish(),
    tlsCrypt: z.string().nullish(),
    udp: z.boolean().nullish(),
    cipher: z.string().nullish(),
    auth: z.string().nullish(),
    server: z.string().nullish(),
    uuid: z.string().nullish(),
    dest: z.string().nullish(),
    shortId: z.string().nullish(),
  })
  .nullable()
  .refine(
    (data) => {
      if (!data || !data.type || data.type !== "ss") {
        return true;
      }
      if (!data.username) {
        return false;
      }
      return ALLOWED_SHADOWSOCKS_METHODS.includes(data.username);
    },
    {
      message: `Shadowsocks 加密方式只能是: ${ALLOWED_SHADOWSOCKS_METHODS.join(", ")}`,
    },
  );

export const ForwardAddressSchema = z.object({
  address: z.string(),
  weight: z.number(),
  host: z.string().nullable().optional(),
});

export const TunnelRequestSchema = TunnelSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  user_id: true,
  forward_addresses: true,
  order_by: true,
  listen_protocol: true,
  forward_addresses_protocol: true,
  traffic: true,
  traffic_cost: true,
  port_conflict_at: true,
}).extend({
  forward_addresses: z.array(ForwardAddressSchema),
  tunnel_chains: z.array(TunnelChainSchema).optional(),
  listen_protocol: ProtocolSchema,
  forward_addresses_protocol: ProtocolSchema,
});

export const TunnelImportRequestSchema = z.object({
  in_node_group_id: z.number(),
  out_node_group_id: z.number().nullable(),
  tunnel_type: z.nativeEnum(TunnelType),
  tunnels: z.array(
    z.object({
      dest: z.array(z.string()),
      listen_port: z.number().nullable(),
      name: z.string(),
    }),
  ),
  random_port_is_exist: z.boolean(),
  overwrite_tunnel_on_port_conflict: z.boolean(),
});

export const BatchIdSchema = z.object({
  ids: z
    .string()
    .transform((val) => val.split(",").map(Number)),
});

export const BatchTunnelRequestSchema = z.object({
  ids: z.array(z.number()),
  status: z.nativeEnum(Status).optional(),
  in_node_group_id: z.number().optional(),
  out_node_group_id: z.number().nullable().optional(),
  ip_type: z.nativeEnum(IpType).optional(),
  tunnel_type: z.nativeEnum(TunnelType).optional(),
  load_balance_type: z.nativeEnum(LoadBalanceType).optional(),
  ip_limit: z.number().nullable().optional(),
  client_limit: z.number().nullable().optional(),
  bandwidth_limit: z.number().nullable().optional(),
  in_tunnel_chains: z.array(z.number()).nullable().optional(),
  out_tunnel_chains: z.array(z.number()).nullable().optional(),
});

export const PaymentRequestSchema = PaymentSchema.pick({
  name: true,
  url: true,
  method: true,
  status: true,
  fixed_fee: true,
  type: true,
  percent_fee: true,
}).extend({
  config: z.record(z.string(), z.string()),
});

export const NodeGroupRequestSchema = NodeGroupSchema.pick({
  name: true,
  node_type: true,
  load_balance_type: true,
  connect_ip: true,
  need_out_node_group: true,
  port_range: true,
  allow_listen_protocol: true,
  admission: true,
}).extend({
  traffic_rate: z.coerce.number(),
  allow_tunnel_types: z.array(z.nativeEnum(TunnelType)).nullable(),
  allow_out_node_groups: z.array(z.number()).nullable(),
  allow_in_node_groups: z.array(z.number()).nullable(),
  block_protocols: z.array(z.string()).nullable(),
  allow_listen_protocols: z.array(z.string()).nullable(),
  bypass_type: z.nativeEnum(BypassType).default(BypassType.blacklist),
  bypass_list: z.array(z.string()).nullable(),
});

export const NodeGroupQuerySchema = TableRequestSchema.extend({
  name: z.string().optional(),
  connect_ip: z.string().optional(),
  node_type: z.nativeEnum(NodeType).optional(),
  email: z.string().optional(),
});

export const SystemConfigUpdateSchema = z.record(z.nativeEnum(SystemConfigName), z.any());

export const TopupOrderQuerySchema = TableRequestSchema.extend({
  status: z.nativeEnum(TopupOrderStatus).optional(),
  payment: z.coerce.number().optional(),
  order_id: z.string().optional(),
  email: z.string().optional(),
});

export const TopupActivityQuerySchema = TableRequestSchema.extend({
  type: z.nativeEnum(TopupActivityType).optional(),
});

export const BalanceLogQuerySchema = TableRequestSchema.extend({
  type: z.nativeEnum(BalanceLogType).optional(),
  email: z.string().optional(),
});

export const CommissionLogQuerySchema = TableRequestSchema.extend({
  type: z.nativeEnum(CommissionLogType).optional(),
  email: z.string().optional(),
});

export const NodeQuerySchema = TableRequestSchema.extend({
  node_group_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  ip: z.string().nullish(),
  node_id: z.string().optional(),
  status: z.nativeEnum(Status).nullish(),
  node_type: z.nativeEnum(NodeType).nullish(),
  version: z
    .string()
    .transform((val) => val === "true")
    .nullish(),
  backup: z
    .string()
    .transform((val) => val === "true")
    .nullish(),
});

export const NotifyChannelFlagsSchema = z.object({
  email: z.boolean(),
  telegram: z.boolean(),
});

export const NotifySubscriptionsSchema = z.record(
  z.nativeEnum(NotifyType),
  NotifyChannelFlagsSchema,
);

export const AdminNotifySubscriptionsSchema = z.record(
  z.nativeEnum(AdminNotifyType),
  NotifyChannelFlagsSchema,
);

export const UserUpdateSchema = z.object({
  notify_subscriptions: NotifySubscriptionsSchema.optional(),
  admin_notify_subscriptions: AdminNotifySubscriptionsSchema.optional(),
  auto_renew: z.boolean().optional(),
  api_key: z.boolean().optional(),
  subscription_key: z.boolean().optional(),
});

export const UserRequestSchema = UserSchema.pick({
  email: true,
  status: true,
  super_admin: true,
  auto_renew: true,
  tg_id: true,
  note: true,
  referral_commission_rate: true,
  referral_first_only: true,
}).extend({
  password: z.string().min(6, "密码至少6个字符").optional(),
  admin_role_ids: z.array(z.number()).optional(),
});

export const BalanceAdjustSchema = z.object({
  amount: z.number().refine((v) => v !== 0, { message: "金额不能为 0" }),
});

export const TunnelQuerySchema = TableRequestSchema.extend({
  name: z.string().nullish(),
  in_node_group_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  out_node_group_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  in_tunnel_chain_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  out_tunnel_chain_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  status: z
    .union([
      z.array(z.nativeEnum(Status)),
      z.nativeEnum(Status).transform((val) => [val]),
    ])
    .nullish(),
  ip_type: z.nativeEnum(IpType).optional(),
  tunnel_type: z
    .union([
      z.array(z.nativeEnum(TunnelType)),
      z.nativeEnum(TunnelType).transform((val) => [val]),
    ])
    .nullish(),
  listen_port: z.coerce.number().nullish(),
});

export const TunnelTrafficQuerySchema = TableRequestSchema.extend({
  tunnel_name: z.string().optional(),
  in_node_group_id: z.coerce.number().optional(),
  out_node_group_id: z.coerce.number().optional(),
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
});

export const TunnelTrafficStatsQuerySchema = z.object({
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
  in_node_group_id: z.coerce.number().optional(),
  out_node_group_id: z.coerce.number().optional(),
  aggregate_by: z.enum(["day", "month", "year"]).default("day"),
});

export const TunnelStatsQuerySchema = TableRequestSchema.extend({
  name: z.string().nullish(),
  in_node_group_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
  out_node_group_id: z
    .union([
      z.array(z.coerce.number()),
      z.coerce.number().transform((val) => [val]),
    ])
    .nullish(),
});

export const AdminStatsQuerySchema = z.object({
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
  aggregate_by: z.enum(["day", "month", "year"]).default("day"),
});

export const ReferralStatsQuerySchema = z.object({
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
  aggregate_by: z.enum(["day", "month", "year"]).default("day"),
});

export const AdminTunnelRequestSchema = TunnelRequestSchema.extend({
  user_id: z.number(),
});

export const DNSProviderRequestSchema = z.object({
  name: z.string().min(1, "名称不能为空"),
  type: z.nativeEnum(DNSProviderType),
  config: z.record(z.string(), z.string()),
});

export const DNSProviderQuerySchema = TableRequestSchema.extend({
  name: z.string().optional(),
  type: z.nativeEnum(DNSProviderType).optional(),
});

export const InNodeGroupDNSRequestSchema = z.object({
  in_node_group_id: z.number(),
  dns_provider_id: z.number(),
  ttl: z.number().int().min(1).default(60),
  custom_line: z.record(z.string(), z.string()).nullable().optional(),
  ipv6: z.boolean().default(false),
  status: z.nativeEnum(Status).default(Status.active),
});

export const InNodeGroupDNSQuerySchema = TableRequestSchema.extend({
  in_node_group_id: z.coerce.number().optional(),
  dns_provider_id: z.coerce.number().optional(),
  status: z.nativeEnum(Status).optional(),
});

export const BatchUserPlanRequestSchema = z.object({
  ids: z.array(z.number()),
  add_days: z.number().int().optional(),
  add_traffic: z.number().optional(),
});

export const WhitelistUpdateSchema = z.object({
  whitelist_ips: z.array(z.string()),
});
