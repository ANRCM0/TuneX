import { z } from "zod";
import {
  NodeType,
  Status,
  SystemConfigName,
  TunnelType,
} from "@prisma/client";
import {
  AdminNotifyType,
  NotifyType,
} from "../services/notify-types";
import {
  BalanceLogSchema,
  CommissionLogSchema,
  NodeGroupSchema,
  NodeSchema,
  PaymentSchema,
  PlanSchema,
  TopupOrderSchema,
  TunnelSchema,
  UserPlanSchema,
  UserSchema,
} from "../generated/zod";

/**
 * Upstream: src/schemas/response.ts (312 lines) — ported 1:1.
 *
 * These schemas feed `describeRoute`'s 200-response documentation only; the handlers
 * build their payloads by hand. They are still mirrored exactly because they are the
 * published OpenAPI contract.
 */

export const TunnelResponseSchemaItem = TunnelSchema.omit({
  forward_addresses: true,
  listen_protocol: true,
  forward_addresses_protocol: true,
}).extend({
  user: UserSchema.pick({ email: true }),
  created_at: z.string(),
  updated_at: z.string(),
  port_conflict_at: z.string().nullable(),
  in_node_group: z.object({
    name: z.string(),
    traffic_rate: z.number(),
    connect_ip: z.string().nullable(),
    admission: z.boolean(),
    nodes: z.array(z.object({ connect_ip: z.string() })),
  }),
  out_node_group: z.object({
    name: z.string(),
    traffic_rate: z.number(),
  }),
  out_ports: z.record(z.string(), z.number()),
  forward_addresses: z.array(
    z.object({
      address: z.string(),
      weight: z.number(),
      host: z.string().nullable().optional(),
    }),
  ),
  traffic: z.number(),
  traffic_cost: z.number(),
  tunnel_chains: z.array(
    z.object({
      node_group_id: z.number(),
      node_type: z.nativeEnum(NodeType),
    }),
  ),
  listen_protocol: z
    .object({
      type: z.string(),
      username: z.string().nullish(),
      password: z.string().nullish(),
      publicKey: z.string().nullish(),
      clientPrivateKey: z.string().nullish(),
      mtu: z.number().nullish(),
      clientAllowedIPs: z.array(z.string()).nullish(),
      dns: z.array(z.string()).nullish(),
      peers: z
        .array(
          z.object({
            publicKey: z.string(),
            allowedIPs: z.array(z.string()),
            presharedKey: z.string().nullish(),
            persistentKeepalive: z.number().nullish(),
          }),
        )
        .nullish(),
      ca: z.string().nullish(),
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
    .nullable(),
  forward_addresses_protocol: z
    .object({
      type: z.string(),
      username: z.string(),
      password: z.string(),
    })
    .nullable(),
});

export const TunnelResponseSchema = z.object({
  data: z.array(TunnelResponseSchemaItem),
  total: z.number(),
});

export const TunnelTrafficResponseSchema = z.array(
  z.object({
    traffic: z.number(),
    traffic_cost: z.number(),
    date: z.string(),
  }),
);

export const TunnelSummaryResponseSchema = z.array(
  z.object({
    status: z.nativeEnum(Status),
    count: z.number(),
  }),
);

export const PaymentResponseSchemaItem = PaymentSchema.omit({
  config: true,
}).extend({
  config: z.record(z.string(), z.any()),
});

export const PaymentResponseSchema = z.object({
  data: z.array(PaymentResponseSchemaItem),
  total: z.number(),
});

export const NodeGroupResponseSchemaItem = NodeGroupSchema.omit({
  allow_tunnel_types: true,
  allow_out_node_groups: true,
  allow_in_node_groups: true,
  block_protocols: true,
  allow_listen_protocols: true,
  bypass_list: true,
}).extend({
  allow_tunnel_types: z.array(z.nativeEnum(TunnelType)),
  allow_out_node_groups: z.array(z.number()).nullable(),
  allow_in_node_groups: z.array(z.number()).nullable(),
  block_protocols: z.array(z.string()).nullable(),
  allow_listen_protocols: z.array(z.string()).nullable(),
  bypass_list: z.array(z.string()).nullable(),
});

export const NodeGroupResponseSchema = z.object({
  data: z.array(NodeGroupResponseSchemaItem),
  total: z.number(),
});

export const SystemConfigResponseSchema = z.record(
  z.nativeEnum(SystemConfigName),
  z.any(),
);

export const AdminStatsResponseSchema = z.object({
  user: z.array(
    z.object({ status: z.nativeEnum(Status), count: z.number() }),
  ),
  node: z.array(
    z.object({ status: z.nativeEnum(Status), count: z.number() }),
  ),
  node_group: z.array(
    z.object({ node_type: z.nativeEnum(NodeType), count: z.number() }),
  ),
  topup_order: z.array(
    z.object({ date: z.string(), total: z.number() }),
  ),
  plan: z.array(
    z.object({ status: z.nativeEnum(Status), count: z.number() }),
  ),
  topup: z.array(z.object({ date: z.string(), total: z.number() })),
});

export const TopupOrderResponseSchema = z.object({
  data: z.array(
    TopupOrderSchema.extend({
      payment: PaymentSchema.pick({ name: true }),
      user: UserSchema.pick({ email: true }),
    }),
  ),
  total: z.number(),
});

export const TopupOrderStatsResponseSchema = z.array(
  z.object({
    date: z.string(),
    total: z.number(),
  }),
);

export const OrderStatsResponseSchema = z.array(
  z.object({
    date: z.string(),
    total: z.number(),
  }),
);

export const LicenseResponseSchema = z.object({
  expired_at: z.string(),
  created_at: z.string(),
  site_url: z.string(),
  type: z.enum(["personal", "business"]).optional(),
});

export const NodeGroupSummaryResponseSchema = NodeGroupSchema.pick({
  id: true,
  name: true,
  node_type: true,
  traffic_rate: true,
  need_out_node_group: true,
  admission: true,
  allow_listen_protocol: true,
}).extend({
  allow_tunnel_types: z.array(z.nativeEnum(TunnelType)),
  allow_listen_protocols: z.array(z.string()).nullable(),
  node_count: z.number(),
});

export const UserPlanResponseSchemaItem = UserPlanSchema.omit({
  whitelist_ips: true,
}).extend({
  whitelist_ips: z.array(z.string()).nullable(),
  user: UserSchema.pick({ id: true, email: true }),
  plan: PlanSchema.pick({ id: true, name: true }),
});

export const UserPlanResponseSchema = z.object({
  data: z.array(UserPlanResponseSchemaItem),
  total: z.number(),
});

export const UserPlanRequestSchema = z.object({
  user_id: z.coerce.number(),
  plan_id: z.coerce.number(),
  expired_at: z.coerce.date().nullable(),
  traffic: z.coerce.number().nullable(),
  max_tunnels: z.coerce.number().int().min(0).nullable(),
});

export const UserPlanUpdateRequestSchema = z.object({
  expired_at: z.coerce.date().nullable(),
  plan_id: z.coerce.number(),
  traffic_used: z.coerce.number(),
  traffic: z.coerce.number().nullable(),
  max_tunnels: z.coerce.number().int().min(0).nullable(),
});

export const NodeResponseSchemaItem = NodeSchema.extend({
  node_group: z.object({
    name: z.string(),
    traffic_rate: z.number(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  last_active: z.string().nullable(),
  upgradeable: z.boolean(),
});

export const NodeResponseSchema = z.object({
  data: z.array(NodeResponseSchemaItem),
  total: z.number(),
});

export const NotifyChannelFlagsResponseSchema = z.object({
  email: z.boolean(),
  telegram: z.boolean(),
});

export const NotifySubscriptionsResponseSchema = z.record(
  z.nativeEnum(NotifyType),
  NotifyChannelFlagsResponseSchema,
);

export const AdminNotifySubscriptionsResponseSchema = z.record(
  z.nativeEnum(AdminNotifyType),
  NotifyChannelFlagsResponseSchema,
);

export const UserResponseSchemaItem = UserSchema.omit({
  notify_subscriptions: true,
  admin_notify_subscriptions: true,
  api_key: true,
}).extend({
  notify_subscriptions: NotifySubscriptionsResponseSchema,
  admin_notify_subscriptions: AdminNotifySubscriptionsResponseSchema,
});

export const UserResponseSchema = z.object({
  data: z.array(UserResponseSchemaItem),
  total: z.number(),
});

export const PlanSummaryResponseSchema = z.array(
  PlanSchema.pick({ id: true, name: true }),
);

export const BalanceLogResponseSchema = z.object({
  data: z.array(
    BalanceLogSchema.extend({
      user: UserSchema.pick({ email: true }),
      created_at: z.string(),
    }),
  ),
  total: z.number(),
});

export const ReferralInfoResponseSchema = z.object({
  referral_url: z.string(),
  commission_rate: z.number(),
  referral_count: z.number(),
  total_earnings: z.number(),
});

export const ReferralStatsResponseSchema = z.array(
  z.object({
    date: z.string(),
    referral_count: z.number(),
    earnings: z.number(),
  }),
);

export const TunnelStatsResponseSchemaItem = z.object({
  id: z.number(),
  name: z.string(),
  client_limit: z.number().nullable(),
  in_node_group: z.object({ id: z.number(), name: z.string() }),
  out_node_group: z
    .object({ id: z.number(), name: z.string() })
    .nullable(),
  stats: z
    .object({
      totalConns: z.number(),
      currentConns: z.number(),
      currentClients: z.array(z.string()).optional(),
      inputBytes: z.number(),
      outputBytes: z.number(),
      totalErrs: z.number(),
    })
    .nullable(),
});

export const TunnelStatsResponseSchema = z.object({
  data: z.array(TunnelStatsResponseSchemaItem),
  total: z.number(),
});

export const AdminTunnelStatsResponseSchemaItem =
  TunnelStatsResponseSchemaItem.extend({
    user: z.object({ email: z.string() }),
  });

export const AdminTunnelStatsResponseSchema = z.object({
  data: z.array(AdminTunnelStatsResponseSchemaItem),
  total: z.number(),
});

export const WhitelistResponseSchema = z.object({
  whitelist_ips: z.array(z.string()),
  whitelist_limit: z.number().nullable(),
});

export const CommissionLogResponseSchema = z.object({
  data: z.array(
    CommissionLogSchema.extend({
      user: UserSchema.pick({ email: true }),
      created_at: z.string(),
    }),
  ),
  total: z.number(),
});
