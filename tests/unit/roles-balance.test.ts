/**
 * Admin roles and balance adjustments.
 *
 * Roles carry the permission map the admin guards read; the service is the only writer,
 * so sanitising unknown resources/levels here is what keeps the guard honest. Balance
 * adjustments are the money side of the admin console: the increment and its log must
 * roll back together when the result would go negative.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { BalanceService } from "../../apps/backend/src/services/balance";
import type { RoleService } from "../../apps/backend/src/services/role";

const temp: TempDatabase = createTempDatabase("roles-balance");

let db: PrismaClient;
let roles: RoleService;
let balance: BalanceService;

let userA = 0;
let userB = 0;

async function makeUser(email: string, balances: { balance?: number; commission?: number } = {}) {
  return db.user.create({
    data: {
      email,
      balance: balances.balance ?? 0,
      commission_balance: balances.commission ?? 0,
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { RoleService: Roles } = await import("../../apps/backend/src/services/role");
  const { BalanceService: Balances } = await import("../../apps/backend/src/services/balance");
  roles = new Roles();
  balance = new Balances();
  userA = (await makeUser("a@example.test")).id;
  userB = (await makeUser("b@example.test")).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.balanceLog.deleteMany();
  await db.commissionLog.deleteMany();
  for (const user of await db.user.findMany({ select: { id: true } })) {
    await db.user.update({ where: { id: user.id }, data: { admin_roles: { set: [] } } });
  }
  await db.adminRole.deleteMany();
  await db.user.updateMany({ data: { balance: 0, commission_balance: 0 } });
});

describe("RoleService", () => {
  it("sanitises unknown resources and invalid levels", () => {
    expect(
      roles.sanitizePermissions({
        users: "read",
        nodes: "write",
        not_a_resource: "write",
        plans: "admin",
        tickets: "read",
      } as never),
    ).toEqual({ users: "read", nodes: "write", tickets: "read" });
  });

  it("creates a role with sanitised permissions and rejects duplicates", async () => {
    const role = await roles.createRole("support", "front line", {
      users: "read",
      unknown: "write",
    } as never);
    expect(role).toMatchObject({ name: "support", description: "front line" });
    expect(role.permissions).toEqual({ users: "read" });

    await expect(roles.createRole("support", null, {})).rejects.toMatchObject({
      status: 409,
      message: "角色名称已存在",
    });

    const listed = await roles.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]._count).toEqual({ users: 0 });
  });

  it("updates a role, checking existence and name collisions", async () => {
    const a = await roles.createRole("a", null, { users: "read" } as never);
    await roles.createRole("b", null, {} as never);

    const updated = await roles.updateRole(a.id, "a2", "desc", { nodes: "write" } as never);
    expect(updated).toMatchObject({ name: "a2", description: "desc" });
    expect(updated.permissions).toEqual({ nodes: "write" });

    await expect(roles.updateRole(a.id, "b", null, {} as never)).rejects.toMatchObject({
      status: 409,
      message: "角色名称已存在",
    });
    await expect(roles.updateRole(999999, "x", null, {} as never)).rejects.toMatchObject({
      status: 404,
      message: "角色不存在",
    });
  });

  it("refuses to delete a role that is still assigned", async () => {
    const role = await roles.createRole("used", null, {} as never);
    await db.user.update({
      where: { id: userA },
      data: { admin_roles: { connect: { id: role.id } } },
    });
    await db.user.update({
      where: { id: userB },
      data: { admin_roles: { connect: { id: role.id } } },
    });

    await expect(roles.deleteRole(role.id)).rejects.toMatchObject({
      status: 409,
      message: "该角色仍被 2 个用户使用，请先解除分配",
    });

    for (const user of await db.user.findMany({ select: { id: true } })) {
      await db.user.update({ where: { id: user.id }, data: { admin_roles: { set: [] } } });
    }
    await roles.deleteRole(role.id);
    expect(await db.adminRole.count()).toBe(0);
  });
});

describe("BalanceService", () => {
  it("adjusts the balance and writes an admin_adjust log", async () => {
    await balance.adjustBalance(userA, 25);

    const user = await db.user.findUniqueOrThrow({ where: { id: userA } });
    expect(user.balance).toBe(25);
    const logs = await db.balanceLog.findMany({ where: { user_id: userA } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ amount: 25, balance: 25, type: "admin_adjust" });
  });

  it("rolls back an adjustment that would go negative", async () => {
    await balance.adjustBalance(userA, 10);
    await expect(balance.adjustBalance(userA, -20)).rejects.toMatchObject({
      status: 400,
      message: "调整后余额不能为负数",
    });

    expect((await db.user.findUniqueOrThrow({ where: { id: userA } })).balance).toBe(10);
    expect(await db.balanceLog.count({ where: { user_id: userA } })).toBe(1);
  });

  it("adjusts the commission wallet with its own log and rollback", async () => {
    await balance.adjustCommissionBalance(userA, 30);
    const logs = await db.commissionLog.findMany({ where: { user_id: userA } });
    expect(logs[0]).toMatchObject({ amount: 30, balance: 30, type: "admin_adjust" });

    await expect(balance.adjustCommissionBalance(userA, -50)).rejects.toMatchObject({
      status: 400,
      message: "调整后佣金余额不能为负数",
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: userA } })).commission_balance).toBe(30);
  });

  it("lists logs with type/email filters, pagination and ISO dates", async () => {
    await db.balanceLog.createMany({
      data: [
        { user_id: userA, amount: 5, balance: 5, type: "topup" },
        { user_id: userB, amount: 7, balance: 7, type: "admin_adjust" },
        { user_id: userB, amount: 9, balance: 16, type: "topup" },
      ],
    });

    const all = await balance.getBalanceLogs({ page: 1, perPage: 10 } as never);
    expect(all.total).toBe(3);
    expect(all.data[0].user).toEqual({ email: "b@example.test" });
    expect(typeof all.data[0].created_at).toBe("string");

    const topups = await balance.getBalanceLogs({ page: 1, perPage: 10, type: "topup" } as never);
    expect(topups.total).toBe(2);

    const byEmail = await balance.getBalanceLogs({ page: 1, perPage: 10, email: "a@example" } as never);
    expect(byEmail.total).toBe(1);

    const mine = await balance.getBalanceLogs({ page: 1, perPage: 10 } as never, userB);
    expect(mine.total).toBe(2);

    const page2 = await balance.getBalanceLogs({ page: 2, perPage: 1 } as never);
    expect(page2.data).toHaveLength(1);
    expect(page2.total).toBe(3);
  });
});
