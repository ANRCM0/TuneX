/**
 * In-process cron runner used when REDIS_URL is unset.
 *
 * BullMQ is not constructed. `tickLocalScheduler` calls the same handlers the
 * one-second loop would, and `runJob` is the direct entry for a named job.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";

const temp: TempDatabase = createTempDatabase("local-scheduler");

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  process.env.REDIS_URL = "";
  process.env.SITE_URL = "https://panel.test";
  process.env.LICENSE_URL = "http://127.0.0.1:9";
  vi.stubGlobal(
    "fetch",
    async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
  );
});

afterAll(async () => {
  const { stopLocalScheduler } = await import("../../apps/backend/src/bullmq/local-scheduler");
  stopLocalScheduler();
  const { db } = await import("../../apps/backend/src/db");
  await db.$disconnect();
  temp.cleanup();
});

describe("cronMatches", () => {
  it("treats a 5-field pattern as second 0 in Asia/Shanghai", async () => {
    const { cronMatches } = await import("../../apps/backend/src/bullmq/local-scheduler");
    const atFour = new Date("2026-01-01T20:00:00.000Z");
    expect(cronMatches("0 4 * * *", atFour)).toBe(true);
    expect(cronMatches("* * * * *", atFour)).toBe(true);
    expect(cronMatches("0 0 * * *", atFour)).toBe(false);
    expect(cronMatches("*/5 * * * * *", atFour)).toBe(true);
    expect(cronMatches("*/5 * * * * *", new Date("2026-01-02T04:00:05.000Z"))).toBe(true);
    expect(cronMatches("*/30 * * * * *", new Date("2026-01-02T04:00:05.000Z"))).toBe(false);
  });
});

describe("tickLocalScheduler", () => {
  it("runs only the jobs whose pattern matches, and runJob reaches a handler", async () => {
    await import("../../apps/backend/src/services/redis");
    await import("../../apps/backend/src/services/node_group");
    await import("../../apps/backend/src/services/license");
    await import("../../apps/backend/src/services/system_config");
    const { cronMatches, runJob, tickLocalScheduler } = await import(
      "../../apps/backend/src/bullmq/local-scheduler"
    );
    const { jobs } = await import("../../apps/backend/src/bullmq/jobs");
    const atSecondFive = new Date("2026-01-02T04:00:05.000Z");
    const expected = jobs.filter((job) => job.cron && cronMatches(job.cron, atSecondFive)).map((job) => job.name);
    expect(expected).toEqual(["cron_push_node_config"]);
    await expect(tickLocalScheduler(atSecondFive)).resolves.toEqual(expected);
    await expect(tickLocalScheduler(atSecondFive)).resolves.toEqual([]);
    await expect(runJob("cron_reset_table_order")).resolves.toBeUndefined();
    await expect(runJob("missing")).rejects.toThrow(/unknown job/);
  });

  it("starts the local loop from initBullMQ when REDIS_URL is empty", async () => {
    const { initBullMQ } = await import("../../apps/backend/src/bullmq/queue");
    const { stopLocalScheduler } = await import("../../apps/backend/src/bullmq/local-scheduler");
    await initBullMQ();
    await initBullMQ();
    stopLocalScheduler();
  });
});
