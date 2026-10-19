/**
 * EmailService — provider selection and the two transports.
 *
 * The SMTP path is exercised through a fake transporter (never a socket); the Resend
 * path through a stubbed `fetch`. `sendEmail` never throws, so every failure path is
 * asserted by its boolean.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemConfigName } from "@prisma/client";
import type { EmailService } from "../../apps/backend/src/services/email";

let service: EmailService;

const configValues: Record<string, unknown> = {};
const mailCalls: Record<string, unknown>[] = [];
const resendBodies: Record<string, unknown>[] = [];
let resendStatus = 200;

const smtpConfig = {
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: 465,
  SMTP_SECURE: true,
  SMTP_USER: "u",
  SMTP_PASS: "p",
  SMTP_FROM: "from@example.test",
};

const resendConfig = {
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "from@example.test",
};

beforeAll(async () => {
  const { EmailService: Service } = await import("../../apps/backend/src/services/email");
  service = new Service({
    getConfigs: async (names: SystemConfigName[]) =>
      Object.fromEntries(names.map((name) => [name, configValues[name]])),
  } as never);
  // Replace the transporter factory: no SMTP socket is ever opened.
  (service as unknown as { getSmtpTransporter: () => unknown }).getSmtpTransporter = () => ({
    sendMail: async (message: Record<string, unknown>) => {
      mailCalls.push(message);
      return { accepted: ["ok"] };
    },
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  for (const key of Object.keys(configValues)) delete configValues[key];
  mailCalls.length = 0;
  resendBodies.length = 0;
  resendStatus = 200;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    resendBodies.push(JSON.parse(String(init?.body)));
    return new Response(resendStatus === 200 ? "{}" : "nope", { status: resendStatus });
  });
});

describe("configuration", () => {
  it("maps the system config onto EmailConfig with defaults", async () => {
    const config = await service.getEmailConfig();
    expect(config).toEqual({
      provider: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      smtpPass: "",
      smtpFrom: "",
      resendApiKey: "",
      resendFrom: "",
    });
  });

  it("detects a complete SMTP and Resend configuration", () => {
    const smtp = {
      provider: "smtp",
      smtpHost: "h",
      smtpPort: 25,
      smtpSecure: false,
      smtpUser: "u",
      smtpPass: "p",
      smtpFrom: "f",
      resendApiKey: "",
      resendFrom: "",
    };
    expect(service.isSmtpEnabled(smtp)).toBe(true);
    expect(service.isSmtpEnabled({ ...smtp, smtpPass: "" })).toBe(false);
    expect(service.isResendEnabled({ ...smtp, resendApiKey: "k", resendFrom: "f" })).toBe(true);
    expect(service.isResendEnabled({ ...smtp, resendApiKey: "", resendFrom: "f" })).toBe(false);
  });
});

describe("sendEmail", () => {
  it("refuses empty recipients and unconfigured providers", async () => {
    expect(await service.sendEmail("", "s", "t")).toBe(false);
    expect(await service.sendEmail("to@example.test", "s", "t")).toBe(false);
  });

  it("refuses an incomplete SMTP configuration", async () => {
    Object.assign(configValues, { EMAIL_PROVIDER: "smtp", SMTP_HOST: "h" });
    expect(await service.sendEmail("to@example.test", "s", "t")).toBe(false);
    expect(mailCalls).toHaveLength(0);
  });

  it("sends through SMTP when configured", async () => {
    Object.assign(configValues, smtpConfig);
    expect(await service.sendEmail("to@example.test", "Subject", "Body", "<b>Body</b>")).toBe(true);
    expect(mailCalls).toEqual([
      {
        from: "from@example.test",
        to: "to@example.test",
        subject: "Subject",
        text: "Body",
        html: "<b>Body</b>",
      },
    ]);
  });

  it("sends through Resend and reports failures as false", async () => {
    Object.assign(configValues, resendConfig);
    expect(await service.sendEmail("to@example.test", "Hi", "Text", "<p>Hi</p>")).toBe(true);
    expect(resendBodies).toEqual([
      {
        from: "from@example.test",
        to: ["to@example.test"],
        subject: "Hi",
        text: "Text",
        html: "<p>Hi</p>",
      },
    ]);

    resendStatus = 422;
    expect(await service.sendEmail("to@example.test", "Hi", "Text")).toBe(false);
  });

  it("returns false when the transport itself throws", async () => {
    Object.assign(configValues, resendConfig);
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await service.sendEmail("to@example.test", "Hi", "Text")).toBe(false);
  });
});
