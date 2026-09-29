"use client";

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readGridStateFromParams, type GridState } from "./use-grid-state";

/**
 * Grid row selection state with two distinct modes
 * (docs/admin-manager.md §7.1, §13 — "select all matching"):
 *
 *   - "page"       — explicit per-row selection on the current page.
 *                    The default mode the user starts in.
 *   - "all"        — the user clicked "Select all matching" in the
 *                    toolbar; the visible rows aren't enumerated, the
 *                    server is told to apply the action to ALL rows
 *                    matching the current filter set (refused when more
 *                    than the bulk endpoint's MAX_BULK_IDS match).
 *
 * Why this hook exists separately from `useGridState`:
 *   - Selection is independent of URL state. Bookmarking should not
 *     re-select rows; selection is a transient interaction state.
 *   - Keeping selection in a separate hook means the foundation
 *     `useGridState` from Phase 2 stays unchanged — Phase 7 is purely
 *     additive.
 *
 * Threat / contract:
 *   - `selectedIds` is the explicit set; "all matching" callers should
 *     check `mode === "all"` first and forward `scope`, the search and
 *     filters the selection was made under, to the bulk endpoint via
 *     `ids: "*"`. Never re-read them from the URL at send time: a handler
 *     that awaits a confirmation still holds this render's selection when
 *     it resumes, while the URL may have moved on under the dialog.
 *   - The selection is cleared whenever the URL's search (`q`) or filters
 *     change (F-114). It used to outlive them: "select all matching" under
 *     `status=pending_approval`, then clearing the filter, left the mode at
 *     "all", so an unconfirmed Approve or Block sent `ids: "*"` with the NEW
 *     filters and reached every user the admin could see. The reset is
 *     state adjusted during render, not an effect, so no committed render
 *     pairs a selection with a filter set it was not made under. Sort and
 *     page do not change which rows match, so they keep it.
 *   - `clear` resets back to "page" mode with no ids selected; bulk
 *     handlers MUST call this on success so the UI doesn't keep a
 *     stale selection visible after the rows have changed.
 */
export type GridSelectionMode = "page" | "all";

/** The part of a grid URL that decides which rows match. */
export type GridSelectionScope = Pick<GridState, "q" | "filters">;

export interface UseGridSelectionResult {
  selectedIds: Set<string>;
  mode: GridSelectionMode;
  /**
   * In "all" mode, how many rows matched when "Select all matching" was
   * clicked (the grid's total then), so a confirmation can name the count.
   * `null` in "page" mode.
   */
  matchingTotal: number | null;
  /**
   * The search and filters this selection was made under. Any change to the
   * URL's clears the selection, so in "all" mode these are what a bulk
   * request sends with `ids: "*"` (F-114).
   */
  scope: GridSelectionScope;
  /** True when at least one row is selected (page mode) OR mode === "all". */
  hasSelection: boolean;
  toggle(id: string): void;
  togglePage(ids: string[], select: boolean): void;
  selectAllMatching(total: number): void;
  clear(): void;
}

/**
 * The part of a grid URL that decides which rows match: the free-text search
 * and the filters (F-114). Read with the grid's own parser, so it sees the
 * values the list request is built from.
 */
function selectionScope(params: URLSearchParams): GridSelectionScope {
  const { q, filters } = readGridStateFromParams(params);
  return { q, filters };
}

export function useGridSelection(): UseGridSelectionResult {
  const searchParamsKey = useSearchParams().toString();
  const scope = useMemo(
    () => selectionScope(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<GridSelectionMode>("page");
  const [matchingTotal, setMatchingTotal] = useState<number | null>(null);

  // F-114: React's pattern for resetting state when an input changes. The
  // render that sees a new scope is discarded and re-run with the cleared
  // selection before anything commits.
  const [selectedUnder, setSelectedUnder] = useState({ key: scopeKey, scope });
  if (selectedUnder.key !== scopeKey) {
    setSelectedUnder({ key: scopeKey, scope });
    setMode("page");
    setSelectedIds(new Set());
    setMatchingTotal(null);
  }

  const toggle = useCallback((id: string) => {
    setMode("page");
    setMatchingTotal(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePage = useCallback((ids: string[], select: boolean) => {
    setMode("page");
    setMatchingTotal(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const selectAllMatching = useCallback((total: number) => {
    setMode("all");
    setMatchingTotal(total);
    setSelectedIds(new Set());
  }, []);

  const clear = useCallback(() => {
    setMode("page");
    setMatchingTotal(null);
    setSelectedIds(new Set());
  }, []);

  const hasSelection = useMemo(() => mode === "all" || selectedIds.size > 0, [mode, selectedIds]);

  return {
    selectedIds,
    mode,
    matchingTotal,
    scope: selectedUnder.scope,
    hasSelection,
    toggle,
    togglePage,
    selectAllMatching,
    clear,
  };
}
