"use client";
import { t } from "@/lib/i18n";
/** List page: 节点组配置 — generated from relayx-web/artifacts/columns.json. */
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
  { key: "user.email", label: t("misc.label.email"), variant: "text" },
  { key: "name", label: t("misc.label.name"), variant: "text" },
  { key: "connect_ip", label: t("zh_67d2d7"), variant: "text" },
  { key: "node_type", label: t("misc.label.type"), variant: "select" },
  { key: "allow_tunnel_types", label: t("zh_330bdc"), variant: "select" },
];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/admin/node/group", page, perPage, status],
    () => adminClient.node.group.$get,
    { page, perPage, status, ...filterParams },
  );
  const remove = makeDelete(adminClient.node.group, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "user.email",
        header: t("misc.label.email"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "name",
        header: t("misc.label.name"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "connect_ip",
        header: t("zh_67d2d7"),
        enableSorting: false,
        cell: (r) => <CopyCell value={r.getValue()} />,
      },
      {
        accessorKey: "node_type",
        header: t("misc.label.type"),
        enableSorting: false,
        cell: (r) => <StatusCell value={r.getValue()} />,
      },
      {
        accessorKey: "allow_tunnel_types",
        header: t("zh_330bdc"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "load_balance_type",
        header: t("zh_5c9408"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "traffic_rate",
        header: t("zh_e1265d"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "need_out_node_group",
        header: t("zh_04e064"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
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
        title={t("misc.label.nodeGroups")}
        description={t("12_32f6b0")}
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
          const res = await adminClient.node.group[":id"].order.$patch({
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
        title={t("app.newNodeGroup")}
        fields={FIELDS.nodeGroup}
        onSubmit={async (values) => {
          const res = editing
            ? await adminClient.node.group[":id"].$patch({ param: { id: String(editing.id) }, json: values })
            : await adminClient.node.group.$post({ json: values });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
    </div>
  );
}
