/**
 * Node install command assembly (`apps/web/src/lib/deploy-command.ts`).
 *
 * Upstream appends a flag per filled field in a fixed order (module 513840). The test
 * pins the order, the flag spelling, the multi-IP expansion and the fact that empty
 * fields contribute nothing.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_DEPLOY_OPTIONS,
  buildInstallCommand,
  buildUninstallCommand,
  buildUpgradeCommand,
} from "../../apps/web/src/lib/deploy-command";

const origin = "https://panel.example.com";
const token = "tok_123";

describe("buildInstallCommand", () => {
  it("emits only the base command when nothing else is set", () => {
    expect(buildInstallCommand(origin, token, EMPTY_DEPLOY_OPTIONS)).toBe(
      `curl -sSL https://dl.relayx.cc/install.sh | sh -s -- -s ${origin} -t ${token}`,
    );
  });

  it("appends flags in the upstream order", () => {
    const cmd = buildInstallCommand(origin, token, {
      ...EMPTY_DEPLOY_OPTIONS,
      nodeId: "abc",
      debug: true,
      serviceName: "relayx-agent",
      outInterface: "eth0",
      listenIP: "0.0.0.0",
      portRange: "10000-20000",
    });
    const order = ["-s https://panel.example.com", "-t tok_123", "-n abc", "-d", "-S relayx-agent", "-o eth0", "-l 0.0.0.0", "-r 10000-20000"];
    let cursor = -1;
    for (const piece of order) {
      const at = cmd.indexOf(piece);
      expect(at, `missing ${piece}`).toBeGreaterThan(-1);
      expect(at, `${piece} out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("expands connect IPs on commas and whitespace", () => {
    const cmd = buildInstallCommand(origin, token, { ...EMPTY_DEPLOY_OPTIONS, connectIps: "1.2.3.4, 5.6.7.8  9.9.9.9" });
    expect(cmd).toContain("-i 1.2.3.4 -i 5.6.7.8 -i 9.9.9.9");
  });

  it("emits every port flag spelled the way the installer expects", () => {
    const cmd = buildInstallCommand(origin, token, {
      ...EMPTY_DEPLOY_OPTIONS,
      tcpPort: "1",
      mtcpPort: "2",
      udpPort: "3",
      relayxPort: "4",
      wssPort: "5",
      mwssPort: "6",
      tlsPort: "7",
      mtlsPort: "8",
      quicPort: "9",
    });
    for (const flag of ["--tcp-port 1", "--mtcp-port 2", "--udp-port 3", "--relayx-port 4", "--wss-port 5", "--mwss-port 6", "--tls-port 7", "--mtls-port 8", "--quic-port 9"]) {
      expect(cmd).toContain(flag);
    }
  });

  it("leaves vnstat/proxy out when empty and includes them when set", () => {
    const empty = buildInstallCommand(origin, token, EMPTY_DEPLOY_OPTIONS);
    expect(empty).not.toContain("-I ");
    expect(empty).not.toContain("-p ");
    const set = buildInstallCommand(origin, token, { ...EMPTY_DEPLOY_OPTIONS, vnstatInterface: "eth1", proxy: "socks5://p:1080" });
    expect(set).toContain("-I eth1");
    expect(set).toContain("-p socks5://p:1080");
  });
});

describe("upgrade / uninstall", () => {
  it("uses the published scripts", () => {
    expect(buildUpgradeCommand()).toBe("curl -sSL https://dl.relayx.cc/upgrade.sh | sh");
    expect(buildUninstallCommand()).toBe("curl -sSL https://dl.relayx.cc/uninstall.sh | sh -s -- -y");
  });
});
