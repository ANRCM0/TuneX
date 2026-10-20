"use client";
import { t } from "@/lib/i18n";
/** 隧道统计 — standalone page (reports/10 U6), DataTable over GET /tunnel/stats. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { client } from "@/lib/client";
import { useRpcList } from "@/lib/rpc";
import { ListPage } from "@/components/list-page";
import { DateCell, NumCell, TrafficCell } from "@/components/cells";

type Row = Record<string, unknown>;

export default function TunnelStatsPage() {
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const { data, isLoading, error, mutate } = useRpcList<Row>(["/tunnel/stats", page, perPage], () => client.tunnel.stats.$get, {
    page,
    perPage,
  });

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      { accessorKey: "tunnel_name", header: t("nav.tunnels"), enableSorting: true },
      { accessorKey: "in_node_group_name", header: t("zh_a2a58f"), enableSorting: false },
      { accessorKey: "out_node_group_name", header: t("zh_59de81"), enableSorting: false },
      { accessorKey: "traffic", header: t("admin.plans.traffic"), enableSorting: true, cell: (r) => <TrafficCell value={r.getValue()} /> },
      { accessorKey: "connection_count", header: t("zh_7e94aa"), enableSorting: true, cell: (r) => <NumCell value={r.getValue()} /> },
      { accessorKey: "updated_at", header: t("misc.label.updated"), enableSorting: true, cell: (r) => <DateCell value={r.getValue()} /> },
    ],
    [],
  );

  return (
    <div className="p-4 md:p-6">
      <ListPage<Row>
        title={t("nav.tunnelStats")}
        description="GET /tunnel/stats"
        columns={columns}
        data={data}
        isLoading={isLoading}
        error={error}
        mutate={mutate}
      />
    </div>
  );
}
