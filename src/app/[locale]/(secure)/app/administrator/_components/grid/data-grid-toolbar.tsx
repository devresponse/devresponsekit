"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gridStateToSearchParams, type GridState } from "./use-grid-state";
import type { GridSelectionMode } from "./use-grid-selection";

/**
 * Toolbar rendered above a `DataGrid` when bulk actions and / or CSV
 * export are enabled (docs/admin-manager.md §7.1, §19 Phase 7).
 *
 * Three responsibilities:
 *   1. Show a one-line summary of the current selection (per-page or
 *      "all matching"), with an explicit "Select all matching" affordance
 *      when only the current page is selected.
 *   2. Surface a permission-gated bulk-actions dropdown. Items are
 *      provided by the parent so each grid can configure its own
 *      action set; destructive actions are highlighted via the
 *      `destructive` flag.
 *   3. Expose an "Export CSV" button that downloads the current view
 *      via `/api/administrator/export/<resource>`. We POST nothing —
 *      the export endpoint reads filters from the same query string the
 *      grid is using, so we just hit the URL and let the browser save
 *      the file.
 *
 * The toolbar is intentionally headless about selection state — it
 * receives a small `selection` object from the parent so it works with
 * the {@link useGridSelection} hook without coupling the two.
 */
export interface BulkActionDescriptor {
  /** Stable key — used as the React key and forwarded to `onAction`. */
  key: string;
  /** Translated, user-facing label. */
  label: string;
  /** Highlight as destructive. */
  destructive?: boolean;
  /** Callback fired when the menu item is clicked. */
  onSelect: () => void;
}

export interface DataGridToolbarProps {
  /** Total visible row count from the grid (for the summary). */
  totalRows: number;
  /** Page row count (for the summary). */
  pageRowCount: number;
  selection: {
    mode: GridSelectionMode;
    count: number;
    onSelectAllMatching: () => void;
    onClear: () => void;
  };
  /** Bulk action menu items. Hide the menu entirely when empty. */
  bulkActions?: BulkActionDescriptor[];
  /** Resource slug for the CSV exporter (e.g. "users", "audit"). */
  exportResource?: string;
  /** Current grid URL state — used to forward filters/sort to /export. */
  exportState?: GridState;
}

export function DataGridToolbar(props: DataGridToolbarProps) {
  const t = useTranslations("administrator.grid");
  const { selection, bulkActions, exportResource, exportState } = props;

  const onExport = () => {
    if (!exportResource) return;
    const qs = exportState ? gridStateToSearchParams(exportState).toString() : "";
    const url = `/api/administrator/export/${encodeURIComponent(exportResource)}${qs ? `?${qs}` : ""
      }`;
    // Use a transient anchor click so the browser handles the
    // download (and the Content-Disposition filename) natively. We
    // do NOT navigate — the page state should not be discarded just
    // because the admin clicked Export.
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const hasSelection = selection.mode === "all" || selection.count > 0;
  const allOnPageSelected = selection.mode === "page" && selection.count > 0 && selection.count >= props.pageRowCount;
  const shouldOfferSelectAllMatching =
    allOnPageSelected && props.totalRows > props.pageRowCount;

  const summary =
    selection.mode === "all"
      ? t("selectionAllMatching", { total: props.totalRows })
      : selection.count > 0
        ? t("selectionCount", { count: selection.count })
        : "";

  return (
    <div
      data-testid="datagrid-toolbar"
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-2">
        {summary ? (
          <>
            <span aria-live="polite">{summary}</span>
            {shouldOfferSelectAllMatching ? (
              <Button
                type="button"
                size="sm"
                variant="link"
                className="h-auto px-1"
                onClick={selection.onSelectAllMatching}
              >
                {t("selectAllMatching", { total: props.totalRows })}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={selection.onClear}
            >
              {t("clearSelection")}
            </Button>
          </>
        ) : (
          <span aria-hidden>{/* keep grid spacing stable when empty */}&nbsp;</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {bulkActions && bulkActions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline" disabled={!hasSelection}>
                {t("bulkActions")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {bulkActions.map((a, idx) => (
                <ActionMenuItem
                  key={a.key}
                  action={a}
                  isLastBeforeDestructive={
                    !a.destructive && bulkActions[idx + 1]?.destructive === true
                  }
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {exportResource ? (
          <Button type="button" size="sm" variant="outline" onClick={onExport}>
            {t("exportCsv")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ActionMenuItem({
  action,
  isLastBeforeDestructive,
}: {
  action: BulkActionDescriptor;
  isLastBeforeDestructive: boolean;
}) {
  return (
    <>
      <DropdownMenuItem
        onSelect={action.onSelect}
        className={action.destructive ? "text-destructive focus:text-destructive" : ""}
      >
        {action.label}
      </DropdownMenuItem>
      {isLastBeforeDestructive ? <DropdownMenuSeparator /> : null}
    </>
  );
}
