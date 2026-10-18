import { Queue } from "bullmq";
import Redis from "ioredis";
import { REDIS_URL, TZ } from "../config";
import { logger } from "../logger";
import { jobs } from "./jobs";

/**
 * Upstream: src/bullmq/queue.ts (22 lines) — ported 1:1, with one recorded deviation.
 *
 * Upstream builds the queue over the shared `client` connection. The frozen
 * `src/services/redis.ts` is a `RedisLike` facade (an in-process implementation when
 * `REDIS_URL` is empty), which BullMQ cannot drive — it requires a real ioredis
 * connection. The replica therefore opens a dedicated ioredis connection only when
 * `REDIS_URL` is set, and `initBullMQ()` logs once and returns without throwing when it
 * is not, so the server always boots with no Redis.
 *
 * DEVIATION (for docs/DEVIATIONS.md, owned by the verify teammate): BullMQ requires a
 * real Redis; the queue and its cron schedulers exist only when `REDIS_URL` is set.
 */

/** Upstream's `QueueName` enum. */
export const QueueName = {
  default: "default",
} as const;

/** Display name used by the queuedash replacement. */
export const QUEUE_DISPLAY_NAME = "RelayX";

/**
 * The BullMQ connection. `maxRetriesPerRequest: null` is required by BullMQ (and is the
 * same option the recovered `redis.ts` passes to ioredis).
 */
export const queueConnection = REDIS_URL
  ? new Redis(REDIS_URL, { maxRetriesPerRequest: null })
  : null;

/** `null` when `REDIS_URL` is unset — see the deviation note above. */
export const queueDefault = queueConnection
  ? new Queue(QueueName.default, { connection: queueConnection })
  : null;

let initialised = false;

export async function initBullMQ(): Promise<void> {
  if (!queueDefault) {
    if (!initialised) {
      initialised = true;
      logger.info(
        "BullMQ cron scheduler initialisation skipped: REDIS_URL is not set (server boots without Redis).",
      );
    }
    return;
  }
  const schedulers = await queueDefault.getJobSchedulers();
  for (const scheduler of schedulers) {
    await queueDefault.removeJobScheduler(scheduler.name);
  }
  const cronJobs = jobs.filter((job) => job.cron);
  for (const job of cronJobs) {
    await queueDefault.upsertJobScheduler(
      job.name,
      { pattern: job.cron as string, tz: TZ },
      {
        name: job.name,
        opts: {
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      },
    );
  }
  initialised = true;
  logger.info(
    `BullMQ cron scheduler initialised: ${cronJobs.length} jobs (${cronJobs
      .map((job) => job.name)
      .join(", ")}).`,
  );
}
