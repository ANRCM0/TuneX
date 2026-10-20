"use client";
/**
 * 节点一键部署 —— 命令拼装复刻自 module 513840（node-groups 页）：
 *   curl -sSL https://dl.relayx.cc/install.sh | sh -s -- -s <origin> -t <token> [-n id] [-i ip]... [-d]
 *   [-S service] [-o outIface] [-I vnstatIface] [-l listenIp] [-p proxy] [-r portRange]
 *   [--tcp-port] [--mtcp-port] [--udp-port] [--relayx-port] [--wss-port] [--mwss-port]
 *   [--tls-port] [--mtls-port] [--quic-port]
 * 另外提供升级 / 卸载命令（上游同样来自 dl.relayx.cc）。
 */
import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { t, tf } from "@/lib/i18n";

import {
  buildInstallCommand,
  buildUninstallCommand,
  buildUpgradeCommand,
  EMPTY_DEPLOY_OPTIONS,
  PORT_FLAGS,
  type DeployOptions,
} from "@/lib/deploy-command";

export type DeployGroup = { id?: number; name?: string; token?: string };

function CommandBlock({ value, downloadName }: { value: string; downloadName?: string }) {
  const copy = () =>
    void navigator.clipboard.writeText(value).then(
      () => toast.success(t("app.copied")),
      () => toast.error(t("app.copyFailed")),
    );
  return (
    <div className="space-y-2">
      <pre className="bg-muted max-h-40 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
        {value}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          <Copy className="size-3.5" /> {t("app.copy")}
        </Button>
        {downloadName ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const blob = new Blob([value], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = downloadName;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            }}
          >
            {t("app.save")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function DeployDialog({
  open,
  onOpenChange,
  group,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  group: DeployGroup | null;
}) {
  const [opts, setOpts] = React.useState<DeployOptions>(EMPTY_DEPLOY_OPTIONS);
  React.useEffect(() => {
    if (open) setOpts(EMPTY_DEPLOY_OPTIONS);
  }, [open]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const command = React.useMemo(
    () => buildInstallCommand(origin, group?.token ?? "<token>", opts),
    [origin, group?.token, opts],
  );

  const set = <K extends keyof DeployOptions>(k: K, v: DeployOptions[K]) =>
    setOpts((s) => ({ ...s, [k]: v }));
  const field = (key: keyof DeployOptions, label: string, placeholder?: string) => (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        value={String(opts[key] ?? "")}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value as never)}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{tf("app.deployNode", { name: group?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("app.deployHint")}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="install">
          <TabsList>
            <TabsTrigger value="install">{t("app.install")}</TabsTrigger>
            <TabsTrigger value="upgrade">{t("app.upgrade")}</TabsTrigger>
            <TabsTrigger value="uninstall">{t("app.uninstall")}</TabsTrigger>
          </TabsList>

          <TabsContent value="install" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {field("nodeId", t("app.nodeId"), t("uuid_481232"))}
              {field("connectIps", t("app.connectIps"), "1.2.3.4, 5.6.7.8")}
              {field("serviceName", t("app.serviceName"), "relayx-agent")}
              {field("outInterface", t("app.outInterface"), "eth0")}
              {field("vnstatInterface", t("app.vnstatInterface"), "eth0")}
              {field("listenIP", t("app.listenIp"), "0.0.0.0")}
              {field("proxy", t("app.proxy"), "socks5://…")}
              {field("portRange", t("app.portRange"), "10000-20000")}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {PORT_FLAGS.map(({ key, flag }) => (
                <React.Fragment key={key}>{field(key, flag.replace("--", ""))}</React.Fragment>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={opts.debug} onCheckedChange={(v) => set("debug", v)} />
              <Label className="text-xs">debug (-d)</Label>
            </div>
            <CommandBlock value={command} downloadName="install.sh" />
          </TabsContent>

          <TabsContent value="upgrade" className="space-y-3">
            <p className="text-muted-foreground text-xs">{t("app.upgradeHint")}</p>
            <CommandBlock value={buildUpgradeCommand()} />
          </TabsContent>

          <TabsContent value="uninstall" className="space-y-3">
            <p className="text-muted-foreground text-xs">{t("app.uninstallHint")}</p>
            <CommandBlock value={buildUninstallCommand()} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("app.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
