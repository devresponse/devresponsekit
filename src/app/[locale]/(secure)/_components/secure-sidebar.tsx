"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";import { LocaleLink } from "@/components/i18n/locale-link";
import { SidebarMenuSkeleton } from "@/components/app-shell/navigation-menu-skeleton";
import { fetchShellMenu, NavigationApiError } from "@/components/navigation/navigation-api-client";
import type { NavigationMenuItem } from "@/components/navigation/menu-types";

/**
 * SecureSidebar
 *
 * Loads the primary sidebar menu from `/api/navigation/shell-menu`.
 * The component does NOT import any menu manifest directly per §6 strict
 * rule — only the API result is rendered, which is filtered server-side
 * by role/permission.
 *
 * `permissions` is only used to decide whether to bother fetching at all
 * (an unprivileged caller would receive an empty list anyway, but
 * skipping the fetch saves a round-trip).
 */
export function SecureSidebar({ locale, permissions }: { locale: string; permissions: string[] }) {
  const t = useTranslations("shell");
  const tCommon = useTranslations("common");
  const [items, setItems] = useState<NavigationMenuItem[] | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (permissions.length === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setErrorStatus(null);

    fetchShellMenu("primary-sidebar", locale)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorStatus(error instanceof NavigationApiError ? error.status : 500);
      });

    return () => {
      cancelled = true;
    };
  }, [locale, permissions, reloadKey]);

  if (items === null && errorStatus === null) {
    return <SidebarMenuSkeleton />;
  }

  if (errorStatus !== null) {
    return (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-red-700">
          {errorStatus === 401 || errorStatus === 403
            ? t("unauthorized")
            : t("menuLoadError")}
        </p>
        <button
          type="button"
          className="border-shell-border hover:bg-shell-muted rounded-md border px-2 py-1 text-xs"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          {tCommon("retry")}
        </button>
      </div>
    );
  }

  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 p-2 text-sm">
      {(items ?? []).map((item) => (
        <LocaleLink
          key={item.id}
          href={item.href.replace(`/${locale}`, "") as "/"}
          locale={locale}
          className="hover:bg-shell-muted rounded-md px-2 py-1.5"
        >
          {item.label}
        </LocaleLink>
      ))}
    </nav>
  );
}
