"use client";
/**
 * 隧道二维码 / 配置链接对话框，复刻上游 TunnelQrDialog：
 *   - 按 listen_protocol.type 生成 8 种分享串（见 tunnel-share.ts）
 *   - wireguard 提供「配置 / v2rayN / Shadowrocket」三选；openvpn 提供 .ovpn 下载
 *   - 复制与下载（Blob + a[download]）
 */
import * as React from "react";
import QRCode from "react-qr-code";
import { AlertTriangle, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { buildShare, type ShareTunnel } from "@/lib/tunnel-share";
import { t, tf } from "@/lib/i18n";

type ClientTab = "v2rayn" | "shadowrocket" | "conf";

export function TunnelQrDialog({
  tunnel,
  onOpenChange,
}: {
  tunnel: ShareTunnel | null;
  onOpenChange: (v: boolean) => void;
}) {
  const [client, setClient] = React.useState<ClientTab>("v2rayn");
  const share = React.useMemo(() => (tunnel ? buildShare(tunnel) : null), [tunnel]);

  const type = tunnel?.listen_protocol?.type;
  const isWg = type === "wireguard";
  const isOvpn = type === "openvpn";

  const value = React.useMemo(() => {
    if (!share) return "";
    if (isOvpn) return share.ovpn ?? "";
    if (isWg) {
      if (client === "conf") return share.conf ?? "";
      if (client === "shadowrocket") return share.shadowrocketUrl ?? "";
      return share.v2raynUrl ?? "";
    }
    return share.url ?? "";
  }, [share, isOvpn, isWg, client]);

  const download = (name: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={Boolean(tunnel)} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isOvpn ? "max-h-[90vh] overflow-y-auto sm:max-w-2xl" : "max-h-[90vh] overflow-y-auto sm:max-w-md"
        }
      >
        <DialogHeader>
          <DialogTitle>{t("share.qrTitle")}</DialogTitle>
          <DialogDescription>{tf("share.qrDesc", { name: tunnel?.name ?? "" })}</DialogDescription>
        </DialogHeader>

        {!share ? (
          <p className="text-muted-foreground text-sm">{t("share.unsupported")}</p>
        ) : (
          <div className="space-y-3">
            {isOvpn ? (
              <div className="bg-muted/60 flex gap-2 rounded-md p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-1">
                  <p>{t("share.ovpnWarning")}</p>
                  <a
                    className="underline"
                    href="https://openvpn.net/client/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    https://openvpn.net/client/
                  </a>
                </div>
              </div>
            ) : null}

            {isWg ? (
              <Tabs value={client} onValueChange={(v) => setClient(v as ClientTab)}>
                <TabsList className="w-full">
                  <TabsTrigger value="conf">{t("share.conf")}</TabsTrigger>
                  <TabsTrigger value="v2rayn">v2rayN</TabsTrigger>
                  <TabsTrigger value="shadowrocket">Shadowrocket</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}

            {!isOvpn && !isWg && value ? (
              <div className="flex justify-center rounded-lg bg-white p-4">
                <QRCode value={value} size={176} />
              </div>
            ) : null}

            <pre className="bg-muted max-h-56 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
              {value}
            </pre>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  void navigator.clipboard.writeText(value).then(
                    () => toast.success(t("share.copied")),
                    () => toast.error(t("share.copyFailed")),
                  )
                }
              >
                <Copy className="size-3.5" /> {t("app.copy")}
              </Button>
              {isOvpn ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    download(`${tunnel?.name ?? "relayx"}.ovpn`, value, "application/x-openvpn-profile")
                  }
                >
                  <Download className="size-3.5" /> {t("share.downloadOvpn")}
                </Button>
              ) : isWg && client === "conf" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => download(`${tunnel?.name ?? "relayx"}.conf`, value, "text/plain")}
                >
                  <Download className="size-3.5" /> {t("share.downloadConf")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
