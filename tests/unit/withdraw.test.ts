/**
 * CommissionService — the commission wallet, withdrawals and their state machine.
 *
 * `commission_balance` is a separate wallet: referral payouts credit it, withdrawals
 * debit it, and a rejection must put the money back. Approval does not move money (the
 * payout happens outside the panel), only the status. Every request opens a ticket.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { CommissionService } from "../../apps/backend/src/services/commission";

const temp: TempDatabase = createTempDatabase("withdraw");

let db: PrismaClient;
let service: CommissionService;
let userA = 0;
let userB = 0;

const config: Record<string, unknown> = {
  MIN_WITHDRAW_AMOUNT: 10,
  WITHDRAW_METHODS: "alipay,wechat",
};
const tickets: { userId: number; title: string; content: string }[] = [];

async function makeUser(email: string, commission: number) {
  return db.user.create({ data: { email, commission_balance: commission } });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { CommissionService: Service } = await import("../../apps/backend/src/services/commission");
  service = new Service(
    { getConfig: async (name: string) => config[name] } as never,
    {
      createTicket: async (userId: number, title: string, content: string) => {
        tickets.push({ userId, title, content });
      },
    } as never,
  );

  userA = (await makeUser("a@example.test", 0)).id;
  userB = (await makeUser("b@example.test", 0)).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.withdrawRequest.deleteMany();
  await db.commissionLog.deleteMany();
  await db.balanceLog.deleteMany();
  await db.ticket.deleteMany();
  await db.user.updateMany({ data: { commission_balance: 0, balance: 0 } });
  tickets.length = 0;
  config.MIN_WITHDRAW_AMOUNT = 10;
  config.WITHDRAW_METHODS = "alipay,wechat";
});

describe("createWithdrawRequest", () => {
  it("debits the commission wallet, logs it and opens a ticket", async () => {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 100 } });

    const request = await service.createWithdrawRequest(userA, 30, "alipay", "acct-1");

    expect(request).toMatchObject({
      user_id: userA,
      amount: 30,
      method: "alipay",
      account: "acct-1",
      status: "pending",
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: userA } });
    expect(user.commission_balance).toBe(70);

    const logs = await db.commissionLog.findMany({ where: { user_id: userA } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ amount: -30, balance: 70, type: "withdraw" });

    expect(tickets).toHaveLength(1);
    expect(tickets[0].userId).toBe(userA);
    expect(tickets[0].title).toBe("佣金提现申请");
    expect(tickets[0].content).toContain("提现金额：30 元");
    expect(tickets[0].content).toContain("提现方式：支付宝");
    expect(tickets[0].content).toContain("提现账号：acct-1");
    expect(tickets[0].content).toContain(`关联提现记录ID：${request.id}`);
  });

  it("enforces the minimum amount", async () => {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 100 } });
    await expect(service.createWithdrawRequest(userA, 5, "alipay", "a")).rejects.toMatchObject({
      status: 400,
      message: "最低提现金额为 10 元",
    });
    expect(await db.withdrawRequest.count()).toBe(0);
  });

  it("refuses when withdrawals are disabled or the method is unknown", async () => {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 100 } });

    config.WITHDRAW_METHODS = "  ";
    await expect(service.createWithdrawRequest(userA, 20, "alipay", "a")).rejects.toMatchObject({
      status: 400,
      message: "暂不支持提现，请联系管理员",
    });

    config.WITHDRAW_METHODS = "alipay";
    await expect(service.createWithdrawRequest(userA, 20, "bank", "a")).rejects.toMatchObject({
      status: 400,
      message: "不支持的提现方式",
    });
  });

  it("refuses when the commission wallet is short", async () => {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 5 } });
    await expect(service.createWithdrawRequest(userA, 20, "alipay", "a")).rejects.toMatchObject({
      status: 400,
      message: "佣金余额不足",
    });
  });
});

describe("approveWithdraw / rejectWithdraw", () => {
  async function pending(amount = 30) {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 100 } });
    return service.createWithdrawRequest(userA, amount, "alipay", "acct");
  }

  it("approving records the status and remark without moving money", async () => {
    const request = await pending();
    const before = (await db.user.findUniqueOrThrow({ where: { id: userA } })).commission_balance;

    await service.approveWithdraw(request.id, "paid");

    const after = await db.withdrawRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after).toMatchObject({ status: "approved", remark: "paid" });
    expect((await db.user.findUniqueOrThrow({ where: { id: userA } })).commission_balance).toBe(before);
  });

  it("rejecting refunds the wallet without writing another log", async () => {
    const request = await pending();
    await service.rejectWithdraw(request.id, "invalid account");

    const after = await db.withdrawRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after).toMatchObject({ status: "rejected", remark: "invalid account" });
    expect((await db.user.findUniqueOrThrow({ where: { id: userA } })).commission_balance).toBe(100);
    // Only the original withdraw debit remains.
    expect(await db.commissionLog.count({ where: { user_id: userA } })).toBe(1);
  });

  it("cannot approve or reject an already processed request", async () => {
    const approved = await pending();
    await service.approveWithdraw(approved.id);
    await expect(service.approveWithdraw(approved.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.rejectWithdraw(approved.id)).rejects.toMatchObject({ status: 404 });

    const rejected = await pending(20);
    await service.rejectWithdraw(rejected.id);
    await expect(service.rejectWithdraw(rejected.id)).rejects.toMatchObject({ status: 404 });

    await expect(service.approveWithdraw(999999)).rejects.toMatchObject({ status: 404 });
  });
});

describe("transferToBalance", () => {
  it("moves money between the wallets and writes both logs", async () => {
    await db.user.update({ where: { id: userA }, data: { commission_balance: 50, balance: 5 } });

    await service.transferToBalance(userA, 20);

    const user = await db.user.findUniqueOrThrow({ where: { id: userA } });
    expect(user.commission_balance).toBe(30);
    expect(user.balance).toBe(25);

    const commissionLogs = await db.commissionLog.findMany({ where: { user_id: userA } });
    expect(commissionLogs[0]).toMatchObject({ amount: -20, balance: 30, type: "transfer" });

    const balanceLogs = await db.balanceLog.findMany({ where: { user_id: userA } });
    expect(balanceLogs[0]).toMatchObject({ amount: 20, balance: 25, type: "commission_transfer" });
  });

  it("validates the amount and the balance", async () => {
    await expect(service.transferToBalance(userA, 0)).rejects.toMatchObject({
      status: 400,
      message: "划转金额必须大于0",
    });
    await expect(service.transferToBalance(userA, -5)).rejects.toMatchObject({ status: 400 });
    await expect(service.transferToBalance(userA, 10)).rejects.toMatchObject({
      status: 400,
      message: "佣金余额不足",
    });
  });
});

describe("getWithdrawRequests", () => {
  it("filters by status and email, and scopes to a user", async () => {
    const userC = await makeUser("c@example.test", 0);
    await db.withdrawRequest.createMany({
      data: [
        { user_id: userA, amount: 10, method: "alipay", account: "a" },
        { user_id: userB, amount: 20, method: "wechat", account: "b", status: "approved" },
        { user_id: userC.id, amount: 30, method: "alipay", account: "c", status: "rejected" },
      ],
    });

    const all = await service.getWithdrawRequests({ page: 1, perPage: 10 });
    expect(all.total).toBe(3);
    expect(all.data[0].user).toBeTruthy();

    const pending = await service.getWithdrawRequests({ page: 1, perPage: 10, status: "pending" });
    expect(pending.data.map((r) => r.amount)).toEqual([10]);

    const byEmail = await service.getWithdrawRequests({ page: 1, perPage: 10, email: "b@example" });
    expect(byEmail.data.map((r) => r.amount)).toEqual([20]);

    const mine = await service.getWithdrawRequests({ page: 1, perPage: 10 }, userA);
    expect(mine.total).toBe(1);

    const page2 = await service.getWithdrawRequests({ page: 2, perPage: 1 });
    expect(page2.data).toHaveLength(1);
    expect(page2.total).toBe(3);
  });
});
