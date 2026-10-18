import { createTransport, type Transporter } from "nodemailer";
import { SystemConfigName } from "@prisma/client";
import { logger } from "../logger";
import { TOKENS, instance, service } from "../container";
import type { SystemConfigService } from "./system_config";

/**
 * Upstream: src/services/email.ts (136 lines) — ported 1:1.
 *
 * Two providers are supported and selected by the `EMAIL_PROVIDER` system config:
 * `smtp` (nodemailer, transporter cached per connection tuple) and `resend` (HTTP API).
 * `sendEmail` never throws — it returns `false` for a missing recipient, an
 * unconfigured/disabled provider, or a transport failure, and logs the failure.
 */

export interface EmailConfig {
  provider: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  resendApiKey: string;
  resendFrom: string;
}

export class EmailService {
  private systemConfigService: SystemConfigService;
  private transporterCache?: { key: string; transporter: Transporter };

  constructor(systemConfigService: SystemConfigService) {
    this.systemConfigService = systemConfigService;
  }

  async getEmailConfig(): Promise<EmailConfig> {
    const configs = await this.systemConfigService.getConfigs([
      SystemConfigName.EMAIL_PROVIDER,
      SystemConfigName.SMTP_HOST,
      SystemConfigName.SMTP_PORT,
      SystemConfigName.SMTP_SECURE,
      SystemConfigName.SMTP_USER,
      SystemConfigName.SMTP_PASS,
      SystemConfigName.SMTP_FROM,
      SystemConfigName.RESEND_API_KEY,
      SystemConfigName.RESEND_FROM,
    ]);
    return {
      provider: (configs[SystemConfigName.EMAIL_PROVIDER] as string) || "",
      smtpHost: (configs[SystemConfigName.SMTP_HOST] as string) || "",
      smtpPort: Number(configs[SystemConfigName.SMTP_PORT]) || 587,
      smtpSecure: Boolean(configs[SystemConfigName.SMTP_SECURE]),
      smtpUser: (configs[SystemConfigName.SMTP_USER] as string) || "",
      smtpPass: (configs[SystemConfigName.SMTP_PASS] as string) || "",
      smtpFrom: (configs[SystemConfigName.SMTP_FROM] as string) || "",
      resendApiKey: (configs[SystemConfigName.RESEND_API_KEY] as string) || "",
      resendFrom: (configs[SystemConfigName.RESEND_FROM] as string) || "",
    };
  }

  getSmtpTransporter(config: EmailConfig): Transporter {
    const key = JSON.stringify({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      user: config.smtpUser,
      pass: config.smtpPass,
    });
    if (this.transporterCache?.key === key) {
      return this.transporterCache.transporter;
    }
    const transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
    this.transporterCache = { key, transporter };
    return transporter;
  }

  isSmtpEnabled(config: EmailConfig): boolean {
    return Boolean(
      config.smtpHost &&
        config.smtpPort &&
        config.smtpUser &&
        config.smtpPass &&
        config.smtpFrom,
    );
  }

  isResendEnabled(config: EmailConfig): boolean {
    return Boolean(config.resendApiKey && config.resendFrom);
  }

  async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<boolean> {
    if (!to) {
      return false;
    }
    const config = await this.getEmailConfig();
    try {
      if (config.provider === "smtp") {
        if (!this.isSmtpEnabled(config)) {
          return false;
        }
        const transporter = this.getSmtpTransporter(config);
        await transporter.sendMail({
          from: config.smtpFrom,
          to,
          subject,
          text,
          html,
        });
        return true;
      }
      if (config.provider === "resend") {
        if (!this.isResendEnabled(config)) {
          return false;
        }
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.resendApiKey}`,
          },
          body: JSON.stringify({
            from: config.resendFrom,
            to: [to],
            subject,
            text,
            html,
          }),
        });
        if (!res.ok) {
          logger.error(
            { status: res.status, body: await res.text() },
            "Failed to send email via Resend",
          );
          return false;
        }
        return true;
      }
      return false;
    } catch (error) {
      logger.error({ error, to, subject }, "Failed to send email");
      return false;
    }
  }
}

export const emailService = service<EmailService>(
  TOKENS.Mail,
  () =>
    new EmailService(
      instance.resolve<SystemConfigService>(TOKENS.SystemConfig),
    ),
);
