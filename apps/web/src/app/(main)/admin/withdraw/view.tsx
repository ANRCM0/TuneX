"use client";
import { t } from "@/lib/i18n";
/** List page: 提现管理 — generated from relayx-web/artifacts/columns.json. */
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
  { key: "user", label: t("misc.label.users"), variant: "text" },
  { key: "status", label: t("misc.label.status"), variant: "select" },
];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/admin/withdraw", page, perPage, status],
    () => adminClient.withdraw.$get,
    { page, perPage, status, ...filterParams },
  );
  const doPatch = makePatcher(mutate);
  const patch = makePatch(adminClient.withdraw, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "id",
        header: "ID",
        enableSorting: true,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "user",
        header: t("misc.label.users"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "amount",
        header: t("zh_67272d"),
        enableSorting: true,
        cell: (r) => <MoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "method",
        header: t("zh_9f9ca5"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "account",
        header: t("zh_63e816"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "status",
        header: t("misc.label.status"),
        enableSorting: false,
        cell: (r) => <span>{labelEnum(r.getValue())}</span>,
      },
      {
        accessorKey: "remark",
        header: t("zh_e03614"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "created_at",
        header: t("zh_e85ad6"),
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
                    void doPatch(adminClient.withdraw[":id"].approve.$post, { param: { id } }, t("zh_4b3c96"))
                  }
                >
                  {t("admin.withdraw.approve")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() =>
                    void doPatch(adminClient.withdraw[":id"].reject.$post, { param: { id } }, t("zh_4c7c52"))
                  }
                >
                  {t("admin.withdraw.reject")}
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
        title={t("nav.withdrawals")}
        description={t("pending_param_id_approve_4c69a9")}
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
              <span className="text-sm font-medium">{String(row.id ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {"ID"} · {String(row.id ?? "")}
            </div>
          </div>
        )}
      />
    </div>
  );
}
