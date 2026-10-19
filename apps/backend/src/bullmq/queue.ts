import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { REDIS_URL, TZ } from "../config";
import { logger } from "../logger";
import { jobs } from "./jobs";
import { runJob, startLocalScheduler } from "./local-scheduler";

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
 * When `REDIS_URL` is unset, `initBullMQ()` starts the in-process scheduler in
 * `local-scheduler.ts` instead. That path is replica-only: upstream never runs the
 * handlers inside the panel process.
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
let worker: Worker | null = null;

/** The queue consumer, or `null` when the server runs without Redis. */
export function getQueueWorker(): Worker | null {
  return worker;
}

export async function initBullMQ(): Promise<void> {
  if (!queueDefault) {
    if (!initialised) {
      initialised = true;
      startLocalScheduler();
      const cronJobs = jobs.filter((job) => job.cron);
      logger.info(
        `Local cron scheduler started (${cronJobs.length} jobs): REDIS_URL is not set.`,
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
  if (!worker) {
    worker = new Worker(
      QueueName.default,
      async (job) => runJob(job.name, (job.data ?? {}) as Record<string, unknown>),
      { connection: queueConnection!.duplicate(), concurrency: 4 },
    );
    worker.on("error", (err) => logger.error(err, "bullmq worker"));
  }
  logger.info(
    `BullMQ cron scheduler initialised: ${cronJobs.length} jobs (${cronJobs
      .map((job) => job.name)
      .join(", ")}); worker running.`,
  );
}

/** Stop the consumer; used by shutdown and by tests. */
export async function shutdownBullMQ(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
