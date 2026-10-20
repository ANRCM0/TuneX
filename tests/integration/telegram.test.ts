/**
 * Telegram Bot API client against a real HTTP server.
 *
 * `TelegramApi` posts JSON to `https://api.telegram.org/bot<token>/<method>`; the replica
 * makes the root overridable (`TELEGRAM_API_BASE`) so this suite can exercise the real
 * request path, the token placement in the URL, the JSON body and the `{ok,result}` /
 * `{ok:false,description}` contracts the client parses.
 *
 * The class is not exported from the service (it is an implementation detail of the bot), so
 * the suite imports the module and drives the exported bot service's public send path where
 * possible; where that needs Redis state, it asserts through the same HTTP surface.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpFixture } from "./fixtures/http_fixture";

const fixture = new HttpFixture();
const TOKEN = "123456:TEST-TOKEN";

type TelegramApiLike = {
  call: (method: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
};

let api: TelegramApiLike;

beforeAll(async () => {
  await fixture.start();
  process.env.TELEGRAM_API_BASE = fixture.baseUrl;
  // `TelegramApi` is internal; recreate it through the module's factory path by importing
  // the service and reading the class from the module scope is not possible, so the test
  // builds an equivalent instance via the public constructor the service uses. If the class
  // is not exported the suite skips rather than pretending to test it.
  const mod = (await import("../../apps/backend/src/services/telegram")) as unknown as {
    TelegramApi?: new (token: string) => TelegramApiLike;
  };
  if (!mod.TelegramApi) throw new Error("TelegramApi is not exported");
  api = new mod.TelegramApi(TOKEN);
});

afterAll(async () => {
  await fixture.stop();
  delete process.env.TELEGRAM_API_BASE;
});

beforeEach(() => {
  fixture.requests.length = 0;
  fixture.route({
    [`POST /bot${TOKEN}/sendMessage`]: { body: { ok: true, result: { message_id: 42 } } },
    [`POST /bot${TOKEN}/getMe`]: {
      body: { ok: true, result: { id: 7, is_bot: true, username: "relayx_bot" } },
    },
    [`POST /bot${TOKEN}/fail`]: { body: { ok: false, description: "Bad Request: chat not found" } },
  });
});

describe("telegram api over HTTP", () => {
  it("posts to /bot<token>/<method> with a JSON body", async () => {
    const result = (await api.call("sendMessage", { chat_id: 1, text: "hello" })) as { message_id: number };
    expect(result.message_id).toBe(42);

    const call = fixture.requests.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ chat_id: 1, text: "hello" });
  });

  it("surfaces the vendor description on ok:false", async () => {
    await expect(api.call("fail", { chat_id: 1 })).rejects.toThrow(/chat not found/);
  });

  it("reads the getMe result shape", async () => {
    const me = (await api.call("getMe")) as { username: string };
    expect(me.username).toBe("relayx_bot");
  });
});
