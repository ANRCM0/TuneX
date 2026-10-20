"use client";
import { t, tf } from "@/lib/i18n";
/**
 * 3-step tunnel wizard, reconstructed from the shipped page
 * (reports/07 UF-01: 18 fields, step bar 1/2/3, submit posts TunnelRequest).
 *
 * Deliberate deviation: upstream uses `zodResolver(z.custom())` (no validation at all,
 * reports/08 D5). This version validates the two fields that actually break the backend
 * (name, listen_port) and keeps the same 6-message server-error → field mapping.
 */
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";
import { client, type RpcProxy } from "@/lib/client";
import { TUNNEL_TYPE_LABEL, LOAD_BALANCE_LABEL, IP_TYPE_LABEL } from "@/lib/format";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

export type TunnelDraft = {
  name: string;
  tunnel_type: string;
  listen_ip: string;
  listen_port: string;
  in_node_group_id: string;
  out_node_group_id: string;
  in_tunnel_chain_id: string;
  out_tunnel_chain_id: string;
  listen_protocol: string;
  forward_addresses_protocol: string;
  category: string;
  load_balance_type: string;
  ip_type: string;
  ip_limit: string;
  client_limit: string;
  bandwidth_limit: string;
  proxy_protocol: boolean;
  status: string;
  /** Multi-hop chain; upstream default is []. Each hop is a node group plus its role. */
  tunnel_chains: { node_type: "in" | "out"; node_group_id: string }[];
  /** Upstream default: [{ address:"", weight:1, host:null }] — reports/07 UF-01 step 2. */
  forward_addresses: { address: string; weight: string; host: string }[];
};

export const EMPTY_TUNNEL: TunnelDraft = {
  name: "",
  tunnel_type: "tcp",
  listen_ip: "",
  listen_port: "",
  in_node_group_id: "",
  out_node_group_id: "",
  in_tunnel_chain_id: "",
  out_tunnel_chain_id: "",
  listen_protocol: "http",
  forward_addresses_protocol: "http",
  category: "port_forward",
  load_balance_type: "round",
  ip_type: "auto",
  ip_limit: "",
  client_limit: "",
  bandwidth_limit: "",
  proxy_protocol: false,
  status: "active",
  tunnel_chains: [],
  forward_addresses: [{ address: "", weight: "1", host: "" }],
};

/** The exact 6 patterns upstream maps to form fields (module 894492 L4-18). */
const FIELD_ERRORS: { pattern: RegExp; field: keyof TunnelDraft }[] = [
  { pattern: /端口已存在|隧道端口已存在/, field: "listen_port" },
  { pattern: /端口不在允许范围内/, field: "listen_port" },
  { pattern: /出口节点组不能为空/, field: "out_node_group_id" },
  { pattern: /白名单 IP 数量不能超过/, field: "listen_ip" },
  { pattern: /端口范围不合法/, field: "listen_port" },
];

const STEPS = [t("zh_b122f8"), t("zh_304e67"), t("zh_21b1de")];

