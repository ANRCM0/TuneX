"use client";
import { t } from "@/lib/i18n";
/** List page: 充值记录 — generated from relayx-web/artifacts/columns.json. */
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

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [{"key": "user.email", "label": t("misc.label.email"), "variant": "text"}, {"key": "order_id", "label": t("zh_459868"), "variant": "text"}, {"key": "payment.name", "label": t("zh_a87078"), "variant": "select"}, {"key": "status", "label": t("misc.label.status"), "variant": "select"}];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(["/admin/topup", page, perPage, status], () => adminClient.topup.$get, { page, perPage, status, ...filterParams });
  const doPatch = makePatcher(mutate);
  const patch = makePatch(adminClient.topup, mutate);
  const remove = makeDelete(adminClient.topup, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
    { accessorKey: "user.email", header: t("misc.label.email"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "order_id", header: t("zh_459868"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "price", header: t("misc.label.amount"), enableSorting: true, cell: (r) => <MoneyCell value={r.getValue()} /> },
    { accessorKey: "balance", header: t("misc.label.balance"), enableSorting: true, cell: (r) => <MoneyCell value={r.getValue()} /> },
    { accessorKey: "bonus", header: t("zh_662dc8"), enableSorting: true, cell: (r) => <MoneyCell value={r.getValue()} /> },
    { accessorKey: "payment.name", header: t("zh_a87078"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "status", header: t("misc.label.status"), enableSorting: false, cell: (r) => <StatusCell value={r.getValue()} /> },
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
              <DropdownMenuItem onClick={() => void doPatch(adminClient.topup[":id"]["mark-paid"].$patch, { param: { id }, json: {} }, t("zh_d1e3d7"))}>{t("app.markAsPaid")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void doPatch(adminClient.topup[":id"].cancel.$patch, { param: { id }, json: {} }, t("zh_a5ffdc"))}>{t("app.cancelOrder")}</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => void remove([id])}>{t("misc.label.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("admin.overview.topUps")}
        description={t("pending_param_id_57b09c")}
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
              <span className="text-sm font-medium">{String(row.order_id ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("zh_459868")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
        bulkActions={(rows, clear) => (<Button variant="destructive" size="sm" onClick={() => void remove(rows.map((r) => Number(r.id))).then(clear)}>{t("misc.label.deleteSelected")}</Button>)}
      />
    </div>
  );
}
