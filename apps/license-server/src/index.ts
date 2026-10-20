#!/usr/bin/env node
/**
 * CLI — a flag-for-flag port of the Python reference's argparse interface
 * (`relayx-analysis/relayx_license_server.py` → `cli()`), plus the TS-idiomatic
 * environment-variable layer documented in `config.ts`.
 *
 *   relayx-license-server [全局选项] serve
 *   relayx-license-server [全局选项] issue --site-url <SITE_URL> [--type business|personal] [--days N]
 *   relayx-license-server [全局选项] list
 *   relayx-license-server [全局选项] revoke --site-url <SITE_URL>
 *   relayx-license-server [全局选项] rebind --content <CONTENT> --site-url <SITE_URL>
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createApp } from "./app";
import { resolveConfig } from "./config";
import type { ContentMode } from "./config";
import { startLicenseServer } from "./server";
import { LicenseStore } from "./store";

const USAGE = `RelayX 自建授权服务器（TypeScript 版）

用法:
  tsx src/index.ts [全局选项] <serve|issue|list|revoke|rebind> [子命令选项]

全局选项:
  --db <路径>            SQLite 数据库路径（默认 license.db，环境变量 LICENSE_DB）
  --host <地址>          监听地址（默认 127.0.0.1，环境变量 LICENSE_HOST）
  --port <端口>          监听端口（默认 3100，环境变量 LICENSE_PORT）
  --content-mode <模式>  plain | base64 | fernet（默认 fernet，环境变量 LICENSE_CONTENT_MODE）
  --quiet                关闭请求日志

子命令:
  serve                  启动 HTTP 服务
  issue --site-url <URL> [--type business|personal] [--days N]   签发/续期授权
  list                   列出全部授权
  revoke --site-url <URL>                                        吊销授权
  rebind --content <content> --site-url <URL>                    换绑授权到新域名
`;

const LICENSE_TYPES = ["business", "personal"] as const;

interface CliRunResult {
  code: number;
}

function fail(message: string): CliRunResult {
  process.stderr.write(`错误: ${message}\n`);
  return { code: 2 };
}

function optionalInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} 需要整数，收到: ${raw}`);
  }
  return value;
}

/** Run the CLI. Returns the process exit code; `serve` only returns after a signal. */
export async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "content-mode": { type: "string" },
        quiet: { type: "boolean" },
        "site-url": { type: "string" },
        type: { type: "string" },
        days: { type: "string" },
        content: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    process.stderr.write(`${USAGE}\n`);
    return fail(error instanceof Error ? error.message : String(error)).code;
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;
  const command = parsed.positionals[0];

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig({
      dbPath: values.db as string | undefined,
      host: values.host as string | undefined,
      port: optionalInteger(values.port as string | undefined, "port", 0) || undefined,
      contentMode: values["content-mode"] as string | undefined,
      quiet: values.quiet === true,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error)).code;
  }

  const siteUrl = values["site-url"] as string | undefined;

  if (command === "serve") {
    return serve(config, () => openStore(config.dbPath, config.contentMode, config.fernetSecret));
  }

  if (command === "issue") {
    if (!siteUrl) return fail("需要 --site-url").code;
    const licenseType = (values.type as string | undefined) ?? "business";
    if (!(LICENSE_TYPES as readonly string[]).includes(licenseType)) {
      return fail(`--type 只能为 ${LICENSE_TYPES.join(" 或 ")}`).code;
    }
    let days: number;
    try {
      days = optionalInteger(values.days as string | undefined, "days", 3650);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error)).code;
    }

    const store = openStore(config.dbPath, config.contentMode, config.fernetSecret);
    try {
      const license = store.issue(siteUrl, licenseType, days, config.contentMode);
      process.stdout.write(`${JSON.stringify(license, null, 2)}\n\n`);
      process.stdout.write("[*] 面板侧刷新授权（会清掉 Redis 缓存后重新拉取）:\n");
      process.stdout.write("    docker compose exec redis redis-cli DEL license\n");
      process.stdout.write(`    curl -s ${siteUrl}/api/license\n`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (command === "list") {
    const store = openStore(config.dbPath, config.contentMode, config.fernetSecret);
    try {
      const rows = store.all();
      const pad = (value: string, width: number): string => value.padEnd(width);
      process.stdout.write(
        `${pad("id", 4)} ${pad("status", 8)} ${pad("type", 10)} ${pad("expired_at", 26)} site_url\n`,
      );
      if (rows.length === 0) {
        process.stdout.write("(无授权记录)\n");
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${pad(String(row.id), 4)} ${pad(row.status, 8)} ${pad(row.type, 10)} ${pad(row.expired_at, 26)} ${row.site_url}\n`,
          );
        }
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (command === "revoke") {
    if (!siteUrl) return fail("需要 --site-url").code;
    const store = openStore(config.dbPath, config.contentMode, config.fernetSecret);
    try {
      const count = store.revoke(siteUrl);
      process.stdout.write(`[*] 已吊销 ${count} 条；面板侧需 DEL license 才会立即生效\n`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (command === "rebind") {
    const content = values.content as string | undefined;
    if (!content || !siteUrl) return fail("需要 --content 与 --site-url").code;
    const store = openStore(config.dbPath, config.contentMode, config.fernetSecret);
    try {
      const rebound = store.rebind(content, siteUrl);
      process.stdout.write(rebound ? "[*] 换绑成功\n" : "[!] 未找到匹配的 content\n");
      return rebound ? 0 : 1;
    } finally {
      store.close();
    }
  }

  process.stderr.write(`${USAGE}\n`);
  return fail(`未知子命令: ${command}`).code;
}

function openStore(dbPath: string, contentMode: ContentMode, fernetSecret: string): LicenseStore {
  return new LicenseStore(dbPath, { contentMode, fernetSecret });
}

async function serve(
  config: ReturnType<typeof resolveConfig>,
  storeFactory: () => LicenseStore,
): Promise<number> {
  const store = storeFactory();
  const app = createApp(store, {
    contentMode: config.contentMode,
    fernetSecret: config.fernetSecret,
    verbose: !config.quiet,
  });

  const server = await startLicenseServer(app, { host: config.host, port: config.port });
  const entry = process.argv[1] ?? "<license-server>";
  const absoluteDbPath = resolvePath(config.dbPath);

  process.stdout.write(`[*] RelayX 自建授权服务器监听 ${server.url}\n`);
  process.stdout.write(`[*] 数据库: ${absoluteDbPath}   content 模式: ${config.contentMode}\n`);
  process.stdout.write(`[*] 面板侧配置: LICENSE_URL=http://<本机地址>:${server.port}\n`);
  process.stdout.write(`[*] 签发: tsx ${entry} --db ${absoluteDbPath} issue --site-url <面板SITE_URL>\n`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      process.stdout.write("\n[*] 退出\n");
      void server
        .close()
        .catch(() => undefined)
        .then(() => {
          store.close();
          resolve(0);
        });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
