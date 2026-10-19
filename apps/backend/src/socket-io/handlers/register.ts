import type { Socket } from "socket.io";
import { NodeType, SystemConfigName } from "@prisma/client";
import { db } from "../../db";
import { logger } from "../../logger";
import { fernetService } from "../../services/fernet";
import { inNodeGroupDNSService } from "../../services/in_node_group_dns";
import { licenseExpired, licenseService } from "../../services/license";
import { notifyService } from "../../services/notify";
import { redisService } from "../../services/redis";
import { systemConfigService } from "../../services/system_config";
import { tunnelService } from "../../services/tunnel";
import { getNode } from "../utils";

/**
 * Upstream: src/socket-io/handlers/register.ts (198 decompiled lines) — ported 1:1.
 */

interface RegisterResult {
  error?: string;
  license?: string;
  site_url?: string;
  type?: string;
  now?: number;
}

async function rejectAndBlock(
  redis: typeof redisService,
  token: string,
  callback: (result: RegisterResult) => void,
  error: string,
): Promise<void> {
  await redis.setRegisterBlock(token, error);
  callback({ error });
}

export function register(socket: Socket): void {
  socket.on("register", async (data: Record<string, any>, callback: (result: RegisterResult) => void) => {
    const token = socket.data.token as string;
    const blocked = await redisService.getRegisterBlock(token);
    if (blocked) {
      callback({ error: blocked });
      return;
    }
    const license = await licenseService.getLicense();
    if (!license) {
      await rejectAndBlock(redisService, token, callback, "无有效授权，请联系管理员");
      return;
    }
    if (license && licenseExpired(license.expired_at)) {
      await rejectAndBlock(redisService, token, callback, "License 已过期，请联系管理员");
      return;
    }
    const { node_id, connect_ips } = getNode(socket, data);
    const { version, sysinfo, ports } = data;
    const group = await db.nodeGroup.findUnique({
      where: {
        token,
      },
      include: {
        user: {
          include: {
            user_plan: {
              include: {
                plan: true,
              },
            },
          },
        },
      },
    });
    if (!group) {
      await rejectAndBlock(redisService, token, callback, "节点组不存在");
      return;
    }
    const user = group.user;
    const user_plan = user.user_plan;
    const plan = user_plan?.plan;
    const traffic = user_plan?.traffic ?? plan?.traffic;
    const traffic_used = user_plan?.traffic_used ?? 0;
    const expired_at = user_plan?.expired_at;
    if (!user.super_admin) {
      if (expired_at && expired_at < new Date()) {
        await rejectAndBlock(redisService, token, callback, "用户套餐已过期");
        return;
      }
      if (traffic && traffic_used >= traffic) {
        await rejectAndBlock(redisService, token, callback, "用户套餐流量已用完");
        return;
      }
      if (group.node_type === NodeType.in && !plan?.allow_custom_in_node_group) {
        await rejectAndBlock(redisService, token, callback, "不允许自定义入节点组");
        return;
      }
      if (group.node_type === NodeType.out && !plan?.allow_custom_out_node_group) {
        await rejectAndBlock(redisService, token, callback, "不允许自定义出节点组");
        return;
      }
    }
    callback({
      license: license.content,
      site_url: license.site_url,
      type: license.type,
      now: Math.floor(new Date().getTime() / 1000),
    });
    const connect_ip = connect_ips.join(",");
    let node = await db.node.findUnique({
      where: {
        node_id,
      },
    });
    let created = false;
    if (!node) {
      node = await db.node.create({
        data: {
          node_id,
          connect_ip,
          node_group_id: group.id,
          version,
          order_by: (await db.node.count()) * 1000,
        },
      });
      created = true;
    } else {
      const oldConnectIp = node.connect_ip;
      node = await db.node.update({
        where: {
          node_id,
        },
        data: {
          connect_ip,
          version,
        },
      });
      if (group.node_type === NodeType.in && oldConnectIp !== connect_ip) {
        try {
          await inNodeGroupDNSService.updateNodeDnsRecords(
            group,
            oldConnectIp ? oldConnectIp.split(",") : [],
            connect_ips,
            node.weight,
            node.custom_line,
          );
        } catch (e) {
          logger.error(e, `Failed to update DNS records for node ${node.id} on IP change`);
        }
      }
    }
    const last_sysinfo = await redisService.getNodeSysinfo(group.id, node.id);
    const last_active = new Date(last_sysinfo?.last_active ?? 0);
    await redisService.setSysinfo(group.id, node.id, {
      ...sysinfo,
      version,
      status: node.status,
      node_id,
    });
    await redisService.setSocketIdNodeId(socket.id, node.id);
    await socket.join(`node_group/${group.id}`);
    if (ports) {
      const { tcp, mtcp, udp, relayx, wss, mwss, tls, mtls, quic } = ports;
      if (tcp) {
        await redisService.setOutListen(node.id, tcp, "tcp");
      }
      if (mtcp) {
        await redisService.setOutListen(node.id, mtcp, "mtcp");
      }
      if (udp) {
        await redisService.setOutListen(node.id, udp, "udp");
      }
      if (relayx) {
        await redisService.setOutListen(node.id, relayx, "relayx");
      }
      if (wss) {
        await redisService.setOutListen(node.id, wss, "wss");
      }
      if (mwss) {
        await redisService.setOutListen(node.id, mwss, "mwss");
      }
      if (tls) {
        await redisService.setOutListen(node.id, tls, "tls");
      }
      if (mtls) {
        await redisService.setOutListen(node.id, mtls, "mtls");
      }
      if (quic) {
        await redisService.setOutListen(node.id, quic, "quic");
      }
    }
    const [allTunnels, outListens] = await Promise.all([
      tunnelService.getAllAvailableTunnels(),
      redisService.getAllOutListens(),
    ]);
    const limitScope = await systemConfigService.getConfig(SystemConfigName.LIMIT_SCOPE);
    const tunnelLimits = tunnelService.computeAllLimits(allTunnels, limitScope);
    const config = await tunnelService.getNodeConfig(
      group.id,
      group.node_type,
      group.port_range,
      group.allow_listen_protocol,
      allTunnels,
      outListens,
      tunnelLimits,
    );
    socket.emit("config", fernetService.encrypt(JSON.stringify(config)));
    const wasOfflineNotified = await redisService.takeNodeOfflineNotified(node.id);
    if (wasOfflineNotified) {
      await notifyService.notifyNodeOnline({
        node_id: node.node_id,
        connect_ip: node.connect_ip,
        version: node.version,
        custom_line: node.custom_line,
        node_type: group.node_type,
        group_name: group.name,
        user: group.user,
        offline_since: last_active,
      });
    } else if (created || last_active < new Date(Date.now() - 60 * 1000)) {
      await notifyService.notifyNodeRegister({
        node_id: node.node_id,
        connect_ip: node.connect_ip,
        version: node.version,
        custom_line: node.custom_line,
        node_type: group.node_type,
        group_name: group.name,
        user: group.user,
      });
    }
  });
}
