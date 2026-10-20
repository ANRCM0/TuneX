/**
 * Telegram API calls and the StackAuth REST client.
 *
 * Both services are thin HTTP clients: the Telegram API is exercised through a stubbed
 * `fetch`, StackAuth through an injected axios adapter, so no network is touched. The
 * assertions are on the exact method URL, payload and error mapping the routes rely on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosAdapter } from "axios";

let telegram: {
  sendMessage: (id: number, message: string, buttons?: unknown, callbacks?: unknown) => Promise<void>;
  getBotInfo: () => Promise<string | undefined>;
  setBotCommands: () => Promise<void>;
};
let stackauth: {
  createUser: (data: Record<string, unknown>) => Promise<unknown>;
  updateUser: (uid: string, data: Record<string, unknown>) => Promise<void>;
  getUserMe: (token: string) => Promise<Record<string, unknown>>;
  getJWKSUrl: () => string;
};
let stackHttp: { defaults: { adapter?: AxiosAdapter } };

const telegramCalls: { url: string; body: Record<string, unknown> }[] = [];
let telegramOk = true;
let telegramResult: unknown = null;

const stackCalls: { method?: string; url?: string; data?: unknown; headers?: Record<string, unknown> }[] = [];
let stackResponder: (config: { method?: string; url?: string }) => { status: number; data: unknown };

beforeAll(async () => {
  process.env.SITE_URL = "https://panel.test";
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.STACK_API_URL = "http://stack.test";
  process.env.STACK_PROJECT_ID = "proj-1";
  process.env.STACK_SECRET_SERVER_KEY = "secret-server";

  const telegramModule = await import("../../apps/backend/src/services/telegram");
  telegram = telegramModule.telegramService as never;

  const stackModule = await import("../../apps/backend/src/services/stackauth");
  // Construct directly: the container export is a lazy proxy that hides the
  // axios instance we need to replace with an adapter.
  const StackAuth = (stackModule as unknown as { stackAuthService: unknown }).stackAuthService;
  const instance = new (
    stackModule as unknown as { StackAuthService: new () => unknown }
  ).StackAuthService() as typeof stackauth;
  stackauth = instance;
  stackHttp = (instance as unknown as { http: typeof stackHttp }).http;
  stackHttp.defaults.adapter = (async (config: never) => {
    const typed = config as unknown as {
      method?: string;
      url?: string;
      data?: unknown;
      headers?: Record<string, unknown>;
    };
    stackCalls.push({ method: typed.method, url: typed.url, data: typed.data, headers: typed.headers });
    const { status, data } = stackResponder(typed);
    const response = { data, status, statusText: String(status), headers: {}, config: typed };
    if (status >= 400) {
      const error = new Error(`Request failed with status code ${status}`) as Error & {
        isAxiosError: boolean;
        response: unknown;
      };
      error.isAxiosError = true;
      error.response = response;
      throw error;
    }
    return response;
  }) as unknown as AxiosAdapter;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  telegramCalls.length = 0;
  telegramOk = true;
  telegramResult = null;
  stackCalls.length = 0;
  stackResponder = () => ({ status: 200, data: {} });

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    telegramCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ ok: telegramOk, result: telegramResult, description: "bad thing" }),
      { status: telegramOk ? 200 : 400 },
    );
  });
});

describe("Telegram service", () => {
  it("sends a MarkdownV2 message with url and callback keyboards", async () => {
    await telegram.sendMessage(
      42,
      "*hello*",
      [{ text: "Open", url: "https://panel.test/a" }],
      [{ text: "Reply", callback_data: "ticket:reply:1" }],
    );

    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(telegramCalls[0].body).toEqual({
      chat_id: 42,
      text: "*hello*",
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open", url: "https://panel.test/a" }],
          [{ text: "Reply", callback_data: "ticket:reply:1" }],
        ],
      },
      link_preview_options: { is_disabled: true },
    });
  });

  it("omits the keyboard when no buttons are given", async () => {
    await telegram.sendMessage(7, "plain");
    expect(telegramCalls[0].body).not.toHaveProperty("reply_markup");
  });

  it("returns the bot username and surfaces API failures", async () => {
    telegramResult = { username: "relayx_bot" };
    await expect(telegram.getBotInfo()).resolves.toBe("relayx_bot");

    // The client surfaces the API error to the caller.
    telegramOk = false;
    await expect(telegram.getBotInfo()).rejects.toThrow("Telegram getMe failed");
  });

  it("registers the command list", async () => {
    await telegram.setBotCommands();
    expect(telegramCalls[0].url).toContain("/setMyCommands");
    const commands = telegramCalls[0].body.commands as { command: string }[];
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((c) => c.command)).toContain("me");
    expect(commands.map((c) => c.command)).toContain("stats");
  });
});

describe("StackAuth service", () => {
  it("builds the JWKS URL from the project", () => {
    expect(stackauth.getJWKSUrl()).toBe("http://stack.test/api/v1/projects/proj-1/.well-known/jwks.json");
  });

  it("creates a user and forwards the payload", async () => {
    stackResponder = () => ({ status: 200, data: { id: "u-1" } });
    const created = await stackauth.createUser({ primary_email: "a@example.test", password: "p" });

    expect(created).toEqual({ id: "u-1" });
    expect(stackCalls[0].method).toBe("post");
    expect(stackCalls[0].url).toBe("/api/v1/users");
    expect(JSON.parse(String(stackCalls[0].data))).toEqual({
      primary_email: "a@example.test",
      password: "p",
    });
    expect(stackCalls[0].headers).toMatchObject({
      "X-Stack-Access-Type": "server",
      "X-Stack-Project-Id": "proj-1",
      "X-Stack-Secret-Server-Key": "secret-server",
    });
  });

  it("maps create/update failures to 400 with the server message", async () => {
    stackResponder = () => ({ status: 409, data: { message: "email already used" } });
    await expect(stackauth.createUser({})).rejects.toMatchObject({
      status: 400,
      message: "email already used",
    });

    stackResponder = () => ({ status: 500, data: {} });
    await expect(stackauth.updateUser("u-1", { password: "x" })).rejects.toMatchObject({
      status: 400,
      message: "更新用户失败",
    });
  });

  it("patches a user", async () => {
    await stackauth.updateUser("u-1", { password: "new" });
    expect(stackCalls[0].method).toBe("patch");
    expect(stackCalls[0].url).toBe("/api/v1/users/u-1");
    expect(JSON.parse(String(stackCalls[0].data))).toEqual({ password: "new" });
  });

  it("fetches the current user with the access token and maps failures to 401", async () => {
    stackResponder = () => ({ status: 200, data: { primary_email: "a@example.test" } });
    await expect(stackauth.getUserMe("token-1")).resolves.toEqual({ primary_email: "a@example.test" });
    expect(stackCalls[0].method).toBe("get");
    expect(stackCalls[0].url).toBe("/api/v1/users/me");
    expect(stackCalls[0].headers).toMatchObject({ "x-stack-access-token": "token-1" });

    stackResponder = () => ({ status: 401, data: {} });
    await expect(stackauth.getUserMe("bad")).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized",
    });
  });
});
