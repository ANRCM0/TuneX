import net from "node:net";

/** Upstream: src/utils/ip.ts */
export function formatIP(ip: string): string {
  if (net.isIPv4(ip)) {
    return ip;
  }
  if (ip.startsWith("[")) {
    return ip.slice(1, -1);
  }
  return ip;
}

export function joinIPAndPort(ip: string, port: number): string {
  const formattedIP = formatIP(ip);
  if (net.isIPv6(formattedIP)) {
    return `[${formattedIP}]:${port}`;
  }
  return `${formattedIP}:${port}`;
}
