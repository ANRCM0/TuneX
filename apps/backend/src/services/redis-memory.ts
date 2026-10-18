/**
 * In-memory substitute for Redis.
 *
 * The upstream backend talks to a real Redis through `ioredis` + `redlock`
 * (relayx-analysis/work/modules/007__src__services__redis.ts). This environment has no
 * Redis server, so the replica ships a drop-in that implements exactly the command
 * surface `RedisService` uses. Set REDIS_URL to a non-empty value to use real ioredis
 * instead (see src/services/redis.ts).
 *
 * Supported: SET (EX/NX), GET, DEL, EXPIRE, PING, HSET/HGET/HGETALL/HDEL/HMGET/HINCRBYFLOAT,
 * SADD/SREM/SMEMBERS, KEYS, PUBLISH + subscriber facade, PIPELINE.
 *
 * Deviation recorded in docs/DEVIATIONS.md §4.
 */

type Expiring = { exp: number | null };
type StringEntry = Expiring & { v: string };
type HashEntry = Expiring & { m: Map<string, string> };
type SetEntry = Expiring & { s: Set<string> };

/** Process-wide pub/sub bus, shared by every duplicate()/subscriber instance. */
const bus = new Map<string, Set<(channel: string, message: string) => void>>();

type PipelineOp = () => unknown;
type PipelineResult = [Error | null, unknown];

export class MemoryRedis {
  private strings = new Map<string, StringEntry>();
  private hashes = new Map<string, HashEntry>();
  private sets = new Map<string, SetEntry>();
  private handlers = new Map<string, (channel: string, message: string) => void>();
  private channels = new Set<string>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private opts: { sweepIntervalMs?: number } = {}) {
    const interval = opts.sweepIntervalMs ?? 30_000;
    if (interval > 0) {
      this.sweep = setInterval(() => this.purgeExpired(), interval);
      // Never hold the event loop open because of the cache sweeper.
      this.sweep.unref?.();
    }
  }

  // ── expiry ───────────────────────────────────────────────────────────────────
  private purgeExpired(now = Date.now()): void {
    for (const [key, entry] of this.strings) if (entry.exp !== null && entry.exp <= now) this.strings.delete(key);
    for (const [key, entry] of this.hashes) if (entry.exp !== null && entry.exp <= now) this.hashes.delete(key);
    for (const [key, entry] of this.sets) if (entry.exp !== null && entry.exp <= now) this.sets.delete(key);
  }

  private live<T extends Expiring>(entry: T | undefined, now = Date.now()): T | undefined {
    if (!entry) return undefined;
    if (entry.exp !== null && entry.exp <= now) return undefined;
    return entry;
  }

  private expireKey(key: string, seconds: number): boolean {
    const exp = Date.now() + seconds * 1000;
    for (const map of [this.strings, this.hashes, this.sets] as Map<string, Expiring>[]) {
      const entry = map.get(key);
      if (entry) {
        entry.exp = exp;
        return true;
      }
    }
    return false;
  }

  // ── strings ──────────────────────────────────────────────────────────────────
  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    let ex: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const flag = String(args[i]).toUpperCase();
      if (flag === "EX" || flag === "PX") {
        const raw = Number(args[i + 1]);
        ex = Date.now() + (flag === "EX" ? raw * 1000 : raw);
        i += 1;
      } else if (flag === "NX") {
        nx = true;
      }
    }
    if (nx && this.live(this.strings.get(key))) return null;
    this.strings.set(key, { v: String(value), exp: ex });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.live(this.strings.get(key))?.v ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.expireKey(key, seconds) ? 1 : 0;
  }

  async ping(): Promise<"PONG"> {
    return "PONG";
  }

  // ── hashes ───────────────────────────────────────────────────────────────────
  async hset(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
    const hash = this.live(this.hashes.get(key)) ?? { m: new Map<string, string>(), exp: null };
    this.hashes.set(key, hash);
    let added = 0;
    const entries: [string, string][] =
      typeof field === "object" ? Object.entries(field).map(([k, v]) => [k, String(v)]) : [[field, String(value)]];
    for (const [f, v] of entries) {
      if (!hash.m.has(f)) added += 1;
      hash.m.set(f, v);
    }
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.live(this.hashes.get(key))?.m.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.live(this.hashes.get(key));
    if (!hash) return {};
    return Object.fromEntries(hash.m.entries());
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.live(this.hashes.get(key));
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) if (hash.m.delete(field)) removed += 1;
    return removed;
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const hash = this.live(this.hashes.get(key));
    return fields.map((field) => hash?.m.get(field) ?? null);
  }

  async hincrbyfloat(key: string, field: string, by: number): Promise<string> {
    const hash = this.live(this.hashes.get(key)) ?? { m: new Map<string, string>(), exp: null };
    this.hashes.set(key, hash);
    const next = (Number.parseFloat(hash.m.get(field) ?? "0") || 0) + by;
    const text = String(next);
    hash.m.set(field, text);
    return text;
  }

  // ── sets ─────────────────────────────────────────────────────────────────────
  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.live(this.sets.get(key)) ?? { s: new Set<string>(), exp: null };
    this.sets.set(key, set);
    let added = 0;
    for (const member of members) if (!set.s.has(member)) (set.s.add(member), (added += 1));
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.live(this.sets.get(key));
    if (!set) return 0;
    let removed = 0;
    for (const member of members) if (set.s.delete(member)) removed += 1;
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.live(this.sets.get(key))?.s ?? []);
  }

  // ── keyspace ─────────────────────────────────────────────────────────────────
  async keys(pattern: string): Promise<string[]> {
    this.purgeExpired();
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    const all = [...this.strings.keys(), ...this.hashes.keys(), ...this.sets.keys()];
    return all.filter((key) => regex.test(key));
  }

  // ── pub/sub ──────────────────────────────────────────────────────────────────
  async publish(channel: string, message: string): Promise<number> {
    const listeners = bus.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) queueMicrotask(() => listener(channel, message));
    return listeners.size;
  }

  /** Mirrors `client.duplicate()` for a subscriber connection. */
  duplicate(): MemoryRedis {
    return new SubscriberFacade(this);
  }

  async subscribe(...channels: string[]): Promise<void> {
    for (const channel of channels) this.channels.add(channel);
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    for (const channel of channels.length ? channels : [...this.channels]) this.channels.delete(channel);
  }

  on(event: "message", handler: (channel: string, message: string) => void): this {
    if (event === "message") {
      this.handlers.set("message", handler);
      if (!bus.has("__any__")) bus.set("__any__", new Set());
      // Register against every channel this facade subscribed to at call time.
      for (const channel of this.channels) {
        const set = bus.get(channel) ?? new Set();
        set.add(handler);
        bus.set(channel, set);
      }
      const originalSubscribe = this.subscribe.bind(this);
      this.subscribe = async (...more: string[]) => {
        await originalSubscribe(...more);
        for (const channel of more) {
          const set = bus.get(channel) ?? new Set();
          set.add(handler);
          bus.set(channel, set);
        }
      };
    }
    return this;
  }

  async quit(): Promise<void> {
    this.handlers.clear();
    this.channels.clear();
    if (this.sweep) clearInterval(this.sweep);
  }

  // ── pipeline ─────────────────────────────────────────────────────────────────
  pipeline(): Pipeline {
    return new Pipeline(this);
  }

  /** Execute a queued op against this store (used by Pipeline). */
  execute(op: PipelineOp): PipelineResult {
    try {
      return [null, op()];
    } catch (error) {
      return [error as Error, null];
    }
  }

  /** Direct access for tests / the health endpoint. */
  get stats(): { strings: number; hashes: number; sets: number; channels: number } {
    return { strings: this.strings.size, hashes: this.hashes.size, sets: this.sets.size, channels: this.channels.size };
  }
}

