/**
 * CLI tests — exercise the real `tsx src/index.ts` entry point in a child process so the
 * exit codes, stdout text and signal handling are verified exactly as an operator sees them
 * (this is the port of the Python `cli()` subcommands).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RELAYX_AGENT_LICENSE_SECRET } from "../src/config";
import { fernetDecrypt } from "../src/fernet";
import { LicenseStore } from "../src/store";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(APP_ROOT, "src/index.ts");
const SITE = "https://cli.example.com";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...args], {
      cwd: APP_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Parse the pretty-printed license JSON that `issue` writes before its hint block. */
function parseIssuedLicense(stdout: string): Record<string, string> {
  const end = stdout.indexOf("\n}");
  expect(end).toBeGreaterThan(0);
  return JSON.parse(stdout.slice(0, end + 2)) as Record<string, string>;
}

let tempDir: string;
let dbPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "relayx-license-cli-"));
  dbPath = join(tempDir, "license.db");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("issue / list / rebind / revoke", () => {
  it("issues a personal license and prints the panel hint block", async () => {
    const result = await runCli(["--db", dbPath, "issue", "--site-url", SITE, "--type", "personal", "--days", "30"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const license = parseIssuedLicense(result.stdout);
    expect(license.site_url).toBe(SITE);
    expect(license.type).toBe("personal");
    const payload = JSON.parse(
      fernetDecrypt(RELAYX_AGENT_LICENSE_SECRET, license.content).toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 1, type: "personal", site_url: SITE, edition: "self-hosted" });
    expect(payload.expired_at).toEqual(expect.any(Number));
    expect(result.stdout).toContain("[*] 面板侧刷新授权（会清掉 Redis 缓存后重新拉取）:");
    expect(result.stdout).toContain("docker compose exec redis redis-cli DEL license");
    expect(result.stdout).toContain(`curl -s ${SITE}/api/license`);
  });

  it("lists issued licenses", async () => {
    const result = await runCli(["--db", dbPath, "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("site_url");
    expect(result.stdout).toContain(SITE);
    expect(result.stdout).toContain("personal");
  });

  it("rebinds by content and then revokes", async () => {
    const store = new LicenseStore(dbPath);
    const license = store.get(SITE);
    store.close();
    expect(license).not.toBeNull();

    const renamed = "https://renamed-cli.example.com";
    const rebound = await runCli([
      "--db",
      dbPath,
      "rebind",
      "--content",
      license?.content ?? "",
      "--site-url",
      renamed,
    ]);
    expect(rebound.code).toBe(0);
    expect(rebound.stdout).toContain("[*] 换绑成功");

    const revoked = await runCli(["--db", dbPath, "revoke", "--site-url", renamed]);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain("[*] 已吊销 1 条；面板侧需 DEL license 才会立即生效");

    const afterRevoke = new LicenseStore(dbPath);
    expect(afterRevoke.get(renamed)).toBeNull();
    afterRevoke.close();
  });

  it("reports an unknown content on rebind with exit code 1", async () => {
    const result = await runCli(["--db", dbPath, "rebind", "--content", "selfhosted-nope", "--site-url", SITE]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[!] 未找到匹配的 content");
  });

  it("honours --content-mode before the subcommand (argparse parity)", async () => {
    const fernetSite = "https://fernet-cli.example.com";
    const result = await runCli([
      "--db",
      dbPath,
      "--content-mode",
      "fernet",
      "issue",
      "--site-url",
      fernetSite,
      "--days",
      "90",
    ]);
    expect(result.code).toBe(0);
    const license = parseIssuedLicense(result.stdout);
    const payload = JSON.parse(fernetDecrypt(RELAYX_AGENT_LICENSE_SECRET, license.content).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ v: 1, type: "business", site_url: fernetSite, edition: "self-hosted" });
  });
});

describe("argument errors", () => {
  it("requires --site-url for issue", async () => {
    const result = await runCli(["--db", dbPath, "issue"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("错误: 需要 --site-url");
  });

  it("rejects an unknown subcommand and a missing subcommand", async () => {
    const unknown = await runCli(["--db", dbPath, "frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("未知子命令: frobnicate");
    const missing = await runCli(["--db", dbPath]);
    expect(missing.code).toBe(2);
  });

  it("rejects an invalid content mode and port", async () => {
    const mode = await runCli(["--db", dbPath, "--content-mode", "rot13", "list"]);
    expect(mode.code).toBe(2);
    expect(mode.stderr).toContain("content 模式非法");
    const port = await runCli(["--db", dbPath, "--port", "70000", "list"]);
    expect(port.code).toBe(2);
    expect(port.stderr).toContain("端口非法");
  });
});

describe("serve", () => {
  it("boots on a fixed port, answers /health and exits cleanly on SIGINT", async () => {
    const port = 3911;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", ENTRY, "--db", join(tempDir, "serve.db"), "serve", "--port", String(port)],
      { cwd: APP_ROOT, env: { ...process.env, NO_COLOR: "1" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not boot in time: ${stdout}${stderr}`)), 20_000);
        const poll = setInterval(() => {
          if (stdout.includes("自建授权服务器监听")) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 100);
        child.once("exit", (code) => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(`server exited early with ${code}: ${stdout}${stderr}`));
        });
      });

      expect(stdout).toContain(`LICENSE_URL=http://<本机地址>:${port}`);
      expect(stdout).toContain("[*] 数据库:");
      expect(stdout).toContain("[*] 签发: tsx");

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(typeof body.ts).toBe("string");

      const missing = await fetch(`http://127.0.0.1:${port}/license`);
      expect(missing.status).toBe(400);

      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGINT");
      expect(await exited).toBe(0);
      expect(stdout).toContain("[*] 退出");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
