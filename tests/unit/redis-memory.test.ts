/**
 * The in-memory Redis substitute used when `REDIS_URL` is empty.
 *
 * It implements the command surface `RedisService` needs, so its semantics are the
 * deployment semantics for every dev/test run and for the "no Redis" boot path. The
 * suite pins expiry, NX, hash/set commands, glob keys, the pub/sub facade, the
 * pipeline and the in-process lock.
 */
import { describe, expect, it } from "vitest";
import { MemoryLock, MemoryRedis } from "../../apps/backend/src/services/redis-memory";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function redis() {
  return new MemoryRedis({ sweepIntervalMs: 0 });
}

describe("strings", () => {
  it("sets, gets and deletes", async () => {
    const r = redis();
    expect(await r.set("a", "1")).toBe("OK");
    expect(await r.get("a")).toBe("1");
    expect(await r.get("missing")).toBeNull();
    expect(await r.del("a", "missing")).toBe(1);
    expect(await r.get("a")).toBeNull();
  });

  it("honours PX expiry and NX", async () => {
    const r = redis();
    await r.set("short", "v", "PX", 20);
    expect(await r.get("short")).toBe("v");
    await sleep(40);
    expect(await r.get("short")).toBeNull();

    await r.set("lock", "1", "NX");
    expect(await r.set("lock", "2", "NX")).toBeNull();
    expect(await r.get("lock")).toBe("1");
    await r.del("lock");
    expect(await r.set("lock", "3", "NX")).toBe("OK");
  });

  it("expires existing keys and reports missing ones", async () => {
    const r = redis();
    await r.set("k", "v");
    expect(await r.expire("k", 0)).toBe(1);
    expect(await r.get("k")).toBeNull();
    expect(await r.expire("nope", 5)).toBe(0);
  });

  it("sweeps expired string/hash/set keys", async () => {
    const r = new MemoryRedis({ sweepIntervalMs: 10 });
    await r.set("s", "v", "PX", 5);
    await r.hset("h", "f", "v");
    await r.expire("h", 0);
    await r.sadd("set", "m");
    await r.expire("set", 0);
    await sleep(30);
    expect(r.stats.strings).toBe(0);
    expect(r.stats.hashes).toBe(0);
    expect(r.stats.sets).toBe(0);
    await r.quit();
  });
});

describe("hashes and sets", () => {
  it("supports the hash commands RedisService uses", async () => {
    const r = redis();
    expect(await r.hset("h", "a", "1")).toBe(1);
    expect(await r.hset("h", "a", "2")).toBe(0);
    expect(await r.hset("h", { b: "3", c: "4" })).toBe(2);
    expect(await r.hget("h", "a")).toBe("2");
    expect(await r.hgetall("h")).toEqual({ a: "2", b: "3", c: "4" });
    expect(await r.hmget("h", "a", "nope")).toEqual(["2", null]);
    expect(await r.hincrbyfloat("h", "b", 0.5)).toBe("3.5");
    expect(await r.hdel("h", "a", "missing")).toBe(1);
    expect(await r.hgetall("h")).toEqual({ b: "3.5", c: "4" });
  });

  it("supports set commands", async () => {
    const r = redis();
    expect(await r.sadd("s", "a", "b", "a")).toBe(2);
    expect((await r.smembers("s")).sort()).toEqual(["a", "b"]);
    expect(await r.srem("s", "a", "x")).toBe(1);
    expect(await r.smembers("s")).toEqual(["b"]);
  });

  it("matches glob-style key patterns across types", async () => {
    const r = redis();
    await r.set("node:1", "x");
    await r.hset("node:2", "f", "v");
    await r.sadd("other", "m");
    expect((await r.keys("node:*")).sort()).toEqual(["node:1", "node:2"]);
    expect(await r.keys("n?de:1")).toEqual(["node:1"]);
    expect(await r.keys("*")).toHaveLength(3);
    expect(await r.keys("nothing*")).toEqual([]);
  });
});

describe("pub/sub facade", () => {
  it("delivers published messages to subscribers", async () => {
    const channel = `ch-${Math.random().toString(36).slice(2)}`;
    const publisher = redis();
    const subscriber = redis().duplicate();

    const received: string[] = [];
    subscriber.on("message", (ch, message) => {
      received.push(`${ch}:${message}`);
    });
    await subscriber.subscribe(channel);

    expect(await publisher.publish(channel, "hello")).toBe(1);
    await sleep(10);
    expect(received).toEqual([`${channel}:hello`]);
    expect(await publisher.publish("nobody-listens", "x")).toBe(0);

    await subscriber.unsubscribe(channel);
    await publisher.publish(channel, "again");
    await sleep(10);
    expect(received).toHaveLength(1);
  });
});

describe("pipeline", () => {
  it("executes queued commands in order and returns errors as tuples", async () => {
    const r = redis();
    const results = r
      .pipeline()
      .hset("h", "f", "v")
      .sadd("s", "m")
      .expire("h", 60)
      .hgetall("h")
      .exec();

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual([null, undefined]);
    expect(results[3][0]).toBeNull();
    // `hgetall` returns its promise through the pipeline tuple.
    expect(await (results[3][1] as Promise<Record<string, string>>)).toEqual({ f: "v" });

    const failing = redis().pipeline();
    // A pipeline op that throws is captured instead of rejecting exec().
    (failing as unknown as { ops: (() => unknown)[] }).ops.push(() => {
      throw new Error("boom");
    });
    const [err, value] = failing.exec()[0];
    expect(String(err)).toContain("boom");
    expect(value).toBeNull();
  });
});

describe("MemoryLock", () => {
  it("serialises callbacks that share resources", async () => {
    const lock = new MemoryLock();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const task = (name: string) =>
      lock.using(["user:1"], 1000, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${name}-start`);
        await sleep(10);
        order.push(`${name}-end`);
        active -= 1;
        return name;
      });

    const results = await Promise.all([task("a"), task("b"), task("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
  });

  it("releases the lock when the callback throws", async () => {
    const lock = new MemoryLock();
    await expect(
      lock.using(["r"], 1000, () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    await expect(lock.using(["r"], 1000, () => "ok")).resolves.toBe("ok");
  });
});
