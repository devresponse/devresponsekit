"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type HeaderContext,
} from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import { DataGridColumnHeader, type ColumnSortDirection } from "./data-grid-column-header";
import { DataGridFilterBar, type GridFilterDescriptor } from "./data-grid-filters";
import { DataGridToolbar, type BulkActionDescriptor } from "./data-grid-toolbar";
import type { UseGridSelectionResult } from "./use-grid-selection";
import {
  useGridFetch,
  useGridState,
  type GridState,
  type UseGridStateOptions,
} from "./use-grid-state";

/**
 * DataGrid
 *
 * The shared client-side grid used by every Administrator list view
 * (docs/admin-manager.md §7). Visual design matches the shadcn data
 * table reference: bordered card container, muted header row, hover
 * highlight and compact row heights for higher data density.
 *
 * Every column that exposes an `accessorKey` is sortable by default —
 * the header renders a `DataGridColumnHeader` button that drives the
 * URL-backed sort state. Opt out per-column with `enableSorting:
 * false` (used by row-action columns).
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
  /**
   * Optional action buttons rendered in the right-aligned cluster of
   * the toolbar, alongside Bulk actions / Export CSV. Use this for
   * page-level CTAs (e.g. "New user") that should share the same row.
   */
  headerActions?: ReactNode;
  /**
   * When true, render a debounced free-text search box that drives the
   * endpoint's `q` global-search parameter.
   */
  searchable?: boolean;
  /** Optional placeholder for the search box (e.g. "Search by email"). */
  searchPlaceholder?: string;
  /**
   * Optional per-field filter controls. Each `name` MUST be allow-listed
   * by the endpoint (`parseListQuery({ allowedFilters })`); the server
   * drops anything else, so the controls can only narrow — never widen —
   * what the caller may already see.
   */
  filters?: GridFilterDescriptor[];
}

const EMPTY_OPTIONS: UseGridStateOptions = {};

export function DataGrid<TItem>(props: DataGridProps<TItem>) {
  const t = useTranslations("administrator.grid");
  const options = props.options ?? EMPTY_OPTIONS;
  const { state, setPage, setPageSize, setSort, setSearch, setFilter } = useGridState(options);
  const fetched = useGridFetch<TItem>(props.endpoint, state, options);

  const initialItems = props.initialData?.items;
  const items = useMemo<TItem[]>(
    () => fetched.data ?? initialItems ?? [],
    [fetched.data, initialItems],
  );
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

  const onSortToggle = useCallback(
    (field: string, next: ColumnSortDirection) => {
      if (next === null) setSort([]);
      else setSort([{ field, direction: next }]);
    },
    [setSort],
  );

  const showToolbar =
    !!selection ||
    (props.bulkActions && props.bulkActions.length > 0) ||
    !!props.exportResource ||
    !!props.headerActions;

  const filters = props.filters;
  const showFilterBar = !!props.searchable || (filters && filters.length > 0);

  return (
    <div data-grid={props.name} className="flex flex-col gap-3">
      {/* All controls — search, filters, selection summary, and the action
          buttons — live in one flex row and flow left-to-right, wrapping
          naturally. The sub-components render with `display: contents` so
          their elements are direct flex items of this row, not separately
          aligned groups. */}
      {showFilterBar || showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {showFilterBar ? (
            <DataGridFilterBar
              searchable={props.searchable}
              searchPlaceholder={props.searchPlaceholder}
              q={state.q}
              onSearch={setSearch}
              filters={filters ?? []}
              filterValues={state.filters}
              onFilterChange={setFilter}
            />
          ) : null}

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
                  : {
                      mode: "page",
                      count: 0,
                      onSelectAllMatching: () => {},
                      onClear: () => {},
                    }
              }
              bulkActions={props.bulkActions}
              exportResource={props.exportResource}
              exportState={state}
              headerActions={props.headerActions}
            />
          ) : null}
        </div>
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
        <div
          role="status"
          aria-live="polite"
          className="border-border flex flex-col gap-2 rounded-md border p-3"
        >
          <span className="sr-only">{t("loading")}</span>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="border-border rounded-md border">
          <Empty>
            <EmptyTitle>{t("empty")}</EmptyTitle>
          </Empty>
        </div>
      ) : (
        <div className="border-border rounded-md border">
          <Table aria-rowcount={total}>
            <TableHeader className="bg-muted/50">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h) => (
                    <TableHead
                      key={h.id}
                      aria-sort={ariaSortFor(h.column.columnDef, state)}
                      className="h-9 px-3 text-xs"
                    >
                      {h.isPlaceholder
                        ? null
                        : renderSortableHeader(
                            h.column.columnDef,
                            h.getContext,
                            state,
                            onSortToggle,
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn("px-3 py-1.5 text-sm", cell.column.id === "__select" && "w-9")}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
 * `aria-sort` value for a column's `<th>` (the columnheader role owns
 * the attribute — putting it on the inner button is invalid per
 * jsx-a11y). `undefined` = column not sortable, attribute omitted.
 */
function ariaSortFor<TItem>(
  columnDef: ColumnDef<TItem, unknown>,
  state: GridState,
): "ascending" | "descending" | "none" | undefined {
  const accessorKey =
    "accessorKey" in columnDef && typeof columnDef.accessorKey === "string"
      ? columnDef.accessorKey
      : undefined;
  const id = columnDef.id ?? accessorKey;
  if (!id || id === "__select" || columnDef.enableSorting === false || !accessorKey) {
    return undefined;
  }
  const active = state.sort.find((s) => s.field === accessorKey);
  return active ? (active.direction === "asc" ? "ascending" : "descending") : "none";
}

/**
 * Wraps a column header in {@link DataGridColumnHeader} when the
 * column is sortable. Sortability is inferred from:
 *   1. Explicit `enableSorting: false` opts out.
 *   2. The presence of an `accessorKey` (used as the server-side
 *      sort field). Columns without an accessor (e.g. row actions,
 *      synthetic cells) are not sortable.
 * The selection column is always rendered raw.
 */
function renderSortableHeader<TItem>(
  columnDef: ColumnDef<TItem, unknown>,
  getContext: () => HeaderContext<TItem, unknown>,
  state: GridState,
  onToggle: (field: string, next: ColumnSortDirection) => void,
): ReactNode {
  const ctx = getContext();
  const raw = flexRender(columnDef.header, ctx);

  // `ColumnDef` is a union; only accessor-key columns are sortable.
  const accessorKey =
    "accessorKey" in columnDef && typeof columnDef.accessorKey === "string"
      ? columnDef.accessorKey
      : undefined;
  const id = columnDef.id ?? accessorKey;
  if (!id || id === "__select") return raw;
  if (columnDef.enableSorting === false) return raw;
  if (!accessorKey) return raw;

  const active = state.sort.find((s) => s.field === accessorKey);
  const direction: ColumnSortDirection = active ? active.direction : null;

  return (
    <DataGridColumnHeader
      field={accessorKey}
      direction={direction}
      onToggle={(next) => onToggle(accessorKey, next)}
    >
      {raw}
    </DataGridColumnHeader>
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
  const pageSomeSelected = !pageAllSelected && pageIds.some((id) => selection.selectedIds.has(id));

  return {
    id: "__select",
    enableSorting: false,
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
    <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-sm">
      <span aria-live="polite">{t("totalRows", { count: props.total })}</span>
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
