"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Search + filter controls rendered above a {@link DataGrid}.
 *
 * Both the free-text search (`q`) and the per-field filters write to the
 * same URL-backed grid state the grid already reads (docs/admin-manager.md
 * §10) — so they compose with sort, pagination, "select all matching", and
 * CSV export for free, and survive refresh / share / back-forward nav.
 *
 * Security: filter `name`s here MUST match a key the server endpoint
 * allow-lists (`parseListQuery({ allowedFilters })`). The server silently
 * drops anything else and re-derives the caller's org scope per request
 * (ADR-0001), so the controls only ever narrow results the caller is
 * already entitled to see — they never widen authority.
 *
 * The filter control is a native `<select>` (matching the pagination
 * page-size control) rather than a Radix popover: it is keyboard- and
 * screen-reader-native, needs no portal, and is trivially testable.
 */
export interface GridFilterOption {
  value: string;
  label: string;
}

export interface GridFilterDescriptor {
  /** Server filter key — MUST be in the endpoint's `allowedFilters`. */
  name: string;
  /** Accessible field label (e.g. "Status"). */
  label: string;
  /** Selectable values. An "All" sentinel that clears is added for you. */
  options: GridFilterOption[];
}

/** Loosely-typed translator so callers can pass a next-intl `t` directly. */
type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Maps raw enum values to `{ value, label }`, translating each label via
 * the shared `administrator.grid.optionLabels` catalog. Use from a grid
 * that already holds a `useTranslations("administrator.grid")` instance.
 */
export function toFilterOptions(tg: Translator, values: readonly string[]): GridFilterOption[] {
  return values.map((value) => ({ value, label: tg(`optionLabels.${value}`) }));
}

export interface DataGridFilterBarProps {
  /** When true, render a debounced free-text search bound to `q`. */
  searchable?: boolean;
  /** Placeholder for the search box; defaults to a generic "Search…". */
  searchPlaceholder?: string;
  /** Current search term (from grid state). */
  q: string;
  /** Commit a new search term (debounced by this component). */
  onSearch: (q: string) => void;
  /** Filter descriptors; each renders a labelled `<select>`. */
  filters: GridFilterDescriptor[];
  /** Current filter values (from grid state). */
  filterValues: Record<string, string | string[]>;
  /** Commit a filter change; `null` clears the filter. */
  onFilterChange: (name: string, value: string | null) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
/** Sentinel for the "no filter" option — `<option>` cannot have an empty real value here. */
const ALL_VALUE = "__all__";

export function DataGridFilterBar(props: DataGridFilterBarProps) {
  const t = useTranslations("administrator.grid");
  const { searchable, q, onSearch, filters, filterValues, onFilterChange } = props;

  // Bumped on "Clear filters" to remount the search box back to empty. The
  // input owns its own draft state (below), so this is how the parent
  // resets it without reaching across the component boundary.
  const [resetNonce, setResetNonce] = useState(0);

  const activeFilterCount = useMemo(
    () =>
      filters.reduce((n, f) => {
        const v = filterValues[f.name];
        return n + (typeof v === "string" && v.length > 0 ? 1 : Array.isArray(v) ? 1 : 0);
      }, 0),
    [filters, filterValues],
  );
  const hasActive = activeFilterCount > 0 || q.length > 0;

  if (!searchable && filters.length === 0) return null;

  const onClear = () => {
    onSearch("");
    for (const f of filters) onFilterChange(f.name, null);
    setResetNonce((n) => n + 1);
  };

  // `display: contents` so the search box, filter selects, and clear button
  // become direct flex items of the grid's single controls row — they flow
  // inline with the action buttons instead of forming a separately-aligned
  // group. Spacing comes from that shared row's `gap`.
  return (
    <div data-testid="datagrid-filterbar" role="search" className="contents">
      {searchable ? (
        <GridSearchInput
          key={resetNonce}
          initialValue={q}
          ariaLabel={t("search")}
          placeholder={props.searchPlaceholder ?? t("searchPlaceholder")}
          onSearch={onSearch}
        />
      ) : null}

      {filters.map((f) => {
        const current = filterValues[f.name];
        const value = typeof current === "string" && current.length > 0 ? current : ALL_VALUE;
        return (
          <label key={f.name} className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">{f.label}</span>
            <select
              aria-label={t("filterBy", { label: f.label })}
              value={value}
              onChange={(e) =>
                onFilterChange(f.name, e.target.value === ALL_VALUE ? null : e.target.value)
              }
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value={ALL_VALUE}>{t("filterAll")}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}

      {hasActive ? (
        <Button type="button" size="sm" variant="ghost" className="h-8 px-2" onClick={onClear}>
          {t("clearFilters")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Debounced search box. Keeps a local `draft` so typing is instant, and
 * commits to the URL-backed `q` on a trailing debounce so we don't issue a
 * request per keystroke. The pending timer lives in a ref touched only from
 * the change handler and the unmount cleanup — never during render. The
 * parent remounts this (via `key`) to reset it on "Clear filters".
 */
function GridSearchInput({
  initialValue,
  ariaLabel,
  placeholder,
  onSearch,
}: {
  initialValue: string;
  ariaLabel: string;
  placeholder: string;
  onSearch: (q: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Input
      type="search"
      inputMode="search"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        const value = e.target.value;
        setDraft(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onSearch(value), SEARCH_DEBOUNCE_MS);
      }}
      className="h-8 w-64 max-w-full"
    />
  );
}
