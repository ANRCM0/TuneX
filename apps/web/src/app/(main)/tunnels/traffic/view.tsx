"use client";
import { t } from "@/lib/i18n";
/** List page: 隧道流量 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { useListFilters, type FilterDef } from "@/components/list-filters";
import { CopyCell, DateCell, MoneyCell, QrCell, SignedMoneyCell, StatusCell, TrafficCell } from "@/components/cells";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { labelEnum } from "@/lib/format";
import { makeDelete, makePatch } from "@/lib/actions";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [{"key": "tunnel.name", "label": t("zh_57916d"), "variant": "text"}, {"key": "tunnel.in_node_group.name", "label": t("zh_a2a58f"), "variant": "select"}, {"key": "tunnel.out_node_group.name", "label": t("zh_59de81"), "variant": "select"}, {"key": "date", "label": t("zh_1b0381"), "variant": "dateRange"}];

export default function View() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);

  const { data, isLoading, error, mutate } = useRpcList<Row>(["/tunnel/traffic", page, perPage, status], () => client.tunnel.traffic.$get, { page, perPage, status, ...filterParams });
  const patch = makePatch(client.tunnel.traffic, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
    { accessorKey: "tunnel.name", header: t("zh_57916d"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "tunnel.in_node_group.name", header: t("zh_a2a58f"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "tunnel.out_node_group.name", header: t("zh_59de81"), enableSorting: false, cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span> },
    { accessorKey: "traffic", header: t("zh_7428ba"), enableSorting: true, cell: (r) => <TrafficCell value={r.getValue()} /> },
    { accessorKey: "traffic_cost", header: t("zh_b4a0aa"), enableSorting: true, cell: (r) => <TrafficCell value={r.getValue()} /> },
    { accessorKey: "date", header: t("zh_1b0381"), enableSorting: true, cell: (r) => <DateCell value={r.getValue()} /> },

    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("app.tunnelTraffic")}
        description={t("6_daterange_start_date_e_4d186b")}
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
              <span className="text-sm font-medium">{String(row.traffic ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("zh_7428ba")} · {String(row.id ?? "")}
            </div>
          </div>
        )}

      />
    </div>
  );
}
