"use client";
import { t } from "@/lib/i18n";
/**
 * Generic create/edit dialog used by the admin CRUD pages.
 * Field lists are taken from the shipped forms:
 *   roles      reports/11 + module 525621 (`{name, description, permissions}`)
 *   payments   module 184239 defaultValues `{name,method,status,url,fixed_fee,percent_fee,type,config}`
 *   node-groups module 551133 defaultValues (18 fields)
 *   user_plans  module 452771 defaultValues `{user_id,plan_id,expired_at,traffic,max_tunnels}`
 *   dns_provider module 246301 `{name,type,config}`
 *   plans / coupons / activities — column keys from the same pages.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

export type FieldDef = {
  key: string;
  label: string;
  kind?: "text" | "number" | "bool" | "select" | "textarea" | "password";
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
};

export function CrudDialog({
  open,
  onOpenChange,
  title,
  fields,
  initial,
  onSubmit,
  submitLabel = t("admin.roles.save"),
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  fields: FieldDef[];
  initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
  submitLabel?: string;
}) {
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    const base: Record<string, unknown> = {};
    for (const f of fields) base[f.key] = initial?.[f.key] ?? (f.kind === "bool" ? false : "");
    setValues({ ...base, ...(initial ?? {}) });
    setErrors({});
  }, [open, initial, fields]);

  const submit = async () => {
    const next: Record<string, string> = {};
    for (const f of fields) {
      if (f.required && (values[f.key] === "" || values[f.key] === undefined || values[f.key] === null)) {
        next[f.key] = t("zh_32945d");
      }
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (v === "" || v === undefined) continue;
      payload[f.key] = f.kind === "number" ? Number(v) : v;
    }
    setBusy(true);
    try {
      const ok = await onSubmit(payload);
      if (ok) {
        toast.success(t("zh_7e68eb"));
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.key} className={f.kind === "textarea" ? "sm:col-span-2" : undefined}>
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  {f.label}
                  {f.required ? <span className="text-destructive">*</span> : null}
                </Label>
                {f.kind === "bool" ? (
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={Boolean(values[f.key])}
                      onCheckedChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                    />
                  </div>
                ) : f.kind === "select" ? (
                  <Select
                    value={String(values[f.key] ?? "")}
                    onValueChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={f.placeholder ?? t("zh_382f4b")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(f.options ?? []).map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={f.kind === "password" ? "password" : "text"}
                    inputMode={f.kind === "number" ? "numeric" : undefined}
                    value={String(values[f.key] ?? "")}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                )}
                {errors[f.key] ? <p className="text-destructive text-xs">{errors[f.key]}</p> : f.hint ? <p className="text-muted-foreground text-xs">{f.hint}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("misc.label.cancel")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? t("zh_6644f0") : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Field presets for the admin CRUD pages. */
