/**
 * Zod schemas mirroring the Prisma models.
 *
 * GENERATED FILE — do not edit by hand. Run `pnpm --filter @relayx/backend zod:generate`
 * (scripts/generate-zod.mjs) after changing prisma/schema.prisma.
 *
 * Upstream ships `src/generated/prisma/zod/index.ts` — a 17,534-line file emitted by a
 * zod generator. The replica keeps the same export names (`TunnelSchema`, `UserSchema`,
 * …) but models scalar columns only: the upstream file additionally emitted every
 * relation and every Prisma input/aggregate type, none of which the replica's route
 * layer consumes (see docs/DEVIATIONS.md §4).
 */
import { z } from "zod";
import {
  NodeType,
  Status,
  BypassType,
  LoadBalanceType,
  TunnelType,
  IpType,
  TunnelCategory,
  BillingCycle,
  TopupOrderStatus,
  TopupActivityType,
  SystemConfigName,
  PaymentMethod,
  CouponType,
  BalanceLogType,
  CommissionLogType,
  WithdrawStatus,
  TicketStatus,
  DNSProviderType,
} from "@prisma/client";

/** The `Json` column type: any JSON value. */
export const jsonSchema: z.ZodType<unknown> = z.any();

export const NodeGroupSchema = z.object({
  id: z.number().int(),
  token: z.string(),
  name: z.string(),
  port_range: z.string().nullable(),
  connect_ip: z.string().nullable(),
  node_type: z.nativeEnum(NodeType),
  load_balance_type: z.nativeEnum(LoadBalanceType),
  allow_listen_protocol: z.boolean(),
  allow_listen_protocols: jsonSchema.nullable(),
  allow_tunnel_types: jsonSchema.nullable(),
  bypass_type: z.nativeEnum(BypassType),
  bypass_list: jsonSchema.nullable(),
  admission: z.boolean(),
  block_protocols: jsonSchema.nullable(),
  traffic_rate: z.number(),
  need_out_node_group: z.boolean(),
  allow_out_node_groups: jsonSchema.nullable(),
  allow_in_node_groups: jsonSchema.nullable(),
  order_by: z.number(),
  created_at: z.date(),
  updated_at: z.date(),
  user_id: z.number().int(),
});

export type NodeGroup = z.infer<typeof NodeGroupSchema>;

export const NodeSchema = z.object({
  id: z.number().int(),
  weight: z.number().int(),
  status: z.nativeEnum(Status),
  node_id: z.string(),
  connect_ip: z.string(),
  version: z.string(),
  backup: z.boolean(),
  order_by: z.number(),
  custom_line: z.string().nullable(),
  dns_status: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
  node_group_id: z.number().int(),
});

export type Node = z.infer<typeof NodeSchema>;

export const TunnelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tunnel_type: z.nativeEnum(TunnelType),
  category: z.nativeEnum(TunnelCategory),
  listen_ip: z.string().nullable(),
  listen_port: z.number().int().nullable(),
  listen_protocol: jsonSchema.nullable(),
  port_conflict_at: z.date().nullable(),
  status: z.nativeEnum(Status),
  forward_addresses: jsonSchema,
  forward_addresses_protocol: jsonSchema.nullable(),
  load_balance_type: z.nativeEnum(LoadBalanceType),
  ip_type: z.nativeEnum(IpType),
  order_by: z.number(),
  ip_limit: z.number().int().nullable(),
  client_limit: z.number().int().nullable(),
  bandwidth_limit: z.number().int().nullable(),
  traffic: z.number(),
  traffic_cost: z.number(),
  proxy_protocol: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
  in_node_group_id: z.number().int(),
  out_node_group_id: z.number().int().nullable(),
  user_id: z.number().int(),
});

export type Tunnel = z.infer<typeof TunnelSchema>;

export const TunnelChainSchema = z.object({
  id: z.number().int(),
  tunnel_id: z.number().int(),
  node_type: z.nativeEnum(NodeType),
  node_group_id: z.number().int(),
});

export type TunnelChain = z.infer<typeof TunnelChainSchema>;

export const UserSchema = z.object({
  id: z.number().int(),
  super_admin: z.boolean(),
  email: z.string(),
  balance: z.number(),
  commission_balance: z.number(),
  tg_id: z.string().nullable(),
  uid: z.string().nullable(),
  note: z.string().nullable(),
  parent_id: z.number().int().nullable(),
  referral_commission_rate: z.number().nullable(),
  referral_first_only: z.boolean().nullable(),
  auto_renew: z.boolean(),
  api_key: z.string(),
  subscription_key: z.string(),
  notify_subscriptions: jsonSchema.nullable(),
  admin_notify_subscriptions: jsonSchema.nullable(),
  status: z.nativeEnum(Status),
  created_at: z.date(),
  updated_at: z.date(),
});

export type User = z.infer<typeof UserSchema>;

export const LocalCredentialSchema = z.object({
  user_id: z.number().int(),
  password_hash: z.string(),
  email_verified: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type LocalCredential = z.infer<typeof LocalCredentialSchema>;

export const AdminRoleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: jsonSchema,
  created_at: z.date(),
  updated_at: z.date(),
});

export type AdminRole = z.infer<typeof AdminRoleSchema>;

