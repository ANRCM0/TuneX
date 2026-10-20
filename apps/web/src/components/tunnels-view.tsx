"use client";
import { t, tf } from "@/lib/i18n";
import * as React from "react";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { MoreHorizontal, Plus, QrCode } from "lucide-react";
import { getSortingStateParser } from "@/lib/sorting";
import { useTunnels, keyTunnels } from "@/lib/hooks";
import { adminClient, client, type RpcProxy } from "@/lib/client";
import { DataTable } from "@/components/data-table";
import { BadgeStatus } from "@/components/ui/badge-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { setPageTitle } from "@/components/page-title";
import { TunnelFormDialog, type TunnelDraft } from "@/components/tunnel-form";
import { TunnelQrDialog } from "@/components/tunnel-qr";
import type { ShareTunnel } from "@/lib/tunnel-share";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

type Tunnel = {
  id: number;
  name: string;
  tunnel_type: string;
  listen_port: number;
  status: string;
  in_node_group_id: number;
  out_node_group_id: number;
  created_at: string;
};

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [text, setText] = React.useState("");
  const [groupId, setGroupId] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t("tunnels.importTunnels")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("id_605348")}</Label>
            <Input value={groupId} inputMode="numeric" onChange={(e) => setGroupId(e.target.value)} placeholder={t("zh_32945d")} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("json_0c3873")}</Label>
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"name":"a","listen_port":10000,"dest":["1.2.3.4:80"]}]' />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("misc.label.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => {
              if (!text.trim()) return toast.error(t("zh_61fdf3"));
              if (!groupId) return toast.error(t("zh_8d3e32"));
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                return toast.error(t("json_f28576"));
              }
              void (async () => {
                const res = await client.tunnel.import.$post({
                  json: { in_node_group_id: Number(groupId), tunnels: parsed },
                });
                if (res.ok) {
                  toast.success(t("zh_425516"));
                  onOpenChange(false);
                  setText("");
                  onDone();
                }
              })();
            }}
          >
            {t("misc.label.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchDialog({ open, onOpenChange, ids, onDone, api }: { open: boolean; onOpenChange: (v: boolean) => void; ids: number[]; onDone: () => void; api: RpcProxy }) {
  const [status, setStatus] = React.useState("");
  const [lb, setLb] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("zh_cfd50d")}{ids.length} {t("zh_372545")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("misc.label.status")}</Label>
            <Input value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t("active_inactive_b92fff")} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_b3bee4")}</Label>
            <Input value={lb} onChange={(e) => setLb(e.target.value)} placeholder={t("round_rand_fifo_0d92f4")} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("misc.label.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => {
              const payload: Record<string, unknown> = { ids };
              if (status) payload.status = status;
              if (lb) payload.load_balance_type = lb;
              if (Object.keys(payload).length === 1) return toast.error(t("zh_a2cc2f"));
              void (async () => {
                const res = await api.tunnel.batch.update.$patch({ json: payload });
                if (res.ok) {
                  toast.success(t("zh_9ad419"));
                  onOpenChange(false);
                  onDone();
                }
              })();
            }}
          >
            {t("misc.label.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TunnelsView({ mode = "user" }: { mode?: "user" | "admin" }) {
  const api = mode === "admin" ? adminClient : client;
  const [importOpen, setImportOpen] = React.useState(false);
  const [batchIds, setBatchIds] = React.useState<number[] | null>(null);
  const [whitelistOpen, setWhitelistOpen] = React.useState(false);
  const [whitelistId, setWhitelistId] = React.useState<number | null>(null);
  const [page] = useQueryState("page", parseAsInteger.withDefault(1));
  const [perPage] = useQueryState("perPage", parseAsInteger.withDefault(10));
  const [sort] = useQueryState("sort", getSortingStateParser());
  const [status] = useQueryState("status", parseAsString);
  const { data, isLoading, error, mutate } = useTunnels(page, perPage, sort);

  React.useEffect(() => setPageTitle(t("nav.tunnelManagement")), []);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Tunnel | null>(null);
  const [qr, setQr] = React.useState<ShareTunnel | null>(null);

  const rows = (data?.data ?? []) as unknown as Tunnel[];

  const columns = React.useMemo<ColumnDef<Tunnel, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("misc.label.name"),
        cell: (c) => (
          <span className="flex items-center gap-1">
            <span className="font-medium">{String(c.getValue() ?? "")}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("zh_2d0366")}
              onClick={() => setQr(c.row.original as unknown as ShareTunnel)}
            >
              <QrCode className="size-3" />
            </Button>
          </span>
        ),
      },
      { accessorKey: "tunnel_type", header: t("zh_b0c431"), cell: (c) => <code className="text-xs">{String(c.getValue() ?? "")}</code> },
      { accessorKey: "listen_port", header: t("zh_a31d9f"), cell: (c) => <span className="tabular-nums">{String(c.getValue() ?? "")}</span> },
      { accessorKey: "status", header: t("misc.label.status"), cell: (c) => <BadgeStatus status={String(c.getValue() ?? "")} /> },
      { accessorKey: "created_at", header: t("misc.label.created"), cell: (c) => <span className="text-muted-foreground text-xs">{formatDate(String(c.getValue() ?? ""))}</span> },
      {
        id: "actions",
        header: "",
        cell: (c) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("misc.label.actions")}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  void (async () => {
                    const row = c.row.original;
                    const next = row.status === "active" ? "inactive" : "active";
                    const res = await api.tunnel[":id"].status.$patch({ param: { id: row.id }, json: { status: next } });
                    if (res.ok) {
                      toast.success(next === "active" ? t("zh_25d284") : t("zh_6c7dcb"));
                      await mutate();
                    }
                  })()
                }
              >
                {c.row.original.status === "active" ? t("zh_a10f66") : t("zh_3583d7")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setEditing(c.row.original);
                  setFormOpen(true);
                }}
              >
                {t("admin.tunnels.editTunnel")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void (async () => {
                    const res = await api.tunnel[":id"].test.$get({ param: { id: c.row.original.id } });
                    const body = await res.json();
                    toast.success(tf("result_909fc2", { result: JSON.stringify(body).slice(0, 120) }));
                  })()
                }
              >
                {t("zh_0e8bfd")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setWhitelistId(c.row.original.id); setWhitelistOpen(true); }}>
                {t("app.editWhitelist")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onClick={() => void remove([c.row.original.id])}>
                {t("zh_577afe")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  );

  const remove = async (ids: number[]) => {
    // upstream batch deletes carry `query.ids` as a comma-joined string
    const res = await api.tunnel.$delete({ query: { ids: ids.join(",") } });
    if (res.ok) {
      toast.success(ids.length > 1 ? tf("n_066ab7", { n: ids.length }) : t("zh_86e8d1"));
      await mutate();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("nav.tunnelManagement")}</h2>
          <p className="text-muted-foreground text-xs">{t("zh_497064")} {data?.total ?? 0} {t("zh_eb8c2d")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          {t("app.import")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="size-4" /> {t("app.newTunnel")}
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        total={data?.total ?? 0}
        page={page}
        perPage={perPage}
        onPageChange={(p) => void (window.location.search = `?page=${p}&perPage=${perPage}${sort ? `&sort=${JSON.stringify(sort)}` : ""}`)}
        sorting={sort as SortingState}
        isLoading={isLoading}
        error={error}
        draggable
        onReorder={async (rows, orderBy, index) => {
          const id = Number((rows[index] as { id?: unknown }).id);
          const res = await api.tunnel[":id"].order.$patch({ param: { id: String(id) }, json: { order_by: orderBy } });
          if (!res.ok) throw new Error(t("zh_594fe0"));
          await mutate();
        }}
        actionBar={(selected) => (
          <>
            <Button variant="outline" size="sm" onClick={() => setBatchIds(selected.map((r) => r.id))}>
              {t("admin.tunnels.bulkEdit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void (async () => {
                  const res = await api.tunnel.traffic.$delete({ query: { ids: selected.map((r) => r.id).join(",") } });
                  if (res.ok) {
                    toast.success(t("zh_2b18fa"));
                    await mutate();
                  }
                })()
              }
            >
              {t("admin.tunnels.clearTraffic")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const text = selected
                  .map((r) => JSON.stringify({ name: r.name, listen_port: r.listen_port }))
                  .join("\n");
                void navigator.clipboard.writeText(text).then(
                  () => toast.success(t("zh_d405d2")),
                  () => toast.error(t("zh_d36769")),
                );
              }}
            >
              {t("app.export")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void remove(selected.map((r) => r.id))}>
              {t("misc.label.deleteSelected")}
            </Button>
          </>
        )}
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{row.name}</span>
              <BadgeStatus status={row.status} />
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {row.tunnel_type} {t("zh_c45981")} {row.listen_port}
            </div>
          </div>
        )}
      />
      <p className="text-muted-foreground text-xs">
        SWR key: <code>{JSON.stringify(keyTunnels(page, perPage, sort))}</code>{t("status_53c9fc")} {status ?? t("zh_8bb38e")}）
      </p>

      <TunnelFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editingId={editing?.id ?? null}
        api={api}
        initial={
          editing
            ? ({
                name: editing.name,
                tunnel_type: editing.tunnel_type,
                listen_port: String(editing.listen_port),
                in_node_group_id: String(editing.in_node_group_id ?? ""),
                out_node_group_id: String(editing.out_node_group_id ?? ""),
                status: editing.status,
              } as Partial<TunnelDraft>)
            : undefined
        }
        onSaved={() => void mutate()}
      />
      <TunnelQrDialog tunnel={qr} onOpenChange={(v: boolean) => !v && setQr(null)} />
      <WhitelistDialog
        open={whitelistOpen}
        tunnelId={whitelistId}
        onOpenChange={setWhitelistOpen}
        onDone={() => void mutate()}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={() => void mutate()} />
      {batchIds ? (
        <BatchDialog open onOpenChange={(v: boolean) => !v && setBatchIds(null)} ids={batchIds} onDone={() => void mutate()} api={api} />
      ) : null}
    </div>
  );
}

function WhitelistDialog({
  open,
  tunnelId,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  tunnelId: number | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [text, setText] = React.useState("");
  React.useEffect(() => {
    if (!open || !tunnelId) return;
    void (async () => {
      const res = await client.tunnel.whitelist.$get({ query: { id: String(tunnelId) } });
      if (!res.ok) return;
      const body = (await res.json()) as { whitelist_ips?: string[] };
      setText((body.whitelist_ips ?? []).join("\n"));
    })();
  }, [open, tunnelId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("ip_43a300")}</DialogTitle></DialogHeader>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("ip_cidr_4a2a72")}</Label>
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="1.2.3.4&#10;10.0.0.0/8" />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("misc.label.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => {
              if (!tunnelId) return;
              const ips = text.split("\n").map((s) => s.trim()).filter(Boolean);
              void (async () => {
                const res = await client.tunnel.whitelist.$patch({ json: { id: tunnelId, whitelist_ips: ips } });
                if (res.ok) {
                  toast.success(t("zh_29b8bd"));
                  onOpenChange(false);
                  onDone();
                }
              })();
            }}
          >
            {t("admin.roles.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
