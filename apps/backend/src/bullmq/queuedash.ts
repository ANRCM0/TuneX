import { Hono } from "hono";
import { QUEUE_DISPLAY_NAME, QueueName, queueDefault } from "./queue";

/**
 * Upstream: src/bullmq/queuedash.ts (13 lines).
 *
 * DEVIATION (for docs/DEVIATIONS.md, owned by the verify teammate): upstream exposes the
 * `queuedash` dashboard package (`The({ baseUrl: "/queuedash", ctx: { queues: [{ queue,
 * displayName: "RelayX", type: "bullmq" }] } })`). That package is not part of the frozen
 * dependency set, so the replica serves the same mount point with a small read-only Hono
 * router that reports the queue and its cron schedulers as JSON. The mount path
 * (`/queuedash`, before the auth chain, exactly as `src/app.ts` does it) and the queue
 * identity (`RelayX`, type `bullmq`) are unchanged.
 */
const router = new Hono();

router.get("/", async (c) => {
  if (!queueDefault) {
    return c.json({
      queues: [
        {
          displayName: QUEUE_DISPLAY_NAME,
          name: QueueName.default,
          type: "bullmq",
          connected: false,
          schedulers: [],
          note: "REDIS_URL is not set; BullMQ is disabled in this deployment.",
        },
      ],
    });
  }
  try {
    const [schedulers, counts] = await Promise.all([
      queueDefault.getJobSchedulers(),
      queueDefault.getJobCounts(),
    ]);
    return c.json({
      queues: [
        {
          displayName: QUEUE_DISPLAY_NAME,
          name: QueueName.default,
          type: "bullmq",
          connected: true,
          counts,
          schedulers: schedulers.map((scheduler) => ({
            name: scheduler.name,
            pattern: scheduler.pattern,
            tz: scheduler.tz,
          })),
        },
      ],
    });
  } catch (err) {
    return c.json(
      {
        error: "无法连接 Redis，队列信息不可用",
        detail: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
});

export default router;
