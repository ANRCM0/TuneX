"use client";
import { t } from "@/lib/i18n";
/**
 * 推广信息 — referral link + QR + earnings chart + commission table + withdraw dialog.
 * Upstream: GET /user/referral/info, /user/referral/stats, /user/commission/log,
 * POST /commission/transfer, POST /commission/withdraw (reports/07 UF-06).
 */
import * as React from "react";
import useSWR from "swr";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { Copy, Wallet } from "lucide-react";
import { client } from "@/lib/client";
import { BarSeries, ChartCard } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setPageTitle } from "@/components/page-title";

type Info = { referral_code?: string; referral_url?: string; commission?: number; balance?: number };
type Point = { date: string; earnings?: number; referral_count?: number };

export default function ReferralPage() {
  const info = useSWR(["/user/referral/info"], async () => {
    const res = await client.user.referral.info.$get({ query: {} });
    return (await res.json()) as Info;
  });
  const stats = useSWR(["/user/referral/stats"], async () => {
    const res = await client.user.referral.stats.$get({ query: { aggregate_by: "day" } });
    return (await res.json()) as Point[] | { data: Point[] };
  });

  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("alipay");
  React.useEffect(() => setPageTitle(t("nav.referral2")), []);

  const url = info.data?.referral_url ?? "";
  const points = Array.isArray(stats.data) ? stats.data : ((stats.data as { data?: Point[] })?.data ?? []);

  const transfer = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return toast.error(t("zh_686a7b"));
    const res = await client.commission.transfer.$post({ json: { amount: n } });
    if (res.ok) {
      toast.success(t("zh_64711c"));
      setAmount("");
      setOpen(false);
      await info.mutate();
    }
  };

  const commissionLog = useSWR(["/user/commission/log"], async () => {
    const res = await client.user.commission.log.$get({ query: { page: "1", perPage: "10" } });
    return (await res.json()) as {
      data?: { id: number; type?: string; amount?: number; created_at?: string }[];
    };
  });

  const withdrawList = useSWR(["/commission/withdraw"], async () => {
    const res = await client.commission.withdraw.$get({ query: { page: "1", perPage: "10" } });
    return (await res.json()) as {
      data?: { id: number; amount?: number; status?: string; created_at?: string }[];
      total?: number;
    };
  });

  const withdraw = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return toast.error(t("zh_686a7b"));
    const res = await client.commission.withdraw.$post({ json: { amount: n, method } });
    if (res.ok) {
      toast.success(t("zh_8e70e3"));
      setOpen(false);
      setAmount("");
      await info.mutate();
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t("nav.referral2")}</h2>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("zh_3125ea")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            ¥{Number(info.data?.commission ?? 0).toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("misc.label.balance")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            ¥{Number(info.data?.balance ?? 0).toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("misc.label.actions")}</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button size="sm" onClick={() => setOpen(true)}>
              <Wallet className="size-3.5" /> {t("referral.requestWithdrawal")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void transfer()}>
              {t("lib.transferCommission")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(
                  () => toast.success(t("zh_9db90e")),
                  () => toast.error(t("zh_f2c6b5")),
                );
              }}
            >
              <Copy className="size-3.5" /> {t("app.copyLink")}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ChartCard title={t("zh_94d318")} description={t("zh_6a0d40")} className="md:col-span-2">
          <BarSeries
            data={points}
            keys={[
              { key: "earnings", label: t("zh_07d9e4") },
              { key: "referral_count", label: t("zh_dc7d58") },
            ]}
          />
        </ChartCard>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("zh_7f4235")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-2">
            {url ? (
              <div className="rounded-lg bg-white p-3">
                <QRCode value={url} size={132} />
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{t("zh_79f778")}</p>
            )}
            <code className="text-muted-foreground max-w-full truncate text-xs">{url || "—"}</code>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("zh_11c4c2")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {(commissionLog.data?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("app.noCommissionRecords")}</p>
          ) : (
            (commissionLog.data?.data ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between border-b py-1 last:border-0">
                <span className="text-xs">{c.type}</span>
                <span className="tabular-nums">{Number(c.amount ?? 0).toFixed(2)}</span>
                <span className="text-muted-foreground text-xs">{c.created_at?.slice(0, 10)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("zh_b52f7a")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {(withdrawList.data?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("app.noWithdrawals")}</p>
          ) : (
            (withdrawList.data?.data ?? []).map((w) => (
              <div key={w.id} className="flex items-center justify-between border-b py-1 last:border-0">
                <span className="tabular-nums">¥{Number(w.amount ?? 0).toFixed(2)}</span>
                <span className="text-muted-foreground text-xs">
                  {w.status} · {w.created_at?.slice(0, 10)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("referral.requestWithdrawal")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("misc.label.amount")}</Label>
              <Input
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t("100_c34b20")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("zh_9f9ca5")}</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alipay">{t("zh_66f117")}</SelectItem>
                  <SelectItem value="wechat">{t("zh_68406d")}</SelectItem>
                  <SelectItem value="bank">{t("zh_0be83e")}</SelectItem>
                  <SelectItem value="usdt">USDT</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t("misc.label.cancel")}
            </Button>
            <Button size="sm" onClick={() => void withdraw()}>
              {t("zh_e4bc33")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
