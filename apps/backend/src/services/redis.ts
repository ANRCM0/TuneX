import axios from "axios";
import { AGENT_VERSION_URL, REDIS_URL } from "../config";
import { fernetService } from "./fernet";
import { logger } from "./logger";
import { service, TOKENS } from "../container";
import { MemoryLock, MemoryRedis, RedisLock, type LockClient } from "./redis-memory";

/**
 * Redis key namespace, mirrored from the recovered `src/services/redis.ts`.
 */
export const KEY = {
  NODE_INFO: "node:info",
  NODE_GROUP_CONFIG_HASH: "node_group:config_hash",
  USER_SUB: "user:sub",
  IMPERSONATION: "impersonation",
  TG_BIND: "tg:bind",
  USER_SUBSCRIBE: "user:subscribe",
  USER_TUNNEL: "user:tunnel",
  TUNNEL_NODE_STATS: "tunnel:node_stats",
  TUNNEL_TRAFFIC: "tunnel:traffic",
  TUNNEL_TRAFFIC_COST: "tunnel:traffic_cost",
  LATEST_AGENT_VERSION: "latest_agent_version",
  SYSINFO: "sysinfo",
  SYSINFO_GROUPS: "sysinfo_groups",
  TOPUP_ORDER: "topup:order",
  TUNNEL_OUT_LISTEN: "tunnel:out_listen",
  LICENSE: "license",
  SOCKET_ID_NODE_ID: "socket_id:node_id",
  NODE_UPGRADE: "node_upgrade",
  REGISTER_BLOCK: "register:block",
  NODE_OFFLINE_NOTIFIED: "node:offline_notified",
  SYNC_NODE_DNS_LOCK: "sync_node_dns:lock",
} as const;

export const IO_EMIT_CHANNEL = "io:emit";

export interface NodeInfo {
  node_id: string;
  connect_ip?: string;
  [key: string]: unknown;
}

export interface SysinfoPayload {
  last_active?: Date | string;
  [key: string]: unknown;
}

export interface TunnelNodeStats {
  totalConns?: number;
  currentConns?: number;
  inputBytes?: number;
  outputBytes?: number;
  totalErrs?: number;
  currentClients?: string[];
}

/** Minimal command surface RedisService needs, satisfied by MemoryRedis and ioredis. */
export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  hincrbyfloat(key: string, field: string, by: number): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  keys(pattern: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline(): any;
  duplicate(): unknown;
  quit?(): Promise<void>;
}

/**
 * The single shared connection. `REDIS_URL` empty (the replica default) selects the
 * in-process substitute; a non-empty value uses real ioredis.
 */
export const client: RedisLike = await createClient();

async function createClient(): Promise<RedisLike> {
  if (!REDIS_URL) {
    return new MemoryRedis();
  }
  const { default: Redis } = await import("ioredis");
  // `maxRetriesPerRequest: null` matches the recovered options (redis.ts:11-13).
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null }) as unknown as RedisLike;
}

/**
 * The lock upstream builds as `redlock` over the shared client.
 * With a real Redis the lock is SET NX PX keyed on the same resources, so two
 * processes cannot renew the same user at once. Without Redis it is the
 * in-process mutex (`docs/DEVIATIONS.md` §7).
 */
export const lock = REDIS_URL ? new RedisLock(client as unknown as LockClient) : new MemoryLock();

export class RedisService {
  LOCK_EXPIRE = 5000;

  async setNodeInfo(node_id: string, node: NodeInfo): Promise<void> {
    await client.set(`${KEY.NODE_INFO}:${node_id}`, JSON.stringify(node), "EX", 60);
  }

  async getNodeInfo(node_id: string): Promise<NodeInfo | null> {
    const node = await client.get(`${KEY.NODE_INFO}:${node_id}`);
    if (!node) return null;
    return JSON.parse(node) as NodeInfo;
  }

  async delNodeInfo(node_id: string): Promise<void> {
    await client.del(`${KEY.NODE_INFO}:${node_id}`);
  }

