/**
 * SystemConfigService and UserService.
 *
 * The config service backs every runtime toggle (referral mode, observer period, SMTP,
 * limits). Its documented asymmetry matters: `getConfigs` backfills defaults, while
 * `getAllConfigs` returns only rows that exist. The user service is the thin StackAuth
 * bridge used by the admin create-user and password routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-db";
import type { PrismaClient } from "../../apps/backend/src/db";
import type { SystemConfigService } from "../../apps/backend/src/services/system_config";
import type { UserService } from "../../apps/backend/src/services/user";

const temp: TempDatabase = createTempDatabase("config-user");

let db: PrismaClient;
let configs: SystemConfigService;
let users: UserService;

const stackAuthCalls: { kind: string; args: unknown[] }[] = [];

beforeAll(async () => {
  process.env.DATABASE_URL = temp.url;
  const dbModule = await import("../../apps/backend/src/db");
  db = dbModule.db;
  const { SystemConfigService: Configs } = await import("../../apps/backend/src/services/system_config");
  const { UserService: Users } = await import("../../apps/backend/src/services/user");
  configs = new Configs();
  users = new Users({
    createUser: async (payload: unknown) => {
      stackAuthCalls.push({ kind: "create", args: [payload] });
      return { id: "stack-user-1" };
    },
    updateUser: async (uid: string, payload: unknown) => {
      stackAuthCalls.push({ kind: "update", args: [uid, payload] });
    },
  } as never);
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  temp.cleanup();
});

beforeEach(async () => {
  await db.systemConfig.deleteMany();
  await db.user.deleteMany();
  stackAuthCalls.length = 0;
});

describe("SystemConfigService", () => {
  it("falls back to the default when a key is absent", async () => {
    expect(await configs.getConfig("SITE_NAME" as never)).toBe("RelayX");
    expect(await configs.getConfig("REFERRAL_MODE" as never)).toBe("topup");
    expect(await configs.getConfig("OBSERVER_PERIOD" as never)).toBe(5);
  });

  it("prefers a stored JSON value, including complex types", async () => {
    await configs.setConfigs({
      SITE_NAME: "Custom",
      REFERRAL_FIRST_ONLY: true,
      MIN_TOPUP_AMOUNT: 42,
      NOTICE: { text: "hi", level: 2 },
    } as never);

    expect(await configs.getConfig("SITE_NAME" as never)).toBe("Custom");
    expect(await configs.getConfig("REFERRAL_FIRST_ONLY" as never)).toBe(true);
    expect(await configs.getConfig("MIN_TOPUP_AMOUNT" as never)).toBe(42);
    expect(await configs.getConfig("NOTICE" as never)).toEqual({ text: "hi", level: 2 });
  });

  it("treats a JSON null as absent", async () => {
    await db.systemConfig.create({ data: { name: "SITE_NAME", value: "null" } });
    expect(await configs.getConfig("SITE_NAME" as never)).toBe("RelayX");
  });

  it("upserts on update and backfills defaults in getConfigs", async () => {
    await configs.setConfigs({ SITE_NAME: "one" } as never);
    await configs.setConfigs({ SITE_NAME: "two" } as never);

    expect(await db.systemConfig.count()).toBe(1);
    expect(await configs.getConfig("SITE_NAME" as never)).toBe("two");

    const batch = await configs.getConfigs(["SITE_NAME", "REFERRAL_MODE", "MIN_WITHDRAW_AMOUNT"] as never);
    expect(batch).toEqual({ SITE_NAME: "two", REFERRAL_MODE: "topup", MIN_WITHDRAW_AMOUNT: 100 });
  });

  it("keeps getAllConfigs limited to stored rows (recovered asymmetry)", async () => {
    await configs.setConfigs({ SITE_NAME: "only", OBSERVER_PERIOD: 9 } as never);

    const all = await configs.getAllConfigs();
    expect(all).toEqual({ SITE_NAME: "only", OBSERVER_PERIOD: 9 });
    expect(Object.keys(all)).not.toContain("REFERRAL_MODE");
  });
});

describe("UserService", () => {
  it("returns only super admins", async () => {
    await db.user.create({ data: { email: "admin@example.test", super_admin: true } });
    await db.user.create({ data: { email: "plain@example.test" } });

    const admins = await users.getSuperAdmins();
    expect(admins.map((u) => u.email)).toEqual(["admin@example.test"]);
  });

  it("creates a StackAuth user with the email/password payload", async () => {
    const created = await users.createUserWithPassword("new@example.test", "secret");
    expect(created).toEqual({ id: "stack-user-1" });
    expect(stackAuthCalls).toEqual([
      {
        kind: "create",
        args: [{ primary_email: "new@example.test", password: "secret", primary_email_auth_enabled: true }],
      },
    ]);
  });

  it("changes a password only for a user linked to StackAuth", async () => {
    const linked = await db.user.create({ data: { email: "linked@example.test", uid: "uid-1" } });
    const unlinked = await db.user.create({ data: { email: "unlinked@example.test" } });

    await users.changePassword(linked.id, "new-secret");
    expect(stackAuthCalls).toEqual([
      { kind: "update", args: ["uid-1", { password: "new-secret" }] },
    ]);

    await expect(users.changePassword(unlinked.id, "x")).rejects.toMatchObject({
      status: 400,
      message: "用户未关联Stack Auth账户，请退出重新登录",
    });
    await expect(users.changePassword(999999, "x")).rejects.toMatchObject({
      status: 404,
      message: "用户不存在",
    });
  });
});
