import { SystemConfigName } from "@prisma/client";
import { db } from "../db";
import { service, TOKENS } from "../container";

/**
 * Upstream: src/services/system_config.ts (108 lines) — ported verbatim.
 *
 * Note: upstream's `getAllConfigs` only returns rows that exist in the database (it does
 * not backfill defaults), while `getConfigs` does. The replica keeps that asymmetry.
 */
export const DefaultConfig: Record<SystemConfigName, unknown> = {
  [SystemConfigName.MIN_TOPUP_AMOUNT]: 10,
  [SystemConfigName.NOTICE]: "",
  [SystemConfigName.NOTICE_POPUP]: "",
  [SystemConfigName.NOTICE_POPUP_INTERVAL_HOURS]: 24,
  [SystemConfigName.SITE_NAME]: "RelayX",
  [SystemConfigName.SITE_DESCRIPTION]: "专为商业运营设计的企业级多协议隧道代理管理平台",
  [SystemConfigName.ALLOW_REGISTER]: true,
  [SystemConfigName.LOGO_URL]: "",
  [SystemConfigName.HIDE_NODE_STATUS]: false,
  [SystemConfigName.AUTO_UPDATE_AGENT]: false,
  [SystemConfigName.CHATWOOT_BASE_URL]: "",
  [SystemConfigName.CHATWOOT_TOKEN]: "",
  [SystemConfigName.TUNNEL_TRAFFIC_RETENTION_DAYS]: 30,
  [SystemConfigName.HIDE_FOOTER]: false,
  [SystemConfigName.HIDE_DOCS]: false,
  [SystemConfigName.LANDING_PAGE_URL]: "",
  [SystemConfigName.REFERRAL_COMMISSION_RATE]: 0,
  [SystemConfigName.REFERRAL_FIRST_ONLY]: false,
  [SystemConfigName.REFERRAL_MODE]: "topup",
  [SystemConfigName.OBSERVER_PERIOD]: 5,
  [SystemConfigName.EMAIL_PROVIDER]: "",
  [SystemConfigName.SMTP_HOST]: "",
  [SystemConfigName.SMTP_PORT]: 587,
  [SystemConfigName.SMTP_SECURE]: false,
  [SystemConfigName.SMTP_USER]: "",
  [SystemConfigName.SMTP_PASS]: "",
  [SystemConfigName.SMTP_FROM]: "",
  [SystemConfigName.RESEND_API_KEY]: "",
  [SystemConfigName.RESEND_FROM]: "",
  [SystemConfigName.MIN_WITHDRAW_AMOUNT]: 100,
  [SystemConfigName.WITHDRAW_METHODS]: "",
  [SystemConfigName.LIMIT_SCOPE]: "tunnel",
  [SystemConfigName.ENABLE_SUBSCRIPTION]: false,
};

export class SystemConfigService {
  async getConfig<T = unknown>(name: SystemConfigName): Promise<T> {
    const config = await db.systemConfig.findUnique({ where: { name }, select: { value: true } });
    if (config) {
      return (JSON.parse(config.value) ?? DefaultConfig[name]) as T;
    }
    return DefaultConfig[name] as T;
  }

  async setConfigs(configs: Partial<Record<SystemConfigName, unknown>>): Promise<void> {
    await db.$transaction(async (tx) => {
      for (const [name, value] of Object.entries(configs)) {
        const jsonValue = JSON.stringify(value);
        const nameEnum = name as SystemConfigName;
        await tx.systemConfig.upsert({
          where: { name: nameEnum },
          update: { value: jsonValue },
          create: { name: nameEnum, value: jsonValue },
        });
      }
    });
  }

  async getConfigs(names: SystemConfigName[]): Promise<Record<string, unknown>> {
    const configs = await db.systemConfig.findMany({
      where: { name: { in: names } },
      select: { name: true, value: true },
    });
    const ret: Record<string, unknown> = {};
    for (const name of names) {
      const config = configs.find((c) => c.name === name);
      if (config) {
        ret[name] = JSON.parse(config.value) ?? DefaultConfig[name];
      } else {
        ret[name] = DefaultConfig[name];
      }
    }
    return ret;
  }

  async getAllConfigs(): Promise<Record<string, unknown>> {
    const configs = await db.systemConfig.findMany({ select: { name: true, value: true } });
    return configs.reduce<Record<string, unknown>>((acc, config) => {
      acc[config.name] = JSON.parse(config.value) ?? DefaultConfig[config.name as SystemConfigName];
      return acc;
    }, {});
  }
}

/** Self-registration. */
export const systemConfigService = service<SystemConfigService>(
  TOKENS.SystemConfig,
  () => new SystemConfigService(),
);
