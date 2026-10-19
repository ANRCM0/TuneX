import type { Job } from "bullmq";
import { logger } from "../logger";
import { jobs } from "./jobs";

/**
 * In-process cron runner used when `REDIS_URL` is unset.
 *
 * Upstream only enqueues these handlers on BullMQ and does not run a worker inside
 * the panel process. Without Redis the replica would boot and then never push
 * config, renew plans or sync DNS. This scheduler calls the same handler functions.
 * It is not a second queue: there is no retry, delay or job record.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function runJob(name: string, data: Record<string, unknown> = {}): Promise<unknown> {
  const job = jobs.find((item) => item.name === name);
  if (!job) {
    throw new Error(`unknown job ${name}`);
  }
  return job.handler({ name, data } as Job);
}

export function cronMatches(pattern: string, date: Date): boolean {
  const fields = pattern.trim().split(/\s+/);
  const spec = fields.length === 5 ? ["0", ...fields] : fields;
  if (spec.length !== 6) return false;
  const wall = shanghaiParts(date);
  const values = [wall.second, wall.minute, wall.hour, wall.day, wall.month, wall.weekday];
  return spec.every((field, index) => fieldMatches(field, values[index]));
}

let timer: ReturnType<typeof setInterval> | null = null;
const fired = new Set<string>();

export function startLocalScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickLocalScheduler().catch((error) => {
      logger.error(error, "local cron");
    });
  }, 1000);
  timer.unref?.();
}

export function stopLocalScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tickLocalScheduler(now = new Date()): Promise<string[]> {
  const slot = shanghaiSlot(now);
  for (const key of fired) {
    if (!key.endsWith(`:${slot}`)) fired.delete(key);
  }
  const ran: string[] = [];
  for (const job of jobs) {
    if (!job.cron || !cronMatches(job.cron, now)) continue;
    const key = `${job.name}:${slot}`;
    if (fired.has(key)) continue;
    fired.add(key);
    await job.handler({ name: job.name, data: {} } as Job);
    ran.push(job.name);
  }
  return ran;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((part) => fieldMatches(part, value));
  }
  return Number(field) === value;
}

function shanghaiParts(date: Date): {
  second: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    bag[part.type] = part.value;
  }
  return {
    second: Number(bag.second),
    minute: Number(bag.minute),
    hour: Number(bag.hour) % 24,
    day: Number(bag.day),
    month: Number(bag.month),
    weekday: WEEKDAYS.indexOf(bag.weekday),
  };
}

function shanghaiSlot(date: Date): string {
  const wall = shanghaiParts(date);
  return [wall.month, wall.day, wall.hour, wall.minute, wall.second].join("-");
}
