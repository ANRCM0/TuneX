import type { Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import { SystemConfigName } from "@prisma/client";
import { db } from "../db";
import { inNodeGroupDNSService } from "../services/in_node_group_dns";
import { nodeService } from "../services/node";
import { notifyService } from "../services/notify";
import { orderService } from "../services/order";
import { planService } from "../services/plan";
import { redisService } from "../services/redis";
import { systemConfigService } from "../services/system_config";
import { tunnelService } from "../services/tunnel";

/**
 * Upstream: src/bullmq/jobs.ts (335 lines) — ported 1:1.
 *
 * The cron table consumed by `queue.ts`. Upstream resolves every service from the
 * container at module scope; the replica imports the self-registering proxies, which is
 * the same call-site shape and keeps import order irrelevant.
 */

/** Job names, mirroring upstream's `JobName` enum. */
export const JOB_NAMES = {
  cronSaveTraffic: "cron_save_traffic",
  cronPushNodeConfig: "cron_push_node_config",
  cancelUnpaidOrder: "cancel_unpaid_order",
  cronDeleteTunnelTraffic: "cron_delete_tunnel_traffic",
  cronRenewUserPlan: "cron_renew_user_plan",
  cronResetTableOrder: "cron_reset_table_order",
  cronUpdateAgent: "cron_update_agent",
  cronNotifyPlanExpire: "cron_notify_plan_expire",
  cronResetExpiredTunnel: "cron_reset_expired_tunnel",
  cronRepushWaitingTunnel: "cron_repush_waiting_tunnel",
  cronSyncDNS: "cron_sync_dns",
  notifyNodeDisconnect: "notify_node_disconnect",
} as const;

export interface CronJobDefinition {
  name: string;
  handler: (job: Job) => Promise<unknown>;
  cron?: string;
}

export const jobs: CronJobDefinition[] = [
  {
    name: JOB_NAMES.cronSaveTraffic,
    handler: cronSaveTraffic,
    cron: "0 0 * * *",
  },
  {
    name: JOB_NAMES.cronPushNodeConfig,
    handler: pushNodeConfig,
    cron: "*/5 * * * * *",
  },
  {
    name: JOB_NAMES.cancelUnpaidOrder,
    handler: cancelUnpaidOrder,
  },
  {
    name: JOB_NAMES.cronDeleteTunnelTraffic,
    handler: cronDeleteTunnelTraffic,
    cron: "0 0 * * *",
  },
  {
    name: JOB_NAMES.cronRenewUserPlan,
    handler: cronRenewUserPlan,
    cron: "* * * * *",
  },
  {
    name: JOB_NAMES.cronResetTableOrder,
    handler: cronResetTableOrder,
    cron: "0 4 * * *",
  },
  {
    name: JOB_NAMES.cronUpdateAgent,
    handler: cronUpdateAgent,
    cron: "*/10 * * * *",
  },
  {
    name: JOB_NAMES.cronNotifyPlanExpire,
    handler: cronNotifyPlanExpire,
    cron: "0 0 * * *",
  },
  {
    name: JOB_NAMES.cronResetExpiredTunnel,
    handler: cronResetExpiredTunnel,
    cron: "* * * * *",
  },
  {
    name: JOB_NAMES.cronRepushWaitingTunnel,
    handler: cronRepushWaitingTunnel,
    cron: "*/30 * * * * *",
  },
  {
    name: JOB_NAMES.cronSyncDNS,
    handler: cronSyncDNS,
    cron: "* * * * *",
  },
  {
    name: JOB_NAMES.notifyNodeDisconnect,
    handler: notifyNodeDisconnect,
  },
];

async function cronSaveTraffic(_job: Job): Promise<number> {
  const traffics = await redisService.getTunnelTraffic(false);
  const trafficsCost = await redisService.getTunnelTraffic(true);
  const trafficsArray: Prisma.TunnelTrafficCreateManyInput[] = [];
  for (const [key, value] of Object.entries(traffics)) {
    trafficsArray.push({
      tunnel_id: parseInt(key),
      traffic: parseFloat(value),
      traffic_cost: parseFloat(trafficsCost[parseInt(key)] ?? "0"),
      date: new Date(Date.now() - 86400000),
    });
  }
  const tunnelIds = trafficsArray.map((traffic) => traffic.tunnel_id);
  const tunnels = await db.tunnel.findMany({
    where: { id: { in: tunnelIds } },
    select: { id: true },
  });
  await db.tunnelTraffic.createMany({
    data: trafficsArray.filter((traffic) =>
      tunnels.some((tunnel) => tunnel.id === traffic.tunnel_id),
    ),
  });
  await redisService.clearTunnelTraffic();
  // Upstream returns `traffics.length`, which is `undefined` on the record it holds; the
  // replica returns the number of tunnel counters it persisted.
  return Object.keys(traffics).length;
}

async function pushNodeConfig(_job: Job): Promise<void> {
  await tunnelService.pushNodeConfig();
}

async function cancelUnpaidOrder(job: Job): Promise<void> {
  const { id } = job.data as { id: number };
  await orderService.cancelUnpaidOrder(id);
}

async function cronDeleteTunnelTraffic(_job: Job): Promise<number> {
  const count = await tunnelService.deleteTunnelTraffic();
  return count;
}

async function cronRenewUserPlan(_job: Job): Promise<void> {
  const count = await planService.renewUsersPlan();
  return count;
}

async function cronResetTableOrder(_job: Job): Promise<void> {
  const BATCH_SIZE = 1000;
  await db.$transaction(async (tx) => {
    const total = await tx.nodeGroup.count();
    let maxOrder = total * 1000;
    let cursor = 0;
    while (true) {
      const nodeGroups = await tx.nodeGroup.findMany({
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        skip: cursor,
        select: { id: true },
      });
      if (nodeGroups.length === 0) {
        break;
      }
      for (const nodeGroup of nodeGroups) {
        await tx.nodeGroup.update({
          where: { id: nodeGroup.id },
          data: { order_by: maxOrder },
        });
        maxOrder -= 1000;
      }
      cursor += nodeGroups.length;
    }
  });
  await db.$transaction(async (tx) => {
    const total = await tx.node.count();
    let maxOrder = total * 1000;
    let cursor = 0;
    while (true) {
      const nodes = await tx.node.findMany({
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        skip: cursor,
        select: { id: true },
      });
      if (nodes.length === 0) {
        break;
      }
      for (const node of nodes) {
        await tx.node.update({
          where: { id: node.id },
          data: { order_by: maxOrder },
        });
        maxOrder -= 1000;
      }
      cursor += nodes.length;
    }
  });
  await db.$transaction(async (tx) => {
    const total = await tx.tunnel.count();
    let maxOrder = total * 1000;
    let cursor = 0;
    while (true) {
      const tunnels = await tx.tunnel.findMany({
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        skip: cursor,
        select: { id: true },
      });
      if (tunnels.length === 0) {
        break;
      }
      for (const tunnel of tunnels) {
        await tx.tunnel.update({
          where: { id: tunnel.id },
          data: { order_by: maxOrder },
        });
        maxOrder -= 1000;
      }
      cursor += tunnels.length;
    }
  });
  await db.$transaction(async (tx) => {
    const total = await tx.payment.count();
    let maxOrder = total * 1000;
    let cursor = 0;
    while (true) {
      const payments = await tx.payment.findMany({
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        skip: cursor,
        select: { id: true },
      });
      if (payments.length === 0) {
        break;
      }
      for (const payment of payments) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { order_by: maxOrder },
        });
        maxOrder -= 1000;
      }
      cursor += payments.length;
    }
  });
  await db.$transaction(async (tx) => {
    const total = await tx.plan.count();
    let maxOrder = total * 1000;
    let cursor = 0;
    while (true) {
      const plans = await tx.plan.findMany({
        orderBy: [{ order_by: "desc" }, { id: "desc" }],
        take: BATCH_SIZE,
        skip: cursor,
        select: { id: true },
      });
      if (plans.length === 0) {
        break;
      }
      for (const plan of plans) {
        await tx.plan.update({
          where: { id: plan.id },
          data: { order_by: maxOrder },
        });
        maxOrder -= 1000;
      }
      cursor += plans.length;
    }
  });
}