  async setNodeConfigHash(node_group_id: number, hash: string): Promise<void> {
    await client.hset(KEY.NODE_GROUP_CONFIG_HASH, node_group_id.toString(), hash);
  }

  async getNodeConfigHash(node_group_id: number): Promise<string | null> {
    return await client.hget(KEY.NODE_GROUP_CONFIG_HASH, node_group_id.toString());
  }

  async deleteNodeConfigHash(node_group_ids: number[]): Promise<void> {
    if (node_group_ids.length === 0) return;
    await client.hdel(KEY.NODE_GROUP_CONFIG_HASH, ...node_group_ids.map((id) => id.toString()));
  }

  async setUserSub(sub: string, id: number): Promise<void> {
    await client.hset(KEY.USER_SUB, sub, id.toString());
  }

  async getUserSub(sub: string): Promise<number | null> {
    const id = await client.hget(KEY.USER_SUB, sub);
    return id ? Number.parseInt(id) : null;
  }

  async setImpersonation(token: string, userId: number, ttlSeconds: number): Promise<void> {
    await client.set(`${KEY.IMPERSONATION}:${token}`, userId.toString(), "EX", ttlSeconds);
  }

  async getImpersonation(token: string): Promise<number | null> {
    const id = await client.get(`${KEY.IMPERSONATION}:${token}`);
    return id ? Number.parseInt(id) : null;
  }

  async getOrCreateTgBindToken(userId: number, ttlSeconds = 24 * 60 * 60): Promise<string> {
    const userKey = `${KEY.TG_BIND}:user:${userId}`;
    const existing = await client.get(userKey);
    if (existing) {
      const tokenKey = `${KEY.TG_BIND}:token:${existing}`;
      const mapped = await client.get(tokenKey);
      if (mapped === userId.toString()) {
        await client.expire(userKey, ttlSeconds);
        await client.expire(tokenKey, ttlSeconds);
        return existing;
      }
    }
    const token = crypto.randomUUID();
    await client.set(userKey, token, "EX", ttlSeconds);
    await client.set(`${KEY.TG_BIND}:token:${token}`, userId.toString(), "EX", ttlSeconds);
    return token;
  }

  async consumeTgBindToken(token: string): Promise<number | null> {
    const tokenKey = `${KEY.TG_BIND}:token:${token}`;
    const userIdStr = await client.get(tokenKey);
    if (!userIdStr) return null;
    const userId = Number.parseInt(userIdStr, 10);
    await client.del(tokenKey, `${KEY.TG_BIND}:user:${userId}`);
    return Number.isNaN(userId) ? null : userId;
  }

  async lockUserSubscribe<T>(id: number, callback: () => Promise<T> | T): Promise<T> {
    return lock.using([KEY.USER_SUBSCRIBE, id.toString()], this.LOCK_EXPIRE, callback);
  }

  async lockUserTunnel<T>(id: number, callback: () => Promise<T> | T): Promise<T> {
    return lock.using([KEY.USER_TUNNEL, id.toString()], this.LOCK_EXPIRE, callback);
  }

  async setTunnelNodeStatsBatch(
    node_id: number,
    entries: { tunnel_id: number; stats: TunnelNodeStats }[],
    ttl: number,
  ): Promise<void> {
    const key = `${KEY.TUNNEL_NODE_STATS}:${node_id}`;
    const pipeline = client.pipeline();
    pipeline.del(key);
    for (const entry of entries) {
      pipeline.hset(key, entry.tunnel_id.toString(), JSON.stringify(entry.stats));
    }
    pipeline.expire(key, ttl);
    pipeline.exec();
  }

