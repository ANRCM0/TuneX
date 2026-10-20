"use client";
import { t, tf } from "@/lib/i18n";
/** List page: 入口保活 — generated from relayx-web/artifacts/columns.json. */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { client } from "@/lib/client";
import useSWR from "swr";
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
import { toast } from "sonner";

type Row = Record<string, unknown>;

const FILTERS: FilterDef[] = [
  { key: "in_node_group.name", label: t("zh_a2a58f"), variant: "select" },
  { key: "dns_provider.name", label: t("dns.credentials"), variant: "select" },
  { key: "status", label: t("misc.label.status"), variant: "select" },
];

export default function View() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<Record<string, unknown> | null>(null);
  const [page, setPage] = React.useState(1);
  const perPage = 10;
  const status: string | undefined = undefined;

  const { data: providers } = useSWR(["/in_node_group_dns/dns_providers"], async () => {
    const res = await client.in_node_group_dns.dns_providers.$get({ query: {} });
    return (await res.json()) as
      | { data?: { id: number; name?: string; type?: string }[] }
      | { id: number; name?: string }[];
  });
  const { controls: filterControls, params: filterParams } = useListFilters(FILTERS);
  const { data, isLoading, error, mutate } = useRpcList<Row>(
    ["/in_node_group_dns", page, perPage, status],
    () => client.in_node_group_dns.$get,
    { page, perPage, status, ...filterParams },
  );
  const remove = makeDelete(client.in_node_group_dns, { kind: "query.ids" }, mutate);

  const columns = React.useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        accessorKey: "in_node_group.name",
        header: t("zh_a2a58f"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "in_node_group.connect_ip",
        header: t("zh_282d68"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "dns_provider.name",
        header: t("dns.credentials"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "ipv6",
        header: "IPv6",
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "ttl",
        header: "TTL",
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "in_node_group.nodes",
        header: t("zh_345ea8"),
        enableSorting: false,
        cell: (r) => <span className="max-w-[18rem] truncate">{String(r.getValue() ?? "—")}</span>,
      },
      {
        accessorKey: "in_node_group.nodes",
        header: t("zh_934419"),
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
        accessorKey: "created_at",
        header: t("misc.label.created"),
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
                <DropdownMenuItem
                  onClick={() =>
                    void (async () => {
                      const res = await client.in_node_group_dns[":id"].sync.$post({
                        param: { id: String(id) },
                        json: {},
                      });
                      if (res.ok) {
                        toast.success(t("zh_feff94"));
                        await mutate();
                      }
                    })()
                  }
                >
                  {t("dns.sync")}
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
        title={t("nav.inboundKeepAlive")}
        description={tf("n_dns_3640bc", {
          n: Array.isArray(providers)
            ? providers.length
            : ((providers as { data?: unknown[] } | undefined)?.data?.length ?? 0),
        })}
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
              <span className="text-sm font-medium">{String(row.ttl ?? "—")}</span>
              {row.status ? <StatusCell value={row.status} /> : null}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {"TTL"} · {String(row.id ?? "")}
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
        open={Boolean(editRow)}
        onOpenChange={(v: boolean) => !v && setEditRow(null)}
        title={t("app.editDNSCredential")}
        fields={FIELDS.dnsProvider}
        initial={editRow ?? undefined}
        onSubmit={async (values) => {
          const res = await client.in_node_group_dns[":id"].$patch({
            param: { id: String(editRow?.id) },
            json: values,
          });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
      <CrudDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t("app.newDNSCredential")}
        fields={FIELDS.dnsProvider}
        onSubmit={async (values) => {
          const res = await client.in_node_group_dns.$post({ json: values });
          if (res.ok) await mutate();
          return res.ok;
        }}
      />
    </div>
  );
}
