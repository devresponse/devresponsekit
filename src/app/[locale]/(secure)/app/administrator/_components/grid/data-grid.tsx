"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useGridFetch,
  useGridState,
  type UseGridStateOptions,
} from "./use-grid-state";

/**
 * DataGrid
 *
 * The shared client-side grid used by every Administrator list view
 * (docs/admin-manager.md §7). This is the **foundation** rendered in
 * Phase 2 — it implements the URL-state contract, server-side
 * pagination, the empty/loading/error states and the table render. The
 * filter toolbar, faceted filters, column visibility menu, density
 * toggle, row selection, bulk-actions and CSV export are layered on by
 * later phases without changing this component's signature.
 *
 * The grid is *manual* — TanStack Table renders headers + cells but the
 * server is the source of truth for sort, filter and pagination state.
 */
export interface DataGridProps<TItem> {
  /** Stable name used for local-storage / a11y (`administrator.users`, etc.). */
  name: string;
  /** API endpoint; receives URL state appended as query string. */
  endpoint: string;
  /** TanStack column definitions. `header` may be a translation key. */
  columns: ColumnDef<TItem, unknown>[];
  /** Hook options forwarded to {@link useGridState}. */
  options?: UseGridStateOptions;
  /** Optional initial server-rendered page (saves first round-trip). */
  initialData?: { items: TItem[]; total: number };
}

const EMPTY_OPTIONS: UseGridStateOptions = {};

export function DataGrid<TItem>(props: DataGridProps<TItem>) {
  const t = useTranslations("administrator.grid");
  const options = props.options ?? EMPTY_OPTIONS;
  const { state, setPage, setPageSize } = useGridState(options);
  const fetched = useGridFetch<TItem>(props.endpoint, state, options);

  const items = fetched.data ?? props.initialData?.items ?? [];
  const total = fetched.data ? fetched.total : (props.initialData?.total ?? 0);
  const isInitialLoading = fetched.isLoading && !props.initialData && fetched.data === null;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  const table = useReactTable({
    data: items,
    columns: props.columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: totalPages,
  });

  return (
    <div data-grid={props.name} className="flex flex-col gap-3">
      {fetched.error ? (
        <Empty role="alert">
          <EmptyTitle>{t("error")}</EmptyTitle>
          <EmptyDescription>
            <Button type="button" size="sm" variant="outline" onClick={fetched.reload}>
              {t("retry")}
            </Button>
          </EmptyDescription>
        </Empty>
      ) : isInitialLoading ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          <span className="sr-only">{t("loading")}</span>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyTitle>{t("empty")}</EmptyTitle>
        </Empty>
      ) : (
        <Table aria-rowcount={total}>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {!fetched.error && items.length > 0 ? (
        <DataGridPagination
          page={state.page}
          totalPages={totalPages}
          pageSize={state.pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      ) : null}
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
  onPageSizeChange(size: number): void;
}

function DataGridPagination(props: PaginationProps) {
  const t = useTranslations("administrator.grid");
  const PAGE_SIZES = [10, 25, 50, 100];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span aria-live="polite">
        {t("totalRows", { count: props.total })}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">
          <span>{t("rowsPerPage")}</span>
          <select
            value={props.pageSize}
            onChange={(e) => props.onPageSizeChange(Number(e.target.value))}
            className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(props.page - 1)}
        >
          {t("previousPage")}
        </Button>
        <span aria-live="polite">
          {t("pageOf", { page: props.page, totalPages: props.totalPages })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.page >= props.totalPages}
          onClick={() => props.onPageChange(props.page + 1)}
        >
          {t("nextPage")}
        </Button>
      </div>
    </div>
  );
}
