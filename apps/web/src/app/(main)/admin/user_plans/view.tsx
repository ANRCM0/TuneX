"use client";
import { t } from "@/lib/i18n";
/** List page: 用户套餐 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { adminClient, client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { useListFilters, type FilterDef } from "@/components/list-filters";
import { CopyCell, DateCell, MoneyCell, QrCell, SignedMoneyCell, StatusCell, TrafficCell } from "@/components/cells";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { labelEnum } from "@/lib/format";
import { makeDelete, makePatch, makePatcher } from "@/lib/actions";
import { CrudDialog, FIELDS } from "@/components/crud-dialogs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [{"key": "user.email", "label": t("misc.label.email"), "variant": "text"}, {"key": "plan.name", "label": t("zh_190a20"), "variant": "select"}];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(["/admin/user_plan", page, perPage, status], () => adminClient.user_plan.$get, { page, perPage, status, ...filterParams });
  const doPatch = makePatcher(mutate);
  const patch = makePatch(adminClient.user_plan, mutate);
  const remove = makeDelete(adminClient.user_plan, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
    { accessorKey: "user.email", header: t("misc.label.email"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "plan.name", header: t("zh_190a20"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "traffic_used", header: t("gb_48494e"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "traffic", header: t("gb_14e926"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "max_tunnels", header: t("zh_e75467"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "expired_at", header: t("zh_27aefe"), enableSorting: true, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "created_at", header: t("misc.label.created"), enableSorting: true, cell: (r) => <DateCell value={r.getValue()} /> },
      {
        id: "actions",
        header: "",
        cell: (c) => {
          const id = Number(c.row.original.id);
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t("misc.label.actions")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void doPatch(adminClient.user_plan[":id"].$patch, { param: { id }, json: {} }, t("zh_f8574f"))}>{t("zh_b48fe0")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setEditing(c.row.original as Record<string, unknown>); setCreateOpen(true); }}>{t("misc.label.edit")}</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => void remove([id])}>{t("misc.label.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [],
  );

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Record<string, unknown> | null>(null);
  const [renewIds, setRenewIds] = React.useState<number[] | null>(null);

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.userPlans")}
        description={t("9_adminclient_user_plan__bf7ca6")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        filters={filterControls}
        searchPlaceholder={t("zh_85a4f1")}
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{String(row.traffic_used ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("gb_48494e")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
        toolbarExtra={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("app.new")}
          </Button>
        }
        bulkActions={(rows, clear) => (
          <>
            <Button variant="outline" size="sm" onClick={() => setRenewIds(rows.map((r) => Number(r.id)))}>
              {t("app.bulkRenew")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void remove(rows.map((r) => Number(r.id))).then(clear)}>
              {t("misc.label.deleteSelected")}
            </Button>
          </>
        )}
      />

      {renewIds ? (
        <RenewDialog ids={renewIds} onClose={() => setRenewIds(null)} onDone={() => void mutate()} />
      ) : null}
      <CrudDialog
        open={createOpen}
        onOpenChange={(v) => { setCreateOpen(v); if (!v) setEditing(null); }}
        initial={editing ?? undefined}
        title={t("app.newUserPlan")}
        fields={FIELDS.userPlan}
        onSubmit={async (values) => {
          const res = editing
            ? await adminClient.user_plan[":id"].$patch({ param: { id: String(editing.id) }, json: values })
            : await adminClient.user_plan.$post({ json: values });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
    </div>
  );
}

function RenewDialog({ ids, onClose, onDone }: { ids: number[]; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = React.useState("");
  const [traffic, setTraffic] = React.useState("");
  return (
    <Dialog open onOpenChange={(v: boolean) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t("zh_45222b")}{ids.length} {t("zh_372545")}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_422024")}</Label>
            <Input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value)} placeholder={t("30_a30674")} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("zh_1cdce5")}</Label>
            <Input value={traffic} inputMode="numeric" onChange={(e) => setTraffic(e.target.value)} placeholder={t("zh_d861f8")} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t("misc.label.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => {
              if (!days && !traffic) return toast.error(t("zh_406b24"));
              void (async () => {
                const json: Record<string, unknown> = { ids };
                if (days) json.add_days = Number(days);
                if (traffic) json.add_traffic = Number(traffic);
                const res = await adminClient.user_plan.$patch({ json });
                if (res.ok) {
                  toast.success(t("zh_51722a"));
                  onClose();
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
