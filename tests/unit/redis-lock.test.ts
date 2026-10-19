/**
 * The Redis-backed lock used when REDIS_URL is set.
 *
 * Driven through the in-process Redis stand-in, which implements the same
 * SET NX PX / GET / DEL surface the shared client exposes, so this exercises the
 * protocol rather than a mock of it.
 */
import { describe, expect, it } from "vitest";
import { MemoryRedis, RedisLock } from "../../apps/backend/src/services/redis-memory";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newLock() {
  const redis = new MemoryRedis({ sweepIntervalMs: 0 });
  return { redis, lock: new RedisLock(redis as never, "test:lock:") };
}

describe("RedisLock", () => {
  it("serialises callers on the same resource", async () => {
    const { lock } = newLock();
    const order: string[] = [];
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      [1, 2, 3].map((i) =>
        lock.using(["renew:1"], 500, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          order.push(`start-${i}`);
          await sleep(10);
          order.push(`end-${i}`);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].replace("start-", "")).toBe(order[i + 1].replace("end-", ""));
    }
  });

  it("runs different resources concurrently", async () => {
    const { lock } = newLock();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      [1, 2].map((i) =>
        lock.using([`user:${i}`], 500, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(20);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(2);
  });

  it("fails to acquire a held lock after the TTL and releases the key", async () => {
    const { redis, lock } = newLock();
    let release!: () => void;
    const held = lock.using(["k"], 200, () => new Promise<void>((resolve) => (release = resolve)));
    await sleep(20);
    await expect(lock.using(["k"], 50, () => undefined)).rejects.toThrow(/lock busy/);
    release();
    await held;
    expect(await redis.keys("test:lock:*")).toEqual([]);
  });

  it("does not delete a key another holder replaced", async () => {
    const { redis, lock } = newLock();
    await lock.using(["k"], 500, async () => {
      await redis.set("test:lock:k", "someone-else", "PX", 5000);
    });
    expect(await redis.get("test:lock:k")).toBe("someone-else");
  });
});
