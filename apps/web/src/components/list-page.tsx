"use client";
import { t } from "@/lib/i18n";
/**
 * Generic list page: title + toolbar (search / status filter) + DataTable + bulk bar.
 * Every one of the 30 upstream list pages is a variation of this shape
 * (reports/11: 30/30 use DataTable, all default perPage=10, none set a default sort).
 */
import * as React from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import { RefreshCw, Search } from "lucide-react";
import { DataTable } from "./data-table";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { getSortingStateParser } from "@/lib/sorting";
import { setPageTitle } from "./page-title";
import type { Page } from "@/lib/rpc";

export type ListPageProps<T> = {
  title: string;
  description?: string;
  columns: ColumnDef<T, unknown>[];
  data: Page<T> | undefined;
  isLoading?: boolean;
  error?: unknown;
  mutate: () => Promise<unknown>;
  statusOptions?: { value: string; label: string }[];
  searchPlaceholder?: string;
  bulkActions?: (rows: T[], clear: () => void) => React.ReactNode;
  toolbarExtra?: React.ReactNode;
  /** Column filters (see useListFilters); rendered next to the search box. */
  filters?: React.ReactNode;
  mobileCard?: (row: T) => React.ReactNode;
  draggable?: boolean;
  onReorder?: (rows: T[], orderBy: number, index: number) => Promise<void> | void;
};

export function ListPage<T>({
  title,
  description,
  columns,
  data,
  isLoading,
  error,
  mutate,
  statusOptions,
  searchPlaceholder = t("app.search"),
  bulkActions,
  toolbarExtra,
  filters,
  mobileCard,
  draggable,
  onReorder,
}: ListPageProps<T>) {
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
  const [perPage] = useQueryState("perPage", parseAsInteger.withDefault(10));
  const [sort, setSort] = useQueryState("sort", getSortingStateParser());
  const [status, setStatus] = useQueryState("status", parseAsString);
  const [search, setSearch] = useQueryState("name", parseAsString);
  const [draft, setDraft] = React.useState(search ?? "");

  React.useEffect(() => setPageTitle(title), [title]);

  const rows = (data?.data ?? []) as unknown as T[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toolbarExtra}
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            <RefreshCw className="size-3.5" /> {t("app.refresh")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-2.5 left-2 size-3.5" />
          <Input
            className="h-8 w-56 pl-7"
            placeholder={searchPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void setSearch(draft || null);
                void setPage(1);
              }
            }}
          />
        </div>
        {filters}
        {statusOptions ? (
          <Select
            value={status ?? "all"}
            onValueChange={(v) => {
              void setStatus(v === "all" ? null : v);
              void setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-36">
              <SelectValue placeholder={t("app.allStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("app.allStatuses")}</SelectItem>
              {statusOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        total={data?.total ?? 0}
        page={page}
        perPage={perPage}
        onPageChange={(p) => void setPage(p)}
        sorting={(sort ?? []) as SortingState}
        onSortingChange={(s) => void setSort(s.length ? (s as never) : null)}
        isLoading={isLoading}
        error={error}
        mobileCard={mobileCard}
        draggable={draggable}
        onReorder={onReorder}
        actionBar={
          bulkActions
            ? (selected) => bulkActions(selected as unknown as T[], () => void mutate())
            : undefined
        }
      />
    </div>
  );
}
