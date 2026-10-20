"use client";
import { t } from "@/lib/i18n";
/** List page: 余额记录 — generated from relayx-web/artifacts/columns.json. */
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

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [{ key: "type", label: t("misc.label.type"), variant: "select" }];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/user/balance/log", page, perPage, status],
    () => client.user.balance.log.$get,
    { page, perPage, status, ...filterParams },
  );
  const patch = makePatch(client.user.balance.log, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "type",
        header: t("misc.label.type"),
        enableSorting: false,
        cell: (r) => <span>{labelEnum(r.getValue())}</span>,
      },
      {
        accessorKey: "amount",
        header: t("zh_206663"),
        enableSorting: true,
        cell: (r) => <SignedMoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "balance",
        header: t("misc.label.balance"),
        enableSorting: true,
        cell: (r) => <MoneyCell value={r.getValue()} />,
      },
      {
        accessorKey: "created_at",
        header: t("zh_89b4aa"),
        enableSorting: true,
        cell: (r) => <DateCell value={r.getValue()} />,
      },
    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.balanceHistory")}
        description={t("4_type_1fc8ef")}
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
              <span className="text-sm font-medium">{String(row.type ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("misc.label.type")} · {String(row.id ?? "")}
            </div>
          </div>
        )}
      />
    </div>
  );
}
