/**
 * Settlement and referral-commission integration tests against a throwaway SQLite
 * database.
 *
 * These are the two places where the panel credits money:
 *
 *   - `settleTopupOrder` (`topup-settlement.ts`, upstream 036) claims a pending order
 *     with a conditional `updateMany` that repeats every field the callback was
 *     verified against, then credits the user and writes one balance log. A replayed
 *     callback must never credit twice.
 *   - `processReferralCommission` (`topup.ts`, upstream 037) pays the parent a cut of
 *     the amount, gated on a business licence, `parent_id`, a positive rate, and —
 *     when `firstOnly` — on the parent having no prior referral log.
 *
 * The suite runs `prisma db push --skip-generate` into a temporary file, then sets
 * DATABASE_URL before importing the Prisma client and the services.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { LicenseService } from "../../apps/backend/src/services/license";
import type { SystemConfigService } from "../../apps/backend/src/services/system_config";
import type { TopupService } from "../../apps/backend/src/services/topup";

const ROOT = join(process.cwd());
const SCHEMA = join(ROOT, "apps/backend/prisma/schema.prisma");
const workDir = mkdtempSync(join(tmpdir(), "relayx-topup-"));
const databaseUrl = `file:${join(workDir, "test.db")}`;

let db: PrismaClient;
let settleTopupOrder: typeof import("../../apps/backend/src/services/topup-settlement").settleTopupOrder;
let service: TopupService;

let licenseType: "business" | "personal" | null = "business";
const configValues: Record<string, unknown> = {};

let userSeq = 0;
let orderSeq = 0;
let paymentId = 0;

async function makeUser(parentId?: number) {
  userSeq += 1;
  return db.user.create({
    data: {
      email: `user-${userSeq}@example.test`,
      parent_id: parentId ?? null,
      balance: 0,
      commission_balance: 0,
    },
  });
}

async function makeOrder(userId: number, overrides: Partial<{ price: number; bonus: number; status: "pending" | "success"; trade_id: string | null }> = {}) {
  orderSeq += 1;
  return db.topupOrder.create({
    data: {
      user_id: userId,
      payment_id: paymentId,
      price: overrides.price ?? 100,
      bonus: overrides.bonus ?? 5,
      pay_url: "https://pay.example.test/1",
      order_id: `ORDER-${orderSeq}`,
      trade_id: overrides.trade_id === undefined ? `TRADE-${orderSeq}` : overrides.trade_id,
      status: overrides.status ?? "pending",
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = databaseUrl;
  execFileSync(
    join(ROOT, "node_modules", ".bin", "prisma"),
    ["db", "push", "--skip-generate", `--schema=${SCHEMA}`],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );

  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  ({ settleTopupOrder } = await import("../../apps/backend/src/services/topup-settlement"));
  const { TopupService: Service } = await import("../../apps/backend/src/services/topup");

  const licenseService = {
    getLicense: async () => (licenseType ? { type: licenseType } : null),
  } as unknown as LicenseService;
  const systemConfig = {
    getConfig: async (name: string) => configValues[name],
  } as unknown as SystemConfigService;
  service = new Service(licenseService, systemConfig);

  const payment = await db.payment.create({
    data: { name: "test", url: "https://pay.example.test", config: {}, method: "epay" },
  });
  paymentId = payment.id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

describe("settleTopupOrder", () => {
  it("credits price + bonus once and writes one balance log", async () => {
    const user = await makeUser();
    const order = await makeOrder(user.id, { price: 100, bonus: 5 });

    const settled = await db.$transaction((tx) => settleTopupOrder(tx, order));
    expect(settled).toBe(true);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balance).toBe(105);

    const logs = await db.balanceLog.findMany({ where: { user_id: user.id, type: "topup" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].amount).toBe(105);
    expect(logs[0].balance).toBe(105);

    const stored = await db.topupOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("success");
    // Upstream also increments the order row's `balance` column; preserved verbatim.
    expect(stored.balance).toBe(105);
  });

  it("ignores a replayed callback", async () => {
    const user = await makeUser();
    const order = await makeOrder(user.id, { price: 50, bonus: 0 });

    expect(await db.$transaction((tx) => settleTopupOrder(tx, order))).toBe(true);
    // The callback handler still holds the pre-settlement snapshot.
    expect(await db.$transaction((tx) => settleTopupOrder(tx, order))).toBe(false);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balance).toBe(50);
    expect(await db.balanceLog.count({ where: { user_id: user.id } })).toBe(1);
  });

  it("rejects a snapshot that no longer matches a pending order", async () => {
    const user = await makeUser();
    const order = await makeOrder(user.id);

    await expect(
      db.$transaction((tx) => settleTopupOrder(tx, { ...order, trade_id: "SOMETHING-ELSE" })),
    ).rejects.toMatchObject({ status: 409 });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balance).toBe(0);
    expect(await db.balanceLog.count({ where: { user_id: user.id } })).toBe(0);
  });

  it("treats a settled order with a stale price snapshot as a replay", async () => {
    const user = await makeUser();
    const order = await makeOrder(user.id, { price: 30, bonus: 0 });
    await db.$transaction((tx) => settleTopupOrder(tx, order));

    const stale = { ...order, price: order.price + 1 };
    expect(await db.$transaction((tx) => settleTopupOrder(tx, stale))).toBe(false);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balance).toBe(30);
  });
});

describe("processReferralCommission", () => {
  it("pays the parent the configured percentage and records it", async () => {
    licenseType = "business";
    const parent = await makeUser();
    const child = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 200, 10));

    const parentAfter = await db.user.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentAfter.commission_balance).toBe(20);

    const logs = await db.commissionLog.findMany({ where: { user_id: parent.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].amount).toBe(20);
    expect(logs[0].balance).toBe(20);
    expect(logs[0].type).toBe("referral");
  });

  it("does nothing without a business licence", async () => {
    licenseType = "personal";
    const parent = await makeUser();
    const child = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 200, 10));

    const parentAfter = await db.user.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentAfter.commission_balance).toBe(0);
    expect(await db.commissionLog.count({ where: { user_id: parent.id } })).toBe(0);
    licenseType = "business";
  });

  it("does nothing when the licence server is unreachable", async () => {
    licenseType = null;
    const parent = await makeUser();
    const child = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 200, 10));
    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(0);
    licenseType = "business";
  });

  it("does nothing for a user without a parent", async () => {
    const before = await db.commissionLog.count();
    const child = await makeUser();
    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 200, 10));
    expect(await db.commissionLog.count()).toBe(before);
    expect((await db.user.findUniqueOrThrow({ where: { id: child.id } })).commission_balance).toBe(0);
  });

  it("does nothing at a zero rate", async () => {
    const parent = await makeUser();
    const child = await makeUser(parent.id);
    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 200, 0));
    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(0);
  });

  it("prefers the parent's own rate over the passed one", async () => {
    const parent = await makeUser();
    await db.user.update({ where: { id: parent.id }, data: { referral_commission_rate: 25 } });
    const child = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 100, 5));
    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(25);
  });

  it("pays only the first referral when firstOnly is set on the parent", async () => {
    const parent = await makeUser();
    await db.user.update({ where: { id: parent.id }, data: { referral_first_only: true } });
    const childA = await makeUser(parent.id);
    const childB = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, childA.id, 100, 10));
    await db.$transaction((tx) => service.processReferralCommission(tx, childB.id, 100, 10));

    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(10);
    expect(await db.commissionLog.count({ where: { user_id: parent.id } })).toBe(1);
  });

  it("pays every referral when firstOnly is false", async () => {
    const parent = await makeUser();
    await db.user.update({ where: { id: parent.id }, data: { referral_first_only: false } });
    const childA = await makeUser(parent.id);
    const childB = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, childA.id, 100, 10));
    await db.$transaction((tx) => service.processReferralCommission(tx, childB.id, 100, 10));

    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(20);
    expect(await db.commissionLog.count({ where: { user_id: parent.id } })).toBe(2);
  });

  it("falls back to the system config rate and firstOnly flag", async () => {
    configValues.REFERRAL_COMMISSION_RATE = 12.5;
    configValues.REFERRAL_FIRST_ONLY = false;
    const parent = await makeUser();
    const child = await makeUser(parent.id);

    await db.$transaction((tx) => service.processReferralCommission(tx, child.id, 80));
    expect((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).commission_balance).toBe(10);
    delete configValues.REFERRAL_COMMISSION_RATE;
    delete configValues.REFERRAL_FIRST_ONLY;
  });
});
