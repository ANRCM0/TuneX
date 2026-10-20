"use client";
import { t } from "@/lib/i18n";
/** List page: 支付配置 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { adminClient, client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { useListFilters, type FilterDef } from "@/components/list-filters";
import {
  CopyCell,
  DateCell,
  MoneyCell,
  QrCell,
  SignedMoneyCell,
  StatusCell,
  TrafficCell,
} from "@/components/cells";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { labelEnum } from "@/lib/format";
import { makeDelete, makePatch, makePatcher } from "@/lib/actions";
import { CrudDialog, FIELDS } from "@/components/crud-dialogs";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [
  { key: "name", label: t("misc.label.name"), variant: "text" },
  { key: "method", label: t("zh_a87078"), variant: "select" },
  { key: "status", label: t("misc.label.status"), variant: "select" },
];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/admin/pay", page, perPage, status],
    () => adminClient.pay.$get,
    { page, perPage, status, ...filterParams },
  );
  const remove = makeDelete(adminClient.pay, { kind: "param.id" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("misc.label.name"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "method",
        header: t("zh_a87078"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "type",
        header: t("zh_f0d837"),
        enableSorting: false,
        cell: (r) => <span>{labelEnum(r.getValue())}</span>,
      },
      {
        accessorKey: "fixed_fee",
        header: t("zh_09d65a"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "percent_fee",
        header: t("zh_a8021c"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "url",
        header: "URL",
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "status",
        header: t("misc.label.status"),
        enableSorting: false,
        cell: (r) => <StatusCell value={r.getValue()} />,
      },
      {
        accessorKey: "created_at",
        header: t("misc.label.created"),
        enableSorting: true,
        cell: (r) => <DateCell value={r.getValue()} />,
      },
      {
        accessorKey: "updated_at",
        header: t("misc.label.updated"),
        enableSorting: true,
        cell: (r) => <DateCell value={r.getValue()} />,
      },
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
                <DropdownMenuItem
                  onClick={() => {
                    setEditing(c.row.original as Record<string, unknown>);
                    setCreateOpen(true);
                  }}
                >
                  {t("misc.label.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => void remove([id])}>
                  {t("misc.label.delete")}
                </DropdownMenuItem>
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

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.payments")}
        description={t("adminclient_pay_id_delet_2c3a88")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        filters={filterControls}
        searchPlaceholder={t("zh_85a4f1")}
        draggable
        onReorder={async (rows, orderBy, index) => {
          const id = Number((rows[index] as { id?: unknown }).id);
          const res = await adminClient.pay[":id"].order.$patch({
            param: { id: String(id) },
            json: { order_by: orderBy },
          });
          if (res.ok) await mutate();
        }}
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{String(row.name ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("misc.label.name")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
        toolbarExtra={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("app.new")}
          </Button>
        }
        bulkActions={(rows, clear) => (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void remove(rows.map((r) => Number(r.id))).then(clear)}
          >
            {t("misc.label.deleteSelected")}
          </Button>
        )}
      />

      <CrudDialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) setEditing(null);
        }}
        initial={editing ?? undefined}
        title={t("app.newPayment")}
        fields={FIELDS.payment}
        onSubmit={async (values) => {
          const res = editing
            ? await adminClient.pay[":id"].$patch({ param: { id: String(editing.id) }, json: values })
            : await adminClient.pay.$post({ json: values });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
    </div>
  );
}
