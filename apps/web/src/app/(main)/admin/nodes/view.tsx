"use client";
import { t } from "@/lib/i18n";
/** List page: 节点配置 — generated from relayx-web/artifacts/columns.json. */
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

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [
  { key: "node_group", label: t("misc.label.nodeGroups2"), variant: "multiSelect" },
  { key: "node_type", label: t("zh_4ef7fe"), variant: "select" },
  { key: "node_id", label: t("app.nodeId"), variant: "text" },
  { key: "connect_ip", label: t("ip_010efa"), variant: "text" },
  { key: "backup", label: t("zh_65ada1"), variant: "multiSelect" },
  { key: "version", label: t("zh_989d1a"), variant: "boolean" },
];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/admin/node", page, perPage, status],
    () => adminClient.node.$get,
    { page, perPage, status, ...filterParams },
  );
  const doPatch = makePatcher(mutate);
  const remove = makeDelete(adminClient.node, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "node_group",
        header: t("misc.label.nodeGroups2"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "node_type",
        header: t("zh_4ef7fe"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "node_id",
        header: t("id_e9398a"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "connect_ip",
        header: t("ip_010efa"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "weight",
        header: t("zh_5b7bfd"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "backup",
        header: t("zh_65ada1"),
        enableSorting: false,
        cell: (r) => <StatusCell value={r.getValue()} />,
      },
      {
        accessorKey: "version",
        header: t("zh_989d1a"),
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "status",
        header: t("misc.label.status"),
        enableSorting: false,
        cell: (r) => <StatusCell value={r.getValue()} />,
      },
      {
        accessorKey: "last_active",
        header: t("zh_ad3c3b"),
        enableSorting: false,
        cell: (r) => <DateCell value={r.getValue()} />,
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
                  onClick={() =>
                    void doPatch(
                      adminClient.node[":id"].$patch,
                      { param: { id: String(id) }, json: { status: "inactive" } },
                      t("zh_6c7dcb"),
                    )
                  }
                >
                  {t("app.disableNode")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void doPatch(adminClient.node.upgrade.$post, { json: { node_ids: [id] } }, t("zh_4b4de2"))
                  }
                >
                  {t("admin.nodes.upgradeNode")}
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
        title={t("nav.nodes")}
        description={t("13_4_5c1e3f")}
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
          const res = await adminClient.node[":id"].order.$patch({
            param: { id: String(id) },
            json: { order_by: orderBy },
          });
          if (res.ok) await mutate();
        }}
        mobileCard={(row) => (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{String(row.node_group ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("misc.label.nodeGroups2")} · {String(row.id ?? "")}
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
    </div>
  );
}
