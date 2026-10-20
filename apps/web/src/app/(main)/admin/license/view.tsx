"use client";
import { t } from "@/lib/i18n";
/** License 管理 — GET /license, GET /admin/license/history, POST/PUT /admin/license. */
import * as React from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { adminClient, client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateCell, MoneyCell } from "@/components/cells";
import { setPageTitle } from "@/components/page-title";

type License = { type?: string; expired_at?: string; site_url?: string };
type History = {
  data?: { id: number; order_id?: string; amount?: number; status?: string; created_at?: string }[];
  total?: number;
};

export default function AdminLicensePage() {
  const license = useSWR(["/license", "admin"], async () => {
    const res = await client.license.$get({ query: { force: "true" } });
    return (await res.json()) as License;
  });
  const payInfo = useSWR(["/admin/license/pay"], async () => {
    const res = await adminClient.license.pay.$get({ query: {} });
    return (await res.json()) as { url?: string; price?: number; type?: string };
  });
  const coupon = useSWR(["/license/coupon"], async () => {
    const res = await client.license.coupon.$get({ query: {} });
    return (await res.json()) as { code?: string; discount?: number };
  });
  const history = useSWR(["/admin/license/history", 1], async () => {
    const res = await adminClient.license.history.$get({ query: { page: "1", limit: "10" } });
    return (await res.json()) as History;
  });
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setPageTitle(t("nav.license")), []);

  const activate = async () => {
    if (!key.trim()) return toast.error(t("license_2cdb4e"));
    setBusy(true);
    try {
      const res = await adminClient.license.$post({ json: { license: key.trim() } });
      if (res.ok) {
        toast.success(t("license_6112c1"));
        setKey("");
        await Promise.all([license.mutate(), history.mutate()]);
      }
    } finally {
      setBusy(false);
    }
  };

  const rows = history.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t("nav.license")}</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("zh_46f0f1")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("misc.label.type")}</span>
            <span>
              {license.data?.type === "business"
                ? t("zh_7b6c3b")
                : license.data?.type === "personal"
                  ? t("zh_af5013")
                  : t("zh_f1ebc7")}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("misc.label.expires")}</span>
            <DateCell value={license.data?.expired_at} />
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("app.site")}</span>
            <span>{license.data?.site_url ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("zh_d7d38a")}</span>
            <span>{coupon.data?.code ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("zh_06f59e")}</span>
            <span>{payInfo.data?.price != null ? `¥${payInfo.data.price}` : "—"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("zh_501661")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label className="text-xs">License Key</Label>
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("license_a7e16f")} />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void (async () => {
                await adminClient.license.$put({ json: { license: key.trim() } });
                toast.success(t("zh_4ac906"));
                await license.mutate();
              })()
            }
            disabled={!key.trim()}
          >
            {t("app.update")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const url = payInfo.data?.url;
              if (url) window.open(url, "_blank", "noopener,noreferrer");
              else toast.error(t("zh_ab6014"));
            }}
          >
            {t("app.buyLicense")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void activate()}>
            {busy ? t("app.submitting") : t("misc.label.submit")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("nav.orders")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("app.orders")}</TableHead>
                <TableHead>{t("misc.label.amount")}</TableHead>
                <TableHead>{t("misc.label.status")}</TableHead>
                <TableHead>{t("zh_89b4aa")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-20 text-center">
                    {t("misc.empty.noData")}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">{r.order_id ?? r.id}</TableCell>
                    <TableCell>
                      <MoneyCell value={r.amount} />
                    </TableCell>
                    <TableCell>{r.status ?? "—"}</TableCell>
                    <TableCell>
                      <DateCell value={r.created_at} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