export const UserPlanSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  traffic: z.number().nullable(),
  traffic_used: z.number(),
  max_tunnels: z.number().int().nullable(),
  whitelist_ips: jsonSchema.nullable(),
  expired_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  plan_id: z.number().int(),
});

export type UserPlan = z.infer<typeof UserPlanSchema>;

export const PlanSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  original_price: z.number().nullable(),
  price: z.number(),
  max_tunnels: z.number().int().nullable(),
  traffic: z.number().int().nullable(),
  ip_limit: z.number().int().nullable(),
  client_limit: z.number().int().nullable(),
  bandwidth_limit: z.number().int().nullable(),
  whitelist_limit: z.number().int().nullable(),
  allow_custom_in_node_group: z.boolean(),
  allow_custom_out_node_group: z.boolean(),
  all_in_node_groups: z.boolean(),
  all_out_node_groups: z.boolean(),
  setup_fee: z.number().nullable(),
  billing_cycle: z.nativeEnum(BillingCycle),
  status: z.nativeEnum(Status),
  renewable: z.boolean(),
  stock: z.number().int().nullable(),
  order_by: z.number(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PlanNodeGroupSchema = z.object({
  id: z.number().int(),
  plan_id: z.number().int(),
  node_group_id: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type PlanNodeGroup = z.infer<typeof PlanNodeGroupSchema>;

export const PlanOrderSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  plan_id: z.number().int(),
  price: z.number(),
  balance: z.number(),
  coupon_id: z.number().int().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type PlanOrder = z.infer<typeof PlanOrderSchema>;

export const TopupOrderSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  price: z.number(),
  balance: z.number(),
  bonus: z.number(),
  payment_id: z.number().int(),
  pay_url: z.string(),
  status: z.nativeEnum(TopupOrderStatus),
  order_id: z.string(),
  trade_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type TopupOrder = z.infer<typeof TopupOrderSchema>;

export const TopupActivitySchema = z.object({
  id: z.number().int(),
  type: z.nativeEnum(TopupActivityType),
  value: z.number(),
  min_amount: z.number().nullable(),
  max_amount: z.number().nullable(),
  valid_start: z.date().nullable(),
  valid_end: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type TopupActivity = z.infer<typeof TopupActivitySchema>;

export const TunnelTrafficSchema = z.object({
  id: z.number().int(),
  tunnel_id: z.number().int(),
  traffic: z.number(),
  traffic_cost: z.number(),
  date: z.date(),
});

export type TunnelTraffic = z.infer<typeof TunnelTrafficSchema>;

export const SystemConfigSchema = z.object({
  id: z.number().int(),
  name: z.nativeEnum(SystemConfigName),
  value: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type SystemConfig = z.infer<typeof SystemConfigSchema>;

export const PaymentSchema = z.object({
  id: z.number().int(),
  fixed_fee: z.number().nullable(),
  percent_fee: z.number().nullable(),
  name: z.string(),
  url: z.string(),
  config: jsonSchema,
  method: z.nativeEnum(PaymentMethod),
  type: z.string().nullable(),
  status: z.nativeEnum(Status),
  order_by: z.number(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Payment = z.infer<typeof PaymentSchema>;

export const PlanCouponSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  type: z.nativeEnum(CouponType),
  valid_cycle: z.nativeEnum(BillingCycle).nullable(),
  value: z.number(),
  valid_start: z.date().nullable(),
  valid_end: z.date().nullable(),
  max_use: z.number().int().nullable(),
  max_use_per_user: z.number().int().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type PlanCoupon = z.infer<typeof PlanCouponSchema>;

export const BalanceLogSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  balance: z.number(),
  amount: z.number(),
  type: z.nativeEnum(BalanceLogType),
  created_at: z.date(),
  updated_at: z.date(),
});

export type BalanceLog = z.infer<typeof BalanceLogSchema>;

export const CommissionLogSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  balance: z.number(),
  amount: z.number(),
  type: z.nativeEnum(CommissionLogType),
  created_at: z.date(),
  updated_at: z.date(),
});

export type CommissionLog = z.infer<typeof CommissionLogSchema>;

export const WithdrawRequestSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  amount: z.number(),
  method: z.string(),
  account: z.string(),
  status: z.nativeEnum(WithdrawStatus),
  remark: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;

export const TicketSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  content: z.string(),
  status: z.nativeEnum(TicketStatus),
  user_id: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Ticket = z.infer<typeof TicketSchema>;

export const TicketReplySchema = z.object({
  id: z.number().int(),
  content: z.string(),
  is_admin: z.boolean(),
  ticket_id: z.number().int(),
  user_id: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type TicketReply = z.infer<typeof TicketReplySchema>;

export const InNodeGroupDNSSchema = z.object({
  id: z.number().int(),
  in_node_group_id: z.number().int(),
  dns_provider_id: z.number().int(),
  ttl: z.number().int(),
  ipv6: z.boolean(),
  status: z.nativeEnum(Status),
  created_at: z.date(),
  updated_at: z.date(),
});

export type InNodeGroupDNS = z.infer<typeof InNodeGroupDNSSchema>;

export const DNSProviderSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.nativeEnum(DNSProviderType),
  config: jsonSchema,
  user_id: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type DNSProvider = z.infer<typeof DNSProviderSchema>;
