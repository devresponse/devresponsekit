"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Grid row selection state with two distinct modes
 * (docs/admin-manager.md §7.1, §13 — "select all matching"):
 *
 *   - "page"       — explicit per-row selection on the current page.
 *                    The default mode the user starts in.
 *   - "all"        — the user clicked "Select all matching" in the
 *                    toolbar; the visible rows aren't enumerated, the
 *                    server is told to apply the action to ALL rows
 *                    matching the current filter set (capped at the
 *                    bulk endpoint's MAX_BULK_IDS).
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
 *     check `mode === "all"` first and forward the current filter set
 *     to the bulk endpoint via `ids: "*"`.
 *   - `clear` resets back to "page" mode with no ids selected; bulk
 *     handlers MUST call this on success so the UI doesn't keep a
 *     stale selection visible after the rows have changed.
 */
export type GridSelectionMode = "page" | "all";

export interface UseGridSelectionResult {
  selectedIds: Set<string>;
  mode: GridSelectionMode;
  /** True when at least one row is selected (page mode) OR mode === "all". */
  hasSelection: boolean;
  toggle(id: string): void;
  togglePage(ids: string[], select: boolean): void;
  selectAllMatching(): void;
  clear(): void;
}

export function useGridSelection(): UseGridSelectionResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<GridSelectionMode>("page");

  const toggle = useCallback((id: string) => {
    setMode("page");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePage = useCallback((ids: string[], select: boolean) => {
    setMode("page");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const selectAllMatching = useCallback(() => {
    setMode("all");
    setSelectedIds(new Set());
  }, []);

  const clear = useCallback(() => {
    setMode("page");
    setSelectedIds(new Set());
  }, []);

  const hasSelection = useMemo(() => mode === "all" || selectedIds.size > 0, [mode, selectedIds]);

  return { selectedIds, mode, hasSelection, toggle, togglePage, selectAllMatching, clear };
}
