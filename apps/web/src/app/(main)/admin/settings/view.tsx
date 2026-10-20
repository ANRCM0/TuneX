"use client";
import { t } from "@/lib/i18n";
/**
 * 系统设置 — 33 SETTING_FIELD_NAMES grouped by section, PATCH /admin/system/config,
 * 公告用 Markdown 编辑器（上游同为 md-editor，reports/05 §7）.
 */
import * as React from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { adminClient, client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownEditor } from "@/components/markdown";
import { setPageTitle } from "@/components/page-title";

/** 33 fields with their Chinese labels (artifacts/enums.json → SETTING_FIELD_NAMES). */
const FIELDS: { key: string; label: string; kind?: "bool" | "md" | "number" }[] = [
  { key: "SITE_NAME", label: t("zh_e72ec8") },
  { key: "SITE_DESCRIPTION", label: t("zh_c26358") },
  { key: "LOGO_URL", label: t("logo_cbf54e") },
  { key: "ALLOW_REGISTER", label: t("zh_67bc56"), kind: "bool" },
  { key: "NOTICE", label: t("zh_7d2396"), kind: "md" },
  { key: "NOTICE_POPUP", label: t("zh_78a009"), kind: "md" },
  { key: "NOTICE_POPUP_INTERVAL_HOURS", label: t("zh_63b81e"), kind: "number" },
  { key: "MIN_TOPUP_AMOUNT", label: t("zh_b44279"), kind: "number" },
  { key: "MIN_WITHDRAW_AMOUNT", label: t("zh_5b4771"), kind: "number" },
  { key: "HIDE_NODE_STATUS", label: t("zh_55a0ab"), kind: "bool" },
  { key: "HIDE_FOOTER", label: t("zh_62b98f"), kind: "bool" },
  { key: "HIDE_DOCS", label: t("zh_f8263c"), kind: "bool" },
  { key: "AUTO_UPDATE_AGENT", label: t("agent_e2fa3a"), kind: "bool" },
  { key: "LANDING_PAGE_URL", label: t("url_7cd326") },
  { key: "TUNNEL_TRAFFIC_RETENTION_DAYS", label: t("zh_7f3c25"), kind: "number" },
  { key: "OBSERVER_PERIOD", label: t("zh_1ae200"), kind: "number" },
  { key: "REFERRAL_COMMISSION_RATE", label: t("zh_e83475"), kind: "number" },
  { key: "REFERRAL_FIRST_ONLY", label: t("zh_f4720d"), kind: "bool" },
  { key: "REFERRAL_MODE", label: t("zh_15d209") },
  { key: "ENABLE_SUBSCRIPTION", label: t("zh_59cfbd"), kind: "bool" },
  { key: "LIMIT_SCOPE", label: t("zh_f10cd7") },
  { key: "CHATWOOT_BASE_URL", label: t("chatwoot_829052") },
  { key: "CHATWOOT_TOKEN", label: "Chatwoot Token" },
  { key: "WITHDRAW_METHODS", label: t("zh_9f9ca5") },
  { key: "EMAIL_PROVIDER", label: t("zh_784a97") },
  { key: "SMTP_HOST", label: t("smtp_9cb2a0") },
  { key: "SMTP_PORT", label: t("smtp_656521"), kind: "number" },
  { key: "SMTP_SECURE", label: "SMTP SSL/TLS", kind: "bool" },
  { key: "SMTP_USER", label: t("smtp_74d600") },
  { key: "SMTP_PASS", label: t("smtp_5e8412") },
  { key: "SMTP_FROM", label: t("smtp_afb1cf") },
  { key: "RESEND_API_KEY", label: "Resend API Key" },
  { key: "RESEND_FROM", label: t("resend_a72aca") },
];

export default function AdminSettingsPage() {
  const { data, isLoading, mutate } = useSWR(["/admin/system/config"], async () => {
    const res = await adminClient.system.config.$get({ query: {} });
    return (await res.json()) as Record<string, unknown>;
  });
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setPageTitle(t("nav.settings")), []);
  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await adminClient.system.config.$patch({ json: draft });
      if (res.ok) {
        toast.success(t("zh_e2cff7"));
        await mutate();
      }
    } finally {
      setSaving(false);
    }
  };

  const markdown = FIELDS.filter((f) => f.kind === "md");
  const others = FIELDS.filter((f) => f.kind !== "md");

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("nav.settings")}</h2>
          <p className="text-muted-foreground text-xs">{t("zh_497064")} {FIELDS.length} {t("setting_field_names_877745")}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void (async () => {
                const email = String(draft.TEST_EMAIL ?? "");
                const res = await adminClient.system.config["test-email"].$post({ json: email ? { email } : {} });
                if (res.ok) toast.success(t("zh_035a27"));
              })()
            }
          >
            {t("app.sendTestEmail")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void client.system.config.$get({ query: {} }).then(() => mutate())}>
            {t("zh_5982c4")}
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? t("zh_6644f0") : t("admin.roles.save")}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="basic">
        <TabsList>
          <TabsTrigger value="basic">{t("nav.basics")}</TabsTrigger>
          <TabsTrigger value="notice">{t("app.announcement2")}</TabsTrigger>
          <TabsTrigger value="mail">{t("zh_1c8e46")}</TabsTrigger>
        </TabsList>

        <TabsContent value="basic">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("zh_509500")}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {others.map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  {f.kind === "bool" ? (
                    <div className="flex h-9 items-center">
                      <Switch
                        checked={Boolean(draft[f.key])}
                        onCheckedChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                      />
                    </div>
                  ) : (
                    <Input
                      value={String(draft[f.key] ?? "")}
                      inputMode={f.kind === "number" ? "numeric" : undefined}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [f.key]: f.kind === "number" ? Number(e.target.value) : e.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notice">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("markdown_64f307")}</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              {markdown.map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  <MarkdownEditor
                    value={String(draft[f.key] ?? "")}
                    onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                    height={160}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mail">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("zh_519470")}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {FIELDS.filter((f) => /SMTP|RESEND|EMAIL/.test(f.key)).map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  <Input
                    value={String(draft[f.key] ?? "")}
                    type={/PASS|KEY/.test(f.key) ? "password" : "text"}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {isLoading ? <p className="text-muted-foreground text-xs">{t("app.loading")}</p> : null}
    </div>
  );
}
