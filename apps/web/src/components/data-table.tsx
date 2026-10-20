"use client";
import { t } from "@/lib/i18n";
/**
 * DataTable — the single list abstraction behind 30 upstream pages
 * (work/all_modules/3-_n6u7twt0t-__493843.js, module 493843).
 *
 * Reproduced behaviour:
 *  - desktop table / mobile card list (useIsMobile)
 *  - pager with the Chinese copy: 第 X 页，共 Y 页 + 首/上/下/尾
 *  - empty state 「暂无数据」
 *  - row selection drives an action bar
 *  - drag reorder only while unsorted; submits (prev+next)/2 as order_by
 */
import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "@/lib/utils";

export function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [breakpoint]);
  return mobile;
}

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  total: number;
  page: number;
  perPage: number;
  onPageChange: (page: number) => void;
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
  isLoading?: boolean;
  error?: unknown;
  emptyState?: React.ReactNode;
  actionBar?: (rows: T[]) => React.ReactNode;
  onReorder?: (rows: T[], orderBy: number, index: number) => Promise<void> | void;
  draggable?: boolean;
  mobileCard?: (row: T) => React.ReactNode;
  getRowClassName?: (row: { original: T }) => string | undefined;
};

export function DataTable<T>({
  columns,
  data,
  total,
  page,
  perPage,
  onPageChange,
  sorting,
  onSortingChange,
  isLoading,
  error,
  emptyState,
  actionBar,
  onReorder,
  draggable,
  mobileCard,
  getRowClassName,
}: DataTableProps<T>) {
  const isMobile = useIsMobile();
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  const table: TanstackTable<T> = useReactTable({
    data,
    columns,
    state: { sorting: sorting ?? [], rowSelection },
    onRowSelectionChange: setRowSelection,
    onSortingChange: (updater) => {
      if (!onSortingChange) return;
      const next = typeof updater === "function" ? updater(sorting ?? []) : updater;
      onSortingChange(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  });

  const sortable = Boolean(draggable && onReorder && (sorting?.length ?? 0) === 0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original);
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  /** order_by midpoint insertion, mirroring the upstream algorithm exactly. */
  const move = async (row: T, delta: number) => {
    if (!onReorder || (sorting?.length ?? 0) > 0) return;
    const rows = [...data];
    const from = rows.indexOf(row);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= rows.length) return;
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    const prev = (rows[to - 1] as { order_by?: number } | undefined)?.order_by;
    const next = (rows[to + 1] as { order_by?: number } | undefined)?.order_by;
    const orderBy = prev === undefined ? (next ?? 0) + 1 : next === undefined ? prev - 1 : (prev + next) / 2;
    await onReorder(rows, orderBy, to);
  };

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-3", isMobile && selected.length > 0 && "pb-56")}>
      {error ? (
        <div className="text-destructive rounded-md border p-4 text-sm">{t("app.failedToLoadPleaseRetry")}</div>
      ) : isMobile && mobileCard ? (
        <div className="flex flex-col gap-2">
          {data.length === 0 ? (
            <div className="text-muted-foreground rounded-md border p-8 text-center text-sm">{t("misc.empty.noData")}</div>
          ) : (
            data.map((row, i) => <div key={i}>{mobileCard(row)}</div>)
          )}
        </div>
      ) : (
        <div className="max-md:[&_button:not([role=switch])]:min-h-11 max-md:[&_button:not([role=switch])]:min-w-11 overflow-hidden rounded-md border">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={sortable ? (e) => {
            const { active, over } = e as DragEndEvent;
            if (!over || active.id === over.id) return;
            const ids = table.getRowModel().rows.map((r) => r.id);
            const from = ids.indexOf(String(active.id));
            const to = ids.indexOf(String(over.id));
            if (from < 0 || to < 0) return;
            void move(table.getRowModel().rows[from].original, to - from);
          } : undefined}>
          <SortableContext items={table.getRowModel().rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="text-muted-foreground h-24 text-center">
                    {t("app.loading")}
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    {emptyState ?? t("misc.empty.noData")}
                  </TableCell>
                </TableRow>
              ) : sortable ? (
                <SortableRows table={table} getRowClassName={getRowClassName} />
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && "selected"}
                    className={getRowClassName?.({ original: row.original })}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          </SortableContext>
          </DndContext>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground flex items-center justify-center text-sm font-medium">
            {t("zh_f49534")} {page} {t("zh_11f2da")} {pageCount} {t("zh_af8438")}
          </div>
          <div className="flex items-center space-x-2">
            <Button
              aria-label={t("zh_80ae36")}
              variant="outline"
              size="icon"
              className="hidden size-8 lg:flex"
              onClick={() => onPageChange(1)}
              disabled={page <= 1}
            >
              <ChevronsLeft />
            </Button>
            <Button aria-label={t("zh_b41561")} variant="outline" size="icon" className="size-8" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
              <ChevronLeft />
            </Button>
            <Button
              aria-label={t("zh_67a246")}
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= pageCount}
            >
              <ChevronRight />
            </Button>
            <Button
              aria-label={t("zh_ae3194")}
              variant="outline"
              size="icon"
              className="hidden size-8 lg:flex"
              onClick={() => onPageChange(pageCount)}
              disabled={page >= pageCount}
            >
              <ChevronsRight />
            </Button>
          </div>
        </div>
        {actionBar && selected.length > 0 && (
          <div className="bg-background sticky bottom-0 flex items-center gap-2 rounded-md border p-2 shadow-sm">
            <span className="text-muted-foreground text-xs">{t("zh_17f328")} {selected.length} {t("zh_12de8e")}</span>
            {actionBar(selected)}
          </div>
        )}
        {onReorder && (sorting?.length ?? 0) === 0 && (
          <p className="text-muted-foreground text-xs">{t("order_by_aaa552")}</p>
        )}
      </div>
      <div className="hidden">{typeof move}</div>
    </div>
  );
}

function SortableRows<T>({
  table,
  getRowClassName,
}: {
  table: TanstackTable<T>;
  getRowClassName?: (row: { original: T }) => string | undefined;
}) {
  return (
    <>
      {table.getRowModel().rows.map((row) => (
        <SortableRow key={row.id} id={row.id} table={table} row={row} getRowClassName={getRowClassName} />
      ))}
    </>
  );
}

function SortableRow<T>({
  id,
  table,
  row,
  getRowClassName,
}: {
  id: string;
  table: TanstackTable<T>;
  row: ReturnType<TanstackTable<T>["getRowModel"]>["rows"][number];
  getRowClassName?: (row: { original: T }) => string | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-state={row.getIsSelected() && "selected"}
      className={cn(getRowClassName?.({ original: row.original }), isDragging && "opacity-60", "cursor-grab")}
      {...attributes}
      {...listeners}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
      ))}
    </TableRow>
  );
}
