/**
 * Node install / upgrade / uninstall command assembly.
 *
 * Reconstructed from module 513840 (node-groups page): upstream builds the string by
 * appending a flag per filled field. Kept free of React so it can be unit-tested
 * (tests/unit/web-deploy-command.test.ts).
 */
export const INSTALL_SCRIPT = "https://dl.relayx.cc/install.sh";
export const UPGRADE_SCRIPT = "https://dl.relayx.cc/upgrade.sh";
export const UNINSTALL_SCRIPT = "https://dl.relayx.cc/uninstall.sh";

export type DeployOptions = {
  nodeId: string;
  connectIps: string;
  debug: boolean;
  serviceName: string;
  outInterface: string;
  vnstatInterface: string;
  listenIP: string;
  proxy: string;
  portRange: string;
  tcpPort: string;
  mtcpPort: string;
  udpPort: string;
  relayxPort: string;
  wssPort: string;
  mwssPort: string;
  tlsPort: string;
  mtlsPort: string;
  quicPort: string;
};

export const EMPTY_DEPLOY_OPTIONS: DeployOptions = {
  nodeId: "",
  connectIps: "",
  debug: false,
  serviceName: "",
  outInterface: "",
  vnstatInterface: "",
  listenIP: "",
  proxy: "",
  portRange: "",
  tcpPort: "",
  mtcpPort: "",
  udpPort: "",
  relayxPort: "",
  wssPort: "",
  mwssPort: "",
  tlsPort: "",
  mtlsPort: "",
  quicPort: "",
};

/** `--<name>-port` flags, in the order upstream appends them. */
export const PORT_FLAGS: { key: keyof DeployOptions; flag: string }[] = [
  { key: "tcpPort", flag: "--tcp-port" },
  { key: "mtcpPort", flag: "--mtcp-port" },
  { key: "udpPort", flag: "--udp-port" },
  { key: "relayxPort", flag: "--relayx-port" },
  { key: "wssPort", flag: "--wss-port" },
  { key: "mwssPort", flag: "--mwss-port" },
  { key: "tlsPort", flag: "--tls-port" },
  { key: "mtlsPort", flag: "--mtls-port" },
  { key: "quicPort", flag: "--quic-port" },
];

export function buildInstallCommand(origin: string, token: string, o: DeployOptions): string {
  let cmd = `curl -sSL ${INSTALL_SCRIPT} | sh -s -- -s ${origin} -t ${token}`;
  if (o.nodeId) cmd += ` -n ${o.nodeId}`;
  for (const ip of o.connectIps.split(/[,\s]+/).filter(Boolean)) cmd += ` -i ${ip}`;
  if (o.debug) cmd += " -d";
  if (o.serviceName) cmd += ` -S ${o.serviceName}`;
  if (o.outInterface) cmd += ` -o ${o.outInterface}`;
  if (o.vnstatInterface) cmd += ` -I ${o.vnstatInterface}`;
  if (o.listenIP) cmd += ` -l ${o.listenIP}`;
  if (o.proxy) cmd += ` -p ${o.proxy}`;
  if (o.portRange) cmd += ` -r ${o.portRange}`;
  for (const { key, flag } of PORT_FLAGS) {
    const v = o[key];
    if (typeof v === "string" && v) cmd += ` ${flag} ${v}`;
  }
  return cmd;
}

export const buildUpgradeCommand = () => `curl -sSL ${UPGRADE_SCRIPT} | sh`;
export const buildUninstallCommand = () => `curl -sSL ${UNINSTALL_SCRIPT} | sh -s -- -y`;