/** Subscriber view: shares the parent store but keeps its own subscriptions. */
class SubscriberFacade extends MemoryRedis {
  constructor(private parent: MemoryRedis) {
    super({ sweepIntervalMs: 0 });
  }
  override async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    return this.parent.set(key, value, ...args);
  }
  override async publish(channel: string, message: string): Promise<number> {
    return this.parent.publish(channel, message);
  }
}

/** Chainable command buffer mirroring ioredis' pipeline API. */
export class Pipeline {
  private ops: PipelineOp[] = [];
  constructor(private redis: MemoryRedis) {}

  del(...keys: string[]): this {
    this.ops.push(() => void this.redis.del(...keys));
    return this;
  }
  hset(key: string, field: string, value: string): this {
    this.ops.push(() => void this.redis.hset(key, field, value));
    return this;
  }
  hdel(key: string, ...fields: string[]): this {
    this.ops.push(() => void this.redis.hdel(key, ...fields));
    return this;
  }
  hgetall(key: string): this {
    this.ops.push(() => this.redis.hgetall(key));
    return this;
  }
  expire(key: string, seconds: number): this {
    this.ops.push(() => void this.redis.expire(key, seconds));
    return this;
  }
  hincrbyfloat(key: string, field: string, by: number): this {
    this.ops.push(() => this.redis.hincrbyfloat(key, field, by));
    return this;
  }
  sadd(key: string, ...members: string[]): this {
    this.ops.push(() => void this.redis.sadd(key, ...members));
    return this;
  }
  srem(key: string, ...members: string[]): this {
    this.ops.push(() => void this.redis.srem(key, ...members));
    return this;
  }

  exec(): PipelineResult[] {
    return this.ops.map((op) => this.redis.execute(op));
  }
}

/** In-process mutex replacing `redlock`'s `lock.using(resources, ttl, callback)`. */
export class MemoryLock {
  private tails = new Map<string, Promise<void>>();

  async using<T>(resources: string[], _ttlMs: number, callback: () => Promise<T> | T): Promise<T> {
    const key = [...resources].sort().join("|");
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.tails.set(key, chained);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      void chained.then(() => {
        if (this.tails.get(key) === chained) this.tails.delete(key);
      });
    }
  }
}
