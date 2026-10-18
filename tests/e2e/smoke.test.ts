import { describe, expect, it } from "vitest";

const base = process.env.RELAYX_BASE_URL ?? "http://127.0.0.1:3000";
const apiKey = process.env.RELAYX_API_KEY ?? "a34d563e-9efe-4047-9e20-05a9678ef5fb";

async function up(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("live smoke (skipped when the panel is down)", () => {
  it("health, site config, plans, and admin config respond", async () => {
    if (!(await up())) {
      return;
    }
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; checks: { db: string; redis: string } };
    expect(body.checks.db).toBe("ok");
    expect(body.checks.redis).toBe("ok");

    const site = await fetch(`${base}/system/config/site`);
    expect(site.status).toBe(200);

    const plans = await fetch(`${base}/plan`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(plans.status).toBe(200);
    const planJson = (await plans.json()) as { id: number; name: string; price: number }[];
    expect(Array.isArray(planJson)).toBe(true);

    const admin = await fetch(`${base}/admin/system/config`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(admin.status).toBe(200);
  });
});