  async getAllTunnelNodeStats(): Promise<Map<number, TunnelNodeStats>> {
    const keys = await client.keys(`${KEY.TUNNEL_NODE_STATS}:*`);
    if (keys.length === 0) return new Map();
    const pipeline = client.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }
    const results = pipeline.exec() as [Error | null, Record<string, string>][];
    const clientSets = new Map<number, Set<string>>();
    const accumulator = new Map<number, TunnelNodeStats>();
    results?.forEach(([err, value]) => {
      if (err || !value) return;
      for (const [tunnelIdStr, statsJson] of Object.entries(value)) {
        const tunnel_id = Number.parseInt(tunnelIdStr);
        if (!tunnel_id) continue;
        const stats = JSON.parse(statsJson) as TunnelNodeStats;
        const existing = accumulator.get(tunnel_id);
        if (existing) {
          existing.totalConns = (existing.totalConns ?? 0) + (stats.totalConns ?? 0);
          existing.currentConns = (existing.currentConns ?? 0) + (stats.currentConns ?? 0);
          existing.inputBytes = (existing.inputBytes ?? 0) + (stats.inputBytes ?? 0);
          existing.outputBytes = (existing.outputBytes ?? 0) + (stats.outputBytes ?? 0);
          existing.totalErrs = (existing.totalErrs ?? 0) + (stats.totalErrs ?? 0);
        } else {
          accumulator.set(tunnel_id, {
            totalConns: stats.totalConns ?? 0,
            currentConns: stats.currentConns ?? 0,
            inputBytes: stats.inputBytes ?? 0,
            outputBytes: stats.outputBytes ?? 0,
            totalErrs: stats.totalErrs ?? 0,
          });
        }
        let clients = clientSets.get(tunnel_id);
        if (!clients) {
          clients = new Set<string>();
          clientSets.set(tunnel_id, clients);
        }
        for (const ip of stats.currentClients ?? []) {
          clients.add(ip);
        }
      }
    });
    const aggregated = new Map<number, TunnelNodeStats>();
    for (const [tunnel_id, acc] of accumulator) {
      aggregated.set(tunnel_id, { ...acc, currentClients: Array.from(clientSets.get(tunnel_id) ?? []) });
    }
    return aggregated;
  }

  async incrTunnelTraffics(traffics: { tunnel_id: number; traffic: number; traffic_cost: number }[]): Promise<void> {
    const pipeline = client.pipeline();
    for (const traffic of traffics) {
      pipeline.hincrbyfloat(KEY.TUNNEL_TRAFFIC, traffic.tunnel_id.toString(), traffic.traffic);
      pipeline.hincrbyfloat(KEY.TUNNEL_TRAFFIC_COST, traffic.tunnel_id.toString(), traffic.traffic_cost);
    }
    pipeline.exec();
  }

  async getTunnelTraffic(is_cost: boolean, tunnel_ids?: number[]): Promise<Record<string, string>> {
    const key = is_cost ? KEY.TUNNEL_TRAFFIC_COST : KEY.TUNNEL_TRAFFIC;
    if (tunnel_ids) {
      const ret = await client.hmget(key, ...tunnel_ids.map((id) => id.toString()));
      return Object.fromEntries(tunnel_ids.map((id, index) => [id, ret[index] ?? null])) as Record<string, string>;
    }
    return await client.hgetall(key);
  }

  async clearTunnelTraffic(tunnel_ids?: number[]): Promise<void> {
    if (tunnel_ids) {
      const pipeline = client.pipeline();
      for (const tunnel_id of tunnel_ids) {
        pipeline.hdel(KEY.TUNNEL_TRAFFIC, tunnel_id.toString());
        pipeline.hdel(KEY.TUNNEL_TRAFFIC_COST, tunnel_id.toString());
      }
      pipeline.exec();
    } else {
      await client.del(KEY.TUNNEL_TRAFFIC);
      await client.del(KEY.TUNNEL_TRAFFIC_COST);
    }
  }

  async getLatestAgentVersion(): Promise<string> {
    const version = await client.get(KEY.LATEST_AGENT_VERSION);
    if (!version) {
      try {
        const response = await axios.get(AGENT_VERSION_URL, { timeout: 2000, responseType: "text" });
        const data = String(response.data).trim();
        if (!/^\d+\.\d+\.\d+$/.test(data)) {
          return "";
        }
        await client.set(KEY.LATEST_AGENT_VERSION, data, "EX", 600);
        return data;
      } catch {
        return "";
      }
    }
    return version;
  }

  async setSysinfo(node_group_id: number, node_id: number, sysinfo: SysinfoPayload): Promise<void> {
    const key = `${KEY.SYSINFO}:${node_group_id}`;
    const old_sysinfo = await client.hget(key, node_id.toString());
    const old_sysinfo_obj = old_sysinfo ? JSON.parse(old_sysinfo) : {};
    const new_sysinfo = { ...old_sysinfo_obj, ...sysinfo, last_active: new Date() };
    const pipeline = client.pipeline();
    pipeline.hset(key, node_id.toString(), JSON.stringify(new_sysinfo));
    pipeline.sadd(KEY.SYSINFO_GROUPS, node_group_id.toString());
    pipeline.exec();
  }

  async delNodeGroupOfflineSysinfo(node_group_id: number): Promise<void> {
    const key = `${KEY.SYSINFO}:${node_group_id}`;
    const sysinfo = await client.hgetall(key);
    for (const node_id of Object.keys(sysinfo)) {
      const sysinfo_obj = JSON.parse(sysinfo[node_id]) as SysinfoPayload;
      if (new Date(sysinfo_obj.last_active as string).getTime() < new Date(Date.now() - 1000 * 60 * 10).getTime()) {
        await client.hdel(key, node_id);
      }
    }
  }

  async delSysinfoByNodeGroups(node_group_ids: number[]): Promise<void> {
    if (node_group_ids.length === 0) return;
    const pipeline = client.pipeline();
    for (const node_group_id of node_group_ids) {
      pipeline.del(`${KEY.SYSINFO}:${node_group_id}`);
    }
    pipeline.srem(KEY.SYSINFO_GROUPS, ...node_group_ids.map((id) => id.toString()));
    pipeline.exec();
  }

  async delNodeSysinfo(node_group_id: number, node_id: number): Promise<void> {
    await client.hdel(`${KEY.SYSINFO}:${node_group_id}`, node_id.toString());
  }

  async getNodeSysinfo(node_group_id: number, node_id: number): Promise<SysinfoPayload | null> {
    const sysinfo = await client.hget(`${KEY.SYSINFO}:${node_group_id}`, node_id.toString());
    if (!sysinfo) return null;
    return JSON.parse(sysinfo) as SysinfoPayload;
  }

  async getSysinfo(): Promise<Record<number, (SysinfoPayload & { db_id: number })[]>> {
    const groupIds = await client.smembers(KEY.SYSINFO_GROUPS);
    if (groupIds.length === 0) return {};
    const pipeline = client.pipeline();
    for (const id of groupIds) {
      pipeline.hgetall(`${KEY.SYSINFO}:${id}`);
    }
    const data = pipeline.exec() as [Error | null, Record<string, string>][];
    const ret: Record<number, (SysinfoPayload & { db_id: number })[]> = {};
    const staleIds: string[] = [];
    data?.forEach(([err, value], index) => {
      if (err) return;
      const id = groupIds[index];
      const node_group_id = Number.parseInt(id);
      if (!node_group_id) return;
      const entries = Object.entries(value ?? {});
      if (entries.length === 0) {
        staleIds.push(id);
        return;
      }
      const nodes = ret[node_group_id] ?? [];
      entries.forEach(([db_id, sysinfo]) => {
        nodes.push({ ...(JSON.parse(sysinfo) as SysinfoPayload), db_id: Number.parseInt(db_id) });
      });
      ret[node_group_id] = nodes;
    });
    if (staleIds.length > 0) {
      await client.srem(KEY.SYSINFO_GROUPS, ...staleIds);
    }
    return ret;
  }

  async lockTopupOrder<T>(user_id: number, callback: () => Promise<T> | T): Promise<T> {
    return lock.using([KEY.TOPUP_ORDER, user_id.toString()], this.LOCK_EXPIRE, callback);
  }

  async setOutListen(node_id: number, listen: number, type: string): Promise<void> {
    await client.hset(KEY.TUNNEL_OUT_LISTEN, `${node_id}:${type}`, listen.toString());
  }

  async getOutListen(node_id: number, type: string): Promise<string | null> {
    return await client.hget(KEY.TUNNEL_OUT_LISTEN, `${node_id}:${type}`);
  }

  async getAllOutListens(): Promise<Record<string, string>> {
    return await client.hgetall(KEY.TUNNEL_OUT_LISTEN);
  }

  async setLicense(license: unknown): Promise<void> {
    await client.set(KEY.LICENSE, fernetService.encrypt(JSON.stringify(license)));
  }

  async getLicense(): Promise<Record<string, unknown> | null> {
    const license = await client.get(KEY.LICENSE);
    if (license) {
      return JSON.parse(fernetService.decrypt(license)) as Record<string, unknown>;
    }
    return null;
  }

  async delLicense(): Promise<void> {
    await client.del(KEY.LICENSE);
  }

  async setSocketIdNodeId(socket_id: string, node_id: number): Promise<void> {
    await client.hset(KEY.SOCKET_ID_NODE_ID, socket_id, node_id.toString());
  }

  async getSocketIdNodeId(socket_id: string): Promise<string | null> {
    return await client.hget(KEY.SOCKET_ID_NODE_ID, socket_id);
  }

  async delSocketIdNodeId(socket_id: string): Promise<void> {
    await client.hdel(KEY.SOCKET_ID_NODE_ID, socket_id);
  }

  async setNodeUpgrade(version: string): Promise<void> {
    await client.set(KEY.NODE_UPGRADE, version);
  }

  async getNodeUpgrade(): Promise<string | null> {
    return await client.get(KEY.NODE_UPGRADE);
  }

  async setRegisterBlock(token: string, reason: string): Promise<void> {
    await client.set(`${KEY.REGISTER_BLOCK}:${token}`, reason, "EX", 60);
  }

  async getRegisterBlock(token: string): Promise<string | null> {
    return await client.get(`${KEY.REGISTER_BLOCK}:${token}`);
  }

  async delRegisterBlock(token: string): Promise<void> {
    await client.del(`${KEY.REGISTER_BLOCK}:${token}`);
  }

  async markNodeOfflineNotified(node_id: number, ttlSeconds = 30 * 24 * 60 * 60): Promise<void> {
    await client.set(`${KEY.NODE_OFFLINE_NOTIFIED}:${node_id}`, "1", "EX", ttlSeconds);
  }

  async takeNodeOfflineNotified(node_id: number): Promise<boolean> {
    const removed = await client.del(`${KEY.NODE_OFFLINE_NOTIFIED}:${node_id}`);
    return removed > 0;
  }

  async tryLockSyncNodeDNS(ttlSeconds = 5 * 60): Promise<boolean> {
    const result = await client.set(`${KEY.SYNC_NODE_DNS_LOCK}`, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async unlockSyncNodeDNS(): Promise<void> {
    await client.del(KEY.SYNC_NODE_DNS_LOCK);
  }

  async nodeIsAlive(node_group_id: number, node_id: number): Promise<boolean> {
    const sysinfo = await this.getNodeSysinfo(node_group_id, node_id);
    if (!sysinfo) return false;
    const last_active = new Date(sysinfo.last_active as string);
    return last_active >= new Date(Date.now() - 60 * 1000);
  }

  async publishIoEmit(room: string, event: string, args: unknown[]): Promise<void> {
    await client.publish(IO_EMIT_CHANNEL, JSON.stringify({ room, event, args }));
  }
}

/** Emit a Socket.IO event to every process (upstream publishes over Redis pub/sub). */
export async function publishIoEmit(room: string, event: string, args: unknown[] = []): Promise<void> {
  try {
    await client.publish(IO_EMIT_CHANNEL, JSON.stringify({ room, event, args }));
  } catch (error) {
    logger.error(error, "Failed to publish io:emit");
  }
}

/** Self-registration: `instance.resolve(TOKENS.Redis)` / `redisService` proxy. */
export const redisService = service<RedisService>(TOKENS.Redis, () => new RedisService());
