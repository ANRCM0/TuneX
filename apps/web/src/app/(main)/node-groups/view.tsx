"use client";
import { t } from "@/lib/i18n";
/** List page: 节点组管理 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { client } from "@/lib/client";
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
import { makeDelete, makePatch } from "@/lib/actions";
import { CrudDialog, FIELDS } from "@/components/crud-dialogs";
import { DeployDialog, type DeployGroup } from "@/components/deploy-dialog";
import { toast } from "sonner";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [
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
    ["/node/group", page, perPage, status],
    () => client.node.group.$get,
    { page, perPage, status, ...filterParams },
  );
  const remove = makeDelete(client.node.group, { kind: "query.ids" }, mutate);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<Record<string, unknown> | null>(null);
  const [deployGroup, setDeployGroup] = React.useState<DeployGroup | null>(null);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
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
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
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
                <DropdownMenuItem onClick={() => setEditRow(c.row.original as Record<string, unknown>)}>
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

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.nodeGroups")}
        description={t("onvaluechange_client_nod_453319")}
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
        filters={filterControls}
        searchPlaceholder={t("zh_85a4f1")}
        toolbarExtra={
          <>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              {t("app.new")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void (async () => {
                  const res = await client.node.check.$post({ json: {} });
                  toast.success(res.ok ? t("zh_679d07") : t("zh_9fe494"));
                })()
              }
            >
              {t("app.checkNodes")}
            </Button>
          </>
        }
        draggable
        onReorder={async (rows, orderBy, index) => {
          const id = Number((rows[index] as { id?: unknown }).id);
          const res = await client.node.group[":id"].order.$patch({
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
        onOpenChange={setCreateOpen}
        title={t("app.newNodeGroup")}
        fields={FIELDS.nodeGroup}
        onSubmit={async (values) => {
          const res = await client.node.group.$post({ json: values });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
      <CrudDialog
        open={Boolean(editRow)}
        onOpenChange={(v: boolean) => !v && setEditRow(null)}
        title={t("admin.nodeGroups.editNodeGroup")}
        fields={FIELDS.nodeGroup}
        initial={editRow ?? undefined}
        onSubmit={async (values) => {
          const res = await client.node.group[":id"].$patch({
            param: { id: String(editRow?.id) },
            json: values,
          });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
      <DeployDialog
        open={Boolean(deployGroup)}
        onOpenChange={(v: boolean) => !v && setDeployGroup(null)}
        group={deployGroup}
      />
    </div>
  );
}
