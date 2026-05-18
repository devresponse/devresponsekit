"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Sortable column-header button used by every Administrator
 * `DataGrid` header cell (docs/admin-manager.md §7).
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

    const next: ColumnSortDirection =
        direction === null ? "asc" : direction === "asc" ? "desc" : null;

    const ariaSort =
        direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none";
    const stateLabel =
        direction === "asc" ? t("sortAsc") : direction === "desc" ? t("sortDesc") : t("sortNone");

    return (
        <button
            type="button"
            onClick={() => onToggle(next)}
            aria-sort={ariaSort}
            aria-label={`${typeof children === "string" ? children : ""} — ${stateLabel}`.trim()}
            className={cn(
                "hover:bg-muted/60 focus-visible:ring-ring -mx-2 -my-1 flex h-7 items-center gap-1.5 rounded px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1",
                align === "right" && "justify-end",
                align === "center" && "justify-center",
                className,
            )}
        >
            <span>{children}</span>
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
