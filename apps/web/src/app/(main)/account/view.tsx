"use client";
import { t, tf } from "@/lib/i18n";
/**
 * 个人中心 — 资料 / API Key / 订阅密钥 / 自动续费 / 改密 / 充值入口.
 * Upstream PATCHes each field independently (5 × PATCH /user) — reports/07 UF-07.
 */
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";
import { client } from "@/lib/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setPageTitle } from "@/components/page-title";
import { useUser } from "@/lib/hooks";

type UserInfo = {
  id: number;
  email: string;
  api_key?: string;
  subscription_key?: string;
  auto_renew?: boolean;
  balance?: number;
  commission?: number;
};

export default function AccountPage() {
  const { data: user, mutate } = useUser();
  const { data: info } = useSWR<Partial<UserInfo>>(["/user/info", "raw"], async () => user as unknown as Partial<UserInfo>, {
    fallbackData: user as unknown as Partial<UserInfo>,
  });
  const [pwd, setPwd] = React.useState("");
  const [email, setEmail] = React.useState("");
  React.useEffect(() => setPageTitle(t("nav.profile")), []);

  const patch = async (json: Record<string, unknown>, okMsg: string) => {
    const res = await client.user.$patch({ json });
    if (res.ok) {
      toast.success(okMsg);
      await mutate();
    }
  };

  const resetKey = async (field: "api_key" | "subscription_key") => {
    const value = crypto.randomUUID();
    await patch({ [field]: value }, field === "api_key" ? t("api_key_f72885") : t("zh_51dee0"));
  };

  const { data: bot } = useSWR(["/bot"], async () => {
    const res = await client.bot.$get({ query: {} });
    return (await res.json()) as { enabled?: boolean; username?: string; bind_key?: string; bind_url?: string };
  });

  const renew = async (planId: number) => {
    const res = await client.plan.renew.$post({ json: { plan_id: planId } });
    if (res.ok) {
      toast.success(t("zh_1e6b6b"));
      await mutate();
    }
  };

  const router = useRouter();
  const search = useSearchParams();
  React.useEffect(() => {
    const status = search.get("trade_status");
    if (!status) return;
    if (status === "TRADE_SUCCESS") {
      toast.success(t("topup.paid"));
      void mutate();
    } else {
      toast.error(tf("topup.failed", { status }));
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("trade_status");
    router.replace(url.pathname + (url.search || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const copy = (v?: string) => {
    if (!v) return;
    void navigator.clipboard.writeText(v).then(
      () => toast.success(t("zh_e381a5")),
      () => toast.error(t("zh_f2c6b5")),
    );
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t("nav.profile")}</h2>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("landing.account")}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">{t("misc.label.email")}</span><span>{info?.email ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t("misc.label.balance")}</span><span className="tabular-nums">¥{Number(info?.balance ?? 0).toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t("app.commission")}</span><span className="tabular-nums">¥{Number(info?.commission ?? 0).toFixed(2)}</span></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("telegram_38d24c")}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {bot?.enabled
              ? tf("username_99adbf", { username: bot.username ?? "—" })
              : t("telegram_163aa6")}
          </p>
          {bot?.bind_url ? (
            <Button size="sm" variant="outline" asChild>
              <a href={bot.bind_url} target="_blank" rel="noopener noreferrer">
                {t("app.connect")}
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_b48fe0")}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between">
          <p className="text-muted-foreground text-xs">{t("zh_3b86e5")}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const planId = (user as unknown as { user_plan?: { plan_id?: number } })?.user_plan?.plan_id;
              if (!planId) return toast.error(t("zh_1124c0"));
              void renew(planId);
            }}
          >
            {t("account.renewNow")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_efe6de")}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between">
          <p className="text-muted-foreground text-xs">{t("zh_cfef1a")}</p>
          <Switch
            checked={Boolean(info?.auto_renew)}
            onCheckedChange={(v) => void patch({ auto_renew: v }, v ? t("zh_e16701") : t("zh_c4f0ca"))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">API Key</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2">
          <code className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs">{info?.api_key ?? t("zh_3c04f9")}</code>
          <Button variant="outline" size="icon" className="size-8" aria-label={t("misc.label.copy")} onClick={() => copy(info?.api_key)}>
            <Copy className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void resetKey("api_key")}>
            <RefreshCw className="size-3.5" /> {t("zh_3d8134")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_ff1321")}</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2">
          <code className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs">{info?.subscription_key ?? t("zh_3c04f9")}</code>
          <Button variant="outline" size="icon" className="size-8" aria-label={t("misc.label.copy")} onClick={() => copy(info?.subscription_key)}>
            <Copy className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void resetKey("subscription_key")}>
            <RefreshCw className="size-3.5" /> {t("zh_3d8134")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_2b8e47")}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {[
            ["notify_topup", t("zh_0a4c7a")],
            ["notify_plan_expire", t("zh_f327d9")],
            ["notify_node_offline", t("zh_3051be")],
            ["notify_ticket", t("zh_6ac58c")],
          ].map(([key, label]) => {
            const subs =
              (info as unknown as { notify_subscriptions?: Record<string, boolean> })?.notify_subscriptions ?? {};
            return (
              <div key={key} className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">{label}</span>
                <Switch
                  checked={Boolean(subs[key])}
                  onCheckedChange={(v) =>
                    void patch({ notify_subscriptions: { ...subs, [key]: v } }, v ? t("zh_d78cde") : t("zh_f62876"))
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_1c3757")}</CardTitle></CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label className="text-xs">{t("zh_b4e7c5")}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="new@example.com" />
          </div>
          <Button
            size="sm"
            onClick={() => {
              if (!email.includes("@")) return toast.error(t("zh_bc1873"));
              void patch({ email }, t("zh_42ad7f")).then(() => setEmail(""));
            }}
          >
            {t("app.save")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t("zh_0ae20a")}</CardTitle></CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label className="text-xs">{t("zh_d22c9c")}</Label>
            <Input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={t("8_bfd5e7")} />
          </div>
          <Button
            size="sm"
            onClick={() => {
              if (pwd.length < 8) return toast.error(t("8_67ac94"));
              void patch({ password: pwd }, t("zh_eb5719")).then(() => setPwd(""));
            }}
          >
            {t("admin.roles.save")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