async function cronUpdateAgent(_job: Job): Promise<void> {
  const autoUpdateAgent = await systemConfigService.getConfig(
    SystemConfigName.AUTO_UPDATE_AGENT,
  );
  if (!autoUpdateAgent) {
    return;
  }
  const nodeUpgrade = await redisService.getNodeUpgrade();
  const latest_agent_version = await redisService.getLatestAgentVersion();
  if (!latest_agent_version) {
    return;
  }
  if (nodeUpgrade === latest_agent_version) {
    return;
  }
  await nodeService.upgradeAllNodes();
  await redisService.setNodeUpgrade(latest_agent_version);
}

async function cronNotifyPlanExpire(_job: Job): Promise<void> {
  const users = await db.user.findMany({
    where: {
      user_plan: {
        expired_at: {
          gte: new Date(),
          lte: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      },
    },
    include: {
      user_plan: {
        include: { plan: true },
      },
    },
  });
  for (const user of users) {
    if (!user.user_plan || !user.user_plan.expired_at) continue;
    await notifyService.notifyPlanExpire({
      user,
      plan: user.user_plan.plan,
      expire_at: user.user_plan.expired_at,
      traffic: user.user_plan.traffic,
      traffic_used: user.user_plan.traffic_used,
    });
  }
}

async function notifyNodeDisconnect(job: Job): Promise<void> {
  const { node_id } = job.data as { node_id: number };
  const node = await db.node.findUnique({
    where: { id: node_id },
    include: {
      node_group: {
        include: { user: true },
      },
    },
  });
  if (!node) return;
  const sysinfo = await redisService.getNodeSysinfo(node.node_group_id, node.id);
  if (!sysinfo) return;
  const last_active = new Date(sysinfo.last_active ?? 0);
  if (last_active >= new Date(Date.now() - 60 * 1000)) return;
  await redisService.markNodeOfflineNotified(node.id);
  await notifyService.notifyNodeDisconnect({
    node_id: node.node_id,
    connect_ip: node.connect_ip,
    version: node.version,
    custom_line: node.custom_line,
    node_type: node.node_group.node_type,
    group_name: node.node_group.name,
    user: node.node_group.user,
    last_active,
    online_since: node.updated_at,
  });
}

async function cronSyncDNS(_job: Job): Promise<void> {
  await inNodeGroupDNSService.cronSyncNodeDNS();
}

async function cronResetExpiredTunnel(_job: Job): Promise<number> {
  return await tunnelService.resetExpiredTunnels();
}

async function cronRepushWaitingTunnel(_job: Job): Promise<number> {
  return await tunnelService.repushWaitingTunnels();
}
