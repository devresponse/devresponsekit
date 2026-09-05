"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-manager";
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
 *      via `/api/administrator/export/<resource>`. We GET the CSV with
 *      the grid's own query string (the export endpoint honours the same
 *      filters/sort), detect the server's `# export_truncated:` sentinel,
 *      and save it via a Blob download so we can warn when the export
 *      was capped (review #158).
 *
 * The toolbar is intentionally headless about selection state — it
 * receives a small `selection` object from the parent so it works with
 * the {@link useGridSelection} hook without coupling the two.
 */
export interface BulkActionDescriptor {
  /** Stable key — used as the React key. */
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
  /**
   * Optional caller-provided action buttons (e.g. "New user"). Rendered
   * in the same action cluster as Bulk actions / Export CSV so all
   * primary affordances share one row.
   */
  headerActions?: ReactNode;
  /**
   * Extra classes for the root. No caller passes one today; the grid
   * relies on the `contents` root so the toolbar's children flow inline
   * (left-aligned) in the single controls row (review #157).
   */
  className?: string;
}

export function DataGridToolbar(props: DataGridToolbarProps) {
  const t = useTranslations("administrator.grid");
  const dialogs = useDialogs();
  const { selection, bulkActions, exportResource, exportState, headerActions, className } = props;

  const onExport = async () => {
    if (!exportResource) return;
    const qs = exportState ? gridStateToSearchParams(exportState).toString() : "";
    const url = `/api/administrator/export/${encodeURIComponent(exportResource)}${
      qs ? `?${qs}` : ""
    }`;

    // Fetch the CSV (rather than a plain anchor click) so we can detect the
    // server's `# export_truncated:` sentinel and tell the admin the file is
    // incomplete. Trades streaming for a one-shot blob — bounded by the
    // server's hard row cap. The page state is never navigated away from.
    let res: Response;
    try {
      res = await fetch(url, { credentials: "same-origin", headers: { accept: "text/csv" } });
    } catch {
      await dialogs.notify({ description: t("error"), variant: "destructive" });
      return;
    }
    if (!res.ok) {
      await dialogs.notify({ description: t("error"), variant: "destructive" });
      return;
    }

    const text = await res.text();
    const truncated = text.includes("# export_truncated:");
    const csv = truncated
      ? text
          .split("\n")
          .filter((line) => !line.startsWith("# export_truncated:"))
          .join("\n")
      : text;

    // Preserve the server's Content-Disposition filename.
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename =
      /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? `administrator-${exportResource}.csv`;

    const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);

    if (truncated) {
      await dialogs.notify({ description: t("exportTruncated") });
    }
  };

  const hasSelection = selection.mode === "all" || selection.count > 0;
  const allOnPageSelected =
    selection.mode === "page" && selection.count > 0 && selection.count >= props.pageRowCount;
  const shouldOfferSelectAllMatching = allOnPageSelected && props.totalRows > props.pageRowCount;

  const summary =
    selection.mode === "all"
      ? t("selectionAllMatching", { total: props.totalRows })
      : selection.count > 0
        ? t("selectionCount", { count: selection.count })
        : "";

  // `display: contents` so the selection summary and every action button
  // become direct flex items of the grid's single controls row, flowing
  // inline (left-aligned) with the search + filter controls rather than
  // forming a separately-aligned cluster.
  return (
    <div data-testid="datagrid-toolbar" className={cn("contents text-sm", className)}>
      {summary ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2">
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
        </div>
      ) : null}

      <div className="contents">
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
          <Button type="button" size="sm" variant="outline" onClick={() => void onExport()}>
            {t("exportCsv")}
          </Button>
        ) : null}
        {headerActions}
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