export const FIELDS = {
  role: [
    { key: "name", label: t("zh_3aa1f0"), required: true },
    { key: "description", label: t("zh_412f54") },
  ] as FieldDef[],
  payment: [
    { key: "name", label: t("misc.label.name"), required: true },
    { key: "method", label: t("zh_86ab11"), kind: "select", options: [
      { value: "epay", label: t("zh_342160") }, { value: "bepusdt", label: "BEPUSDT" }, { value: "heleket", label: "Heleket" },
    ] },
    { key: "type", label: t("misc.label.type"), kind: "select", options: [
      { value: "alipay", label: t("zh_66f117") }, { value: "wxpay", label: t("zh_68406d") }, { value: "usdt", label: "USDT" },
    ] },
    { key: "status", label: t("misc.label.status"), kind: "select", options: [
      { value: "active", label: t("zh_d4e9ca") }, { value: "inactive", label: t("zh_be70be") },
    ] },
    { key: "url", label: t("zh_29f5ba"), placeholder: "https://…" },
    { key: "fixed_fee", label: t("zh_09d65a"), kind: "number" },
    { key: "percent_fee", label: t("zh_a8021c"), kind: "number" },
  ] as FieldDef[],
  nodeGroup: [
    { key: "name", label: t("misc.label.name"), required: true },
    { key: "node_type", label: t("zh_4ef7fe"), kind: "select", options: [
      { value: "in", label: t("zh_38e9cd") }, { value: "out", label: t("zh_dd877e") },
    ] },
    { key: "load_balance_type", label: t("zh_5c9408"), kind: "select", options: [
      { value: "round", label: t("zh_65a48f") }, { value: "rand", label: t("zh_834fd6") }, { value: "fifo", label: t("zh_0ed683") },
      { value: "hash", label: t("zh_f2b0b1") }, { value: "ll", label: t("zh_ed9de3") }, { value: "lc", label: t("zh_21715b") },
    ] },
    { key: "traffic_rate", label: t("zh_e1265d"), kind: "number" },
    { key: "connect_ip", label: t("ip_532a05"), placeholder: "1.2.3.4, example.com" },
    { key: "port_range", label: t("app.portRange"), placeholder: "10000-20000", hint: t("zh_d10717") },
    { key: "need_out_node_group", label: t("zh_04e064"), kind: "bool" },
    // 高级
    { key: "allow_tunnel_types", label: t("zh_330bdc"), placeholder: "tcp,udp,wss", hint: t("zh_94c11f") },
    { key: "block_protocols", label: t("zh_637782"), placeholder: "http,socks5", hint: t("zh_1e60b4") },
    { key: "bypass_type", label: t("zh_ebb95d"), kind: "select", options: [
      { value: "blacklist", label: t("zh_2faec6") }, { value: "whitelist", label: t("admin.nodeGroups.whitelist") },
    ] },
    { key: "bypass_list", label: t("zh_59bc57"), placeholder: t("zh_b109f5") },
    { key: "admission", label: t("zh_b78025"), kind: "bool" },
    { key: "allow_listen_protocol", label: t("zh_622fa2"), kind: "bool" },
    { key: "allow_listen_protocols", label: t("zh_f1d55d"), placeholder: "http,socks5,ss", hint: t("zh_3d59bb") },
    { key: "allow_in_node_groups", label: t("zh_4bf5ea"), placeholder: "1,2,3", hint: t("zh_5d11ff") },
    { key: "allow_out_node_groups", label: t("zh_281da3"), placeholder: "1,2,3", hint: t("zh_4a180c") },
  ] as FieldDef[],
  dnsProvider: [
    { key: "name", label: t("misc.label.name"), required: true },
    { key: "type", label: t("zh_c08681"), kind: "select", options: [
      { value: "cloudflare", label: "Cloudflare" }, { value: "huawei", label: t("zh_c1c6f8") },
    ] },
    { key: "config_token", label: "Cloudflare Token", kind: "password", hint: t("cloudflare_api_token_946378") },
    { key: "config_email", label: t("cloudflare_faabb6"), hint: t("global_api_key_895693") },
    { key: "config_ak", label: t("ak_441f7c") },
    { key: "config_sk", label: t("sk_2ffeb6"), kind: "password" },
  ] as FieldDef[],
  node: [
    { key: "name", label: t("zh_3de90b") },
    { key: "node_group_id", label: t("id_f91524"), kind: "number" },
    { key: "node_type", label: t("misc.label.type"), kind: "select", options: [
      { value: "in", label: t("zh_38e9cd") }, { value: "out", label: t("zh_dd877e") },
    ] },
    { key: "backup", label: t("zh_65ada1"), kind: "select", options: [
      { value: "primary", label: t("zh_fc90df") }, { value: "backup", label: t("zh_bfd15a") },
    ] },
    { key: "ip", label: "IP" },
    { key: "port", label: t("zh_6cbb73"), kind: "number" },
    { key: "status", label: t("misc.label.status"), kind: "select", options: [
      { value: "active", label: t("zh_d4e9ca") }, { value: "inactive", label: t("zh_be70be") },
    ] },
  ] as FieldDef[],
  plan: [
    { key: "name", label: t("zh_190a20"), required: true },
    { key: "billing_cycle", label: t("zh_833988"), kind: "select", options: [
      { value: "month", label: t("zh_ccf97f") }, { value: "quarter", label: t("zh_51e67e") }, { value: "half_year", label: t("zh_89b172") },
      { value: "year", label: t("zh_1017de") }, { value: "lifetime", label: t("zh_409752") },
    ] },
    { key: "price", label: t("admin.plans.price"), kind: "number", required: true },
    { key: "original_price", label: t("zh_2b85c4"), kind: "number" },
    { key: "setup_fee", label: t("zh_47444d"), kind: "number" },
    { key: "traffic", label: t("zh_a07731"), kind: "number" },
    { key: "max_tunnels", label: t("app.tunnels"), kind: "number" },
    { key: "bandwidth_limit", label: t("zh_df3439"), kind: "number" },
    { key: "client_limit", label: t("zh_7e94aa"), kind: "number" },
    { key: "ip_limit", label: t("ip_da9dda"), kind: "number" },
    { key: "whitelist_limit", label: t("zh_9f04b9"), kind: "number" },
    { key: "stock", label: t("admin.plans.stock"), kind: "number", hint: t("zh_8b11fb") },
    { key: "status", label: t("misc.label.status"), kind: "select", options: [
      { value: "active", label: t("zh_d4e9ca") }, { value: "inactive", label: t("zh_be70be") },
    ] },
    { key: "renewable", label: t("zh_80111b"), kind: "bool" },
    { key: "allow_custom_in_node_group", label: t("zh_0717e1"), kind: "bool" },
    { key: "allow_custom_out_node_group", label: t("zh_3d490f"), kind: "bool" },
    { key: "description", label: t("zh_412f54"), kind: "textarea" },
  ] as FieldDef[],
  coupon: [
    { key: "code", label: t("zh_d7d38a"), required: true },
    { key: "type", label: t("misc.label.type"), kind: "select", options: [
      { value: "percentage", label: t("zh_4ce634") }, { value: "fixed", label: t("zh_b209f7") },
    ] },
    { key: "value", label: t("zh_74e272"), kind: "number", required: true },
    { key: "max_use", label: t("zh_10f6ed"), kind: "number" },
    { key: "max_use_per_user", label: t("zh_60b789"), kind: "number" },
    { key: "valid_start", label: t("zh_565f7b"), placeholder: "2026-01-01T00:00:00Z" },
    { key: "valid_end", label: t("zh_5892dd"), placeholder: "2026-12-31T00:00:00Z" },
  ] as FieldDef[],
  activity: [
    { key: "type", label: t("zh_0bd77b"), kind: "select", options: [
      { value: "fixed", label: t("zh_b31999") }, { value: "percentage", label: t("zh_8ed7d7") },
    ] },
    { key: "value", label: t("zh_726251"), kind: "number", required: true },
    { key: "min_amount", label: t("zh_b44279"), kind: "number" },
    { key: "max_amount", label: t("zh_629b5f"), kind: "number" },
    { key: "valid_start", label: t("zh_e8868a"), placeholder: "2026-01-01T00:00:00Z" },
    { key: "valid_end", label: t("zh_a0bb9f"), placeholder: "2026-12-31T00:00:00Z" },
  ] as FieldDef[],
  userPlan: [
    { key: "user_id", label: t("id_ee7720"), kind: "number", required: true },
    { key: "plan_id", label: t("id_ca7c0d"), kind: "number", required: true },
    { key: "expired_at", label: t("zh_3144a9"), placeholder: "2026-12-31T00:00:00Z" },
    { key: "traffic", label: t("zh_a07731"), kind: "number" },
    { key: "max_tunnels", label: t("app.tunnels"), kind: "number" },
  ] as FieldDef[],
};
