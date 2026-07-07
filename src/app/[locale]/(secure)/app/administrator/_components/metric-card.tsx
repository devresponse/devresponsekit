import { createElement } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocaleLink } from "@/components/i18n/locale-link";
import { getMenuIcon } from "@/components/navigation/menu-icons";

/**
 * MetricCard
 *
 * Presentational KPI card for the Administrator overview
 * (docs/admin-manager.md §8.0). Pure display — receives an already
 * formatted-ready value and localized strings; data access lives in
 * `src/lib/admin/overview.server.ts`.
 *
 * Server-compatible. When `href` is given the whole card links to the
 * area it summarizes (locale-less app path; `LocaleLink` re-applies
 * the prefix) with the shared accent hover treatment.
 */
export interface MetricCardProps {
  /** Localized metric label, e.g. "Users". */
  label: string;
  /** The headline number. Formatted with the active locale. */
  value: number;
  /** Optional localized secondary line, e.g. "12 active · 3 pending". */
  hint?: string;
  /** Icon NAME from the menu-icons allow-list (decorative). */
  icon?: string;
  /** Locale-less destination, e.g. "/app/administrator/users". */
  href?: `/${string}`;
  locale: string;
}

export function MetricCard({ label, value, hint, icon, href, locale }: MetricCardProps) {
  // The icon component comes from the stable menu-icons allow-list;
  // createElement keeps the react-hooks analyzer from misreading the
  // lookup as a component definition during render.
  const iconComponent = getMenuIcon(icon);
  const iconElement = iconComponent
    ? createElement(iconComponent, {
        "aria-hidden": "true",
        className: "text-muted-foreground size-4 shrink-0",
      })
    : null;

  const card = (
    <Card
      data-slot="metric-card"
      className={
        href ? "hover:border-ring/60 hover:bg-accent/40 h-full transition-colors" : "h-full"
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        {iconElement}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">
          {new Intl.NumberFormat(locale).format(value)}
        </div>
        {hint ? <p className="text-muted-foreground mt-1 text-xs">{hint}</p> : null}
      </CardContent>
    </Card>
  );

  if (!href) return card;

  return (
    <LocaleLink
      href={href as "/"}
      locale={locale}
      aria-label={label}
      className="focus-visible:ring-ring block rounded-lg focus-visible:ring-2 focus-visible:outline-none"
    >
      {card}
    </LocaleLink>
  );
}
