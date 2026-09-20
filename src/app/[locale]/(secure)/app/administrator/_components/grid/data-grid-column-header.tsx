"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Sortable column-header button used by every Administrator
 * `DataGrid` header cell (docs/admin-manager.md §7.2).
 *
 * The grid is server-driven (manual sort) so this component just
 * surfaces the sort affordance and dispatches the new direction —
 * the URL-state hook owns the rest.
 *
 * Cycle: unsorted → asc → desc → unsorted (matches the shadcn data
 * table reference). Each transition replaces the entire sort array
 * so column clicks behave as single-key sort by default; multi-key
 * sort is intentionally not exposed at the header (callers can still
 * push it through `setSort` programmatically).
 */
export type ColumnSortDirection = "asc" | "desc" | null;

export interface DataGridColumnHeaderProps {
  field: string;
  direction: ColumnSortDirection;
  onToggle: (next: ColumnSortDirection) => void;
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

export function DataGridColumnHeader({
  field: _field,
  direction,
  onToggle,
  children,
  align = "left",
  className,
}: DataGridColumnHeaderProps) {
  const t = useTranslations("administrator.grid");
  const stateId = useId();

  const next: ColumnSortDirection =
    direction === null ? "asc" : direction === "asc" ? "desc" : null;

  const stateLabel =
    direction === "asc" ? t("sortAsc") : direction === "desc" ? t("sortDesc") : t("sortNone");

  return (
    // A11Y-4 — the button carries NO `aria-label`.
    //
    // It used to, composed as `${typeof children === "string" ? children : ""} — ${state}`.
    // But `DataGrid` hands this component `flexRender(columnDef.header, ctx)`, and
    // flexRender wraps a function header in `React.createElement`, so for every one of
    // the ~100 admin columns (all of which declare `header: () => t("…")`) `children`
    // was an ELEMENT, never a string. The ternary therefore always took the empty
    // branch and every sort button on every Administrator grid announced itself as
    // "— Not sorted": aria-label overrides name-from-content, so the column name was
    // gone from the accessible name entirely and N identical unnamed buttons were left
    // on each list. axe never flagged it — the name was non-empty, just useless.
    //
    // The fix is structural rather than another string: the accessible name is now
    // computed FROM THE VISIBLE LABEL (name-from-content), so it cannot silently
    // diverge from what is on screen no matter what shape a future column's `header`
    // takes — string, element, or icon-plus-text. That also satisfies WCAG 2.5.3
    // (Label in Name) by construction and keeps voice control able to target the
    // control by the name a user can actually see.
    //
    // Sort state rides a SEPARATE channel, twice over:
    //   1. `aria-sort` on the wrapping <th> (set by DataGrid) — the ARIA-designated
    //      mechanism, and the only one valid here since the attribute is not allowed
    //      on role=button.
    //   2. this `aria-describedby` span, as the redundancy for AT that under-reports
    //      `aria-sort` when focus sits on the button in forms/focus mode.
    // The span is `aria-hidden` so it stays OUT of name-from-content — otherwise it
    // would re-pollute both this button's name and the <th>'s name (which screen
    // readers prefix onto every data cell in the column). The accessible-name
    // algorithm still uses a hidden node for the DESCRIPTION when it is referenced
    // directly by `aria-describedby` (its step 2A exempts exactly that case), which
    // is the split we want: name = "Email", description = "Sorted ascending".
    // Verified against Chrome's own computed tree, not just jsdom.
    <button
      type="button"
      onClick={() => onToggle(next)}
      aria-describedby={stateId}
      className={cn(
        "hover:bg-muted/60 focus-visible:ring-ring -mx-2 -my-1 flex h-7 items-center gap-1.5 rounded px-2 text-left text-xs font-medium focus-visible:ring-1 focus-visible:outline-none",
        align === "right" && "justify-end",
        align === "center" && "justify-center",
        className,
      )}
    >
      <span>{children}</span>
      <span id={stateId} className="sr-only" aria-hidden>
        {stateLabel}
      </span>
      {direction === "asc" ? (
        <ArrowUp className="size-3.5" aria-hidden />
      ) : direction === "desc" ? (
        <ArrowDown className="size-3.5" aria-hidden />
      ) : (
        <ArrowUpDown className="text-muted-foreground/50 size-3.5" aria-hidden />
      )}
    </button>
  );
}