export function TunnelFormDialog({
  open,
  onOpenChange,
  onSaved,
  initial,
  editingId,
  api = client,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
  initial?: Partial<TunnelDraft>;
  editingId?: number | null;
  api?: RpcProxy;
}) {
  const [step, setStep] = React.useState(0);
  // Node groups feed both the chain hops and (upstream) the in/out group pickers.
  const { data: groupData } = useSWR(open ? ["/node/group", "form"] : null, async () => {
    const res = await client.node.group.$get({ query: { page: "1", perPage: "100" } });
    return (await res.json()) as { data?: { id: number; name?: string; traffic_rate?: number }[] };
  });
  const nodeGroups = groupData?.data ?? [];
  const [draft, setDraft] = React.useState<TunnelDraft>(EMPTY_TUNNEL);
  const [errors, setErrors] = React.useState<Partial<Record<keyof TunnelDraft, string>>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setDraft({ ...EMPTY_TUNNEL, ...initial });
      setStep(0);
      setErrors({});
    }
  }, [open, initial]);

  const set = <K extends keyof TunnelDraft>(k: K, v: TunnelDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = async () => {
    const next: Partial<Record<keyof TunnelDraft, string>> = {};
    if (!draft.name.trim()) next.name = t("zh_48f6a7");
    const port = Number(draft.listen_port);
    if (!draft.listen_port || !Number.isInteger(port) || port <= 0 || port > 65535) {
      next.listen_port = t("1_65535_26fabf");
    }
    setErrors(next);
    if (Object.keys(next).length) {
      setStep(next.name ? 0 : 1);
      return;
    }

    const payload = {
      name: draft.name.trim(),
      tunnel_type: draft.tunnel_type,
      listen_ip: draft.listen_ip || undefined,
      listen_port: Number(draft.listen_port),
      in_node_group_id: draft.in_node_group_id ? Number(draft.in_node_group_id) : undefined,
      out_node_group_id: draft.out_node_group_id ? Number(draft.out_node_group_id) : null,
      in_tunnel_chain_id: draft.in_tunnel_chain_id ? Number(draft.in_tunnel_chain_id) : undefined,
      out_tunnel_chain_id: draft.out_tunnel_chain_id ? Number(draft.out_tunnel_chain_id) : undefined,
      listen_protocol: draft.listen_protocol || undefined,
      forward_addresses_protocol: draft.forward_addresses_protocol || undefined,
      category: draft.category,
      load_balance_type: draft.load_balance_type,
      ip_type: draft.ip_type,
      ip_limit: draft.ip_limit ? Number(draft.ip_limit) : undefined,
      client_limit: draft.client_limit ? Number(draft.client_limit) : undefined,
      bandwidth_limit: draft.bandwidth_limit ? Number(draft.bandwidth_limit) : undefined,
      proxy_protocol: draft.proxy_protocol,
      status: draft.status,
      tunnel_chains: draft.tunnel_chains
        .filter((h) => h.node_group_id)
        .map((h) => ({ node_type: h.node_type, node_group_id: Number(h.node_group_id) })),
      forward_addresses: draft.forward_addresses
        .filter((r) => r.address.trim())
        .map((r) => ({
          address: r.address.trim(),
          weight: Number(r.weight) || 1,
          host: r.host.trim() || null,
        })),
    };

    setSaving(true);
    try {
      const res = editingId
        ? await api.tunnel[":id"].$patch({ param: { id: editingId }, json: payload })
        : await api.tunnel.$post({ json: payload });

      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.clone().json()) as { error?: unknown };
          message = typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? body);
        } catch {
          /* non-JSON body */
        }
        const hit = FIELD_ERRORS.find((f) => f.pattern.test(message));
        if (hit) setErrors((e) => ({ ...e, [hit.field]: message }));
        else toast.error(message);
        return;
      }
      toast.success(editingId ? t("zh_3ce2d1") : t("zh_0fcc3d"));
      onOpenChange(false);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingId ? t("admin.tunnels.editTunnel") : t("tunnels.createTunnel")}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => setStep(i)}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs ${
                i === step ? "bg-accent font-medium" : "text-muted-foreground"
              }`}
            >
              <span className="border-current/40 flex size-5 items-center justify-center rounded-full border text-[11px]">
                {i + 1}
              </span>
              {s}
            </button>
          ))}
        </div>

        {step === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("zh_57916d")} error={errors.name}>
              <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={t("zh_4b4833")} />
            </Field>
            <Field label={t("zh_81508b")}>
              <Select value={draft.tunnel_type} onValueChange={(v) => set("tunnel_type", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TUNNEL_TYPE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("zh_4fc129")} hint={t("zh_349f76")}>
              <Input value={draft.listen_ip} onChange={(e) => set("listen_ip", e.target.value)} placeholder="0.0.0.0" />
            </Field>
            <Field label={t("zh_7e95f4")} error={errors.listen_port}>
              <Input
                value={draft.listen_port}
                inputMode="numeric"
                onChange={(e) => set("listen_port", e.target.value)}
                placeholder="10000"
              />
            </Field>
          </div>
        ) : step === 1 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("zh_a2a58f")}>
              <Input
                value={draft.in_node_group_id}
                inputMode="numeric"
                onChange={(e) => set("in_node_group_id", e.target.value)}
                placeholder={t("id_f91524")}
              />
            </Field>
            <Field label={t("zh_59de81")} error={errors.out_node_group_id} hint={t("zh_a394eb")}>
              <Input
                value={draft.out_node_group_id}
                inputMode="numeric"
                onChange={(e) => set("out_node_group_id", e.target.value)}
                placeholder={t("id_f91524")}
              />
            </Field>
            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="text-xs">{t("zh_5ea1bb")}</Label>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => set("tunnel_chains", [...draft.tunnel_chains, { node_type: "in", node_group_id: "" }])}>
                    <Plus className="size-3.5" /> {t("zh_9a3832")}
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => set("tunnel_chains", [...draft.tunnel_chains, { node_type: "out", node_group_id: "" }])}>
                    <Plus className="size-3.5" /> {t("zh_8cc6e6")}
                  </Button>
                </div>
              </div>
              {draft.tunnel_chains.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("zh_657ebf")}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {draft.tunnel_chains.map((hop, i) => (
                    <div key={i} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
                      <span className="bg-muted rounded px-2 py-1 text-center text-[11px]">
                        {hop.node_type === "in" ? t("zh_9a3832") : t("zh_8cc6e6")}
                      </span>
                      <Select
                        value={hop.node_group_id}
                        onValueChange={(v) => {
                          const next = [...draft.tunnel_chains];
                          next[i] = { ...next[i], node_group_id: v };
                          set("tunnel_chains", next);
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder={t("zh_1e6419")} />
                        </SelectTrigger>
                        <SelectContent>
                          {nodeGroups.map((g) => (
                            <SelectItem key={g.id} value={String(g.id)}>
                              {g.name ?? `#${g.id}`}
                              {g.traffic_rate != null ? tf("ratio_3f9a2c", { rate: g.traffic_rate }) : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("zh_a56aad")}
                        onClick={() => set("tunnel_chains", draft.tunnel_chains.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-muted-foreground mt-1 text-xs">{t("zh_ce517e")}</p>
            </div>
            <Field label={t("zh_4e5d1c")}>
              <Select value={draft.category} onValueChange={(v) => set("category", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="port_forward">{t("zh_d62b07")}</SelectItem>
                  <SelectItem value="remote_port_forward">{t("zh_699a14")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("zh_b3bee4")}>
              <Select value={draft.load_balance_type} onValueChange={(v) => set("load_balance_type", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LOAD_BALANCE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="text-xs">{t("forward_addresses_11c061")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    set("forward_addresses", [...draft.forward_addresses, { address: "", weight: "1", host: "" }])
                  }
                >
                  <Plus className="size-3.5" /> {t("zh_3951f0")}
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                {draft.forward_addresses.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_1fr_auto] items-center gap-2">
                    <Input
                      placeholder="1.2.3.4:80"
                      value={row.address}
                      onChange={(e) => {
                        const next = [...draft.forward_addresses];
                        next[i] = { ...next[i], address: e.target.value };
                        set("forward_addresses", next);
                      }}
                    />
                    <Input
                      placeholder={t("zh_5b7bfd")}
                      inputMode="numeric"
                      value={row.weight}
                      onChange={(e) => {
                        const next = [...draft.forward_addresses];
                        next[i] = { ...next[i], weight: e.target.value };
                        set("forward_addresses", next);
                      }}
                    />
                    <Input
                      placeholder={t("zh_47c602")}
                      value={row.host}
                      onChange={(e) => {
                        const next = [...draft.forward_addresses];
                        next[i] = { ...next[i], host: e.target.value };
                        set("forward_addresses", next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("zh_dc36dc")}
                      disabled={draft.forward_addresses.length === 1}
                      onClick={() =>
                        set("forward_addresses", draft.forward_addresses.filter((_, idx) => idx !== i))
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground mt-1 text-xs">{t("zh_a5ce8e")}</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("zh_c6f7f5")}>
              <Select value={draft.listen_protocol} onValueChange={(v) => set("listen_protocol", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["http", "socks5", "ss", "relay", "vless", "wireguard", "openvpn", "mieru"].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("zh_082e19")}>
              <Select value={draft.forward_addresses_protocol} onValueChange={(v) => set("forward_addresses_protocol", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">{"http"}</SelectItem>
                  <SelectItem value="tls">TLS</SelectItem>
                  <SelectItem value="socks">SOCKS</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("ip_08e158")}>
              <Select value={draft.ip_type} onValueChange={(v) => set("ip_type", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(IP_TYPE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("misc.label.status")}>
              <Select value={draft.status} onValueChange={(v) => set("status", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("zh_d4e9ca")}</SelectItem>
                  <SelectItem value="inactive">{t("zh_be70be")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("ip_da9dda")}>
              <Input value={draft.ip_limit} onChange={(e) => set("ip_limit", e.target.value)} placeholder={t("zh_7fda80")} />
            </Field>
            <Field label={t("zh_23d4e0")}>
              <Input value={draft.client_limit} onChange={(e) => set("client_limit", e.target.value)} placeholder={t("zh_7fda80")} />
            </Field>
            <Field label={t("zh_df3439")}>
              <Input value={draft.bandwidth_limit} onChange={(e) => set("bandwidth_limit", e.target.value)} placeholder={t("zh_7fda80")} />
            </Field>
            <Field label="PROXY protocol">
              <div className="flex h-9 items-center">
                <Switch checked={draft.proxy_protocol} onCheckedChange={(v) => set("proxy_protocol", v)} />
              </div>
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("misc.label.cancel")}
          </Button>
          {step > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>
              {t("zh_75ef12")}
            </Button>
          ) : null}
          {step < 2 ? (
            <Button size="sm" onClick={() => setStep(step + 1)}>
              {t("zh_ea0ef2")}
            </Button>
          ) : (
            <Button size="sm" disabled={saving} onClick={() => void submit()}>
              {saving ? t("app.submitting") : t("misc.label.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {error ? <p className="text-destructive text-xs">{error}</p> : hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
