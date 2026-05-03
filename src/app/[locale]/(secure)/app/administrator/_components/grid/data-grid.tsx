"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DataGridToolbar,
  type BulkActionDescriptor,
} from "./data-grid-toolbar";
import type { UseGridSelectionResult } from "./use-grid-selection";
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
 * Phase 7 adds optional row selection (per-page and "select all
 * matching"), a bulk-actions menu, and CSV export — all gated behind
 * the `selection` / `bulkActions` / `exportResource` props so the
 * grid stays drop-in compatible for callers that don't opt in.
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
  /**
   * Optional row selection. When provided, a leading checkbox column
   * is injected and the toolbar shows the selection summary. Callers
   * use {@link useGridSelection} to own the state.
   */
  selection?: {
    state: UseGridSelectionResult;
    /** Pulls a stable id out of the row for selection bookkeeping. */
    getRowId: (item: TItem) => string;
  };
  /**
   * Optional bulk-action menu items. Each handler is responsible for
   * issuing the API call and refreshing the grid. Hidden when empty.
   */
  bulkActions?: BulkActionDescriptor[];
  /**
   * Resource slug for the CSV exporter; when set, an "Export CSV"
   * button is rendered in the toolbar that downloads the current view.
   */
  exportResource?: string;
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

  const selection = props.selection;
  const selectionColumn = useMemo<ColumnDef<TItem, unknown> | null>(() => {
    if (!selection) return null;
    return buildSelectionColumn<TItem>(selection.state, selection.getRowId, items, t);
  }, [selection, items, t]);

  const tableColumns = useMemo<ColumnDef<TItem, unknown>[]>(
    () => (selectionColumn ? [selectionColumn, ...props.columns] : props.columns),
    [selectionColumn, props.columns],
  );

  const table = useReactTable({
    data: items,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: totalPages,
  });

  const showToolbar =
    !!selection || (props.bulkActions && props.bulkActions.length > 0) || !!props.exportResource;

  return (
    <div data-grid={props.name} className="flex flex-col gap-3">
      {showToolbar ? (
        <DataGridToolbar
          totalRows={total}
          pageRowCount={items.length}
          selection={
            selection
              ? {
                  mode: selection.state.mode,
                  count: selection.state.selectedIds.size,
                  onSelectAllMatching: selection.state.selectAllMatching,
                  onClear: selection.state.clear,
                }
              : { mode: "page", count: 0, onSelectAllMatching: () => {}, onClear: () => {} }
          }
          bulkActions={props.bulkActions}
          exportResource={props.exportResource}
          exportState={state}
        />
      ) : null}

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

/**
 * Builds the leading checkbox column injected when `selection` is
 * enabled. The header checkbox toggles "all on this page"; per-row
 * checkboxes toggle individual rows. Both reset the selection mode
 * back to "page" so explicit toggles never accidentally extend the
 * "select all matching" intent.
 */
function buildSelectionColumn<TItem>(
  selection: UseGridSelectionResult,
  getRowId: (item: TItem) => string,
  items: TItem[],
  t: ReturnType<typeof useTranslations>,
): ColumnDef<TItem, unknown> {
  const pageIds = items.map(getRowId);
  const pageAllSelected =
    selection.mode === "all" ||
    (pageIds.length > 0 && pageIds.every((id) => selection.selectedIds.has(id)));
  const pageSomeSelected =
    !pageAllSelected && pageIds.some((id) => selection.selectedIds.has(id));

  return {
    id: "__select",
    header: () => (
      <Checkbox
        aria-label={t("selectPage")}
        checked={pageAllSelected ? true : pageSomeSelected ? "indeterminate" : false}
        onCheckedChange={(v) => selection.togglePage(pageIds, v === true)}
      />
    ),
    cell: ({ row }) => {
      const id = getRowId(row.original);
      const checked = selection.mode === "all" || selection.selectedIds.has(id);
      return (
        <Checkbox
          aria-label={t("selectRow")}
          checked={checked}
          onCheckedChange={() => selection.toggle(id)}
        />
      );
    },
  };
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
