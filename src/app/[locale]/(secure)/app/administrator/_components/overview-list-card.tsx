import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LocaleLink } from "@/components/i18n/locale-link";

/**
 * OverviewListCard
 *
 * Presentational "recent activity" table for the Administrator
 * overview's second tier (docs/admin-manager.md §8.1). Pure display —
 * receives localized strings and pre-built cells; data access lives in
 * `src/lib/admin/overview.server.ts` and composition in the page.
 *
 * Server-compatible. The optional `viewAll` link points at the area
 * the list summarizes (locale-less app path).
 */
export interface OverviewListCardProps {
  /** Localized card title, e.g. "Latest registrations". */
  title: string;
  /** Localized column headers, in cell order. */
  headers: string[];
  /** One entry per row; `cells` align with `headers`. */
  rows: { key: string; cells: ReactNode[] }[];
  /** Localized empty-state line shown when there are no rows. */
  emptyLabel: string;
  /** Optional locale-less destination for the "view all" link. */
  viewAllHref?: `/${string}`;
  /** Localized label for the "view all" link. */
  viewAllLabel?: string;
  locale: string;
}

export function OverviewListCard({
  title,
  headers,
  rows,
  emptyLabel,
  viewAllHref,
  viewAllLabel,
  locale,
}: OverviewListCardProps) {
  return (
    <Card data-slot="overview-list-card" className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {viewAllHref && viewAllLabel ? (
          <LocaleLink
            href={viewAllHref as "/"}
            locale={locale}
            className="text-muted-foreground hover:text-foreground text-xs hover:underline"
          >
            {viewAllLabel}
          </LocaleLink>
        ) : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{emptyLabel}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {headers.map((header) => (
                  <TableHead key={header} className="h-8 px-2 text-xs">
                    {header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  {row.cells.map((cell, i) => (
                    <TableCell key={`${row.key}-${headers[i] ?? i}`} className="px-2 py-2 text-xs">
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
