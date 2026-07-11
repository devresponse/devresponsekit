"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Locale + template-type (key) filters for the server-rendered email
 * templates page.
 *
 * Both selects write to the URL query (`?key=…&locale=…`); the page reads
 * those params and narrows its database query. Keeping the source of truth
 * in the URL mirrors the URL-backed filter convention the Administrator
 * data grids use (docs/admin-manager.md §10), so the filter state survives
 * refresh / share / back-forward. Navigation uses `router.replace` (no
 * back-stack pollution) and `usePathname()` already carries the locale
 * prefix, exactly like `useGridState`.
 *
 * The option lists are derived from the templates that actually exist
 * (computed server-side and passed in), and each select always offers an
 * "All" sentinel that clears its param.
 */
const ALL_VALUE = "__all__";
const SELECT_CLASS = "border-input bg-background h-8 rounded-md border px-2 text-sm";

export function EmailTemplateFilters({
  keyOptions,
  localeOptions,
  activeKey,
  activeLocale,
}: {
  keyOptions: string[];
  localeOptions: string[];
  activeKey: string | null;
  activeLocale: string | null;
}) {
  const t = useTranslations("administrator.email.templates");
  const tg = useTranslations("administrator.grid");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParam = useCallback(
    (name: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null) params.delete(name);
      else params.set(name, value);
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`);
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("filters.key")}</span>
        <select
          aria-label={tg("filterBy", { label: t("filters.key") })}
          value={activeKey ?? ALL_VALUE}
          onChange={(e) => setParam("key", e.target.value === ALL_VALUE ? null : e.target.value)}
          className={SELECT_CLASS}
        >
          <option value={ALL_VALUE}>{tg("filterAll")}</option>
          {keyOptions.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("filters.locale")}</span>
        <select
          aria-label={tg("filterBy", { label: t("filters.locale") })}
          value={activeLocale ?? ALL_VALUE}
          onChange={(e) => setParam("locale", e.target.value === ALL_VALUE ? null : e.target.value)}
          className={SELECT_CLASS}
        >
          <option value={ALL_VALUE}>{tg("filterAll")}</option>
          {localeOptions.map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
