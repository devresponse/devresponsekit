"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { LocaleLink } from "@/components/i18n/locale-link";
import { SidebarMenuSkeleton } from "@/components/app-shell/navigation-menu-skeleton";
import { getMenuIcon } from "@/components/navigation/menu-icons";
import {
  FlexSidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/flexsidebar";
import { fetchShellMenu, NavigationApiError } from "@/components/navigation/navigation-api-client";
import type { NavigationMenuItem } from "@/components/navigation/menu-types";

/**
 * SecureSidebar
 *
 * Loads the primary sidebar menu from `/api/navigation/shell-menu` and
 * renders it inside a {@link FlexSidebar} (the container-bounded shadcn
 * variant), so the sidebar collapses to an icon rail via the
 * `SidebarTrigger` in the top bar / Ctrl+B without ever escaping the
 * shell grid's left region.
 *
 * The component does NOT import any menu manifest directly per §6 strict
 * rule — only the API result is rendered, which is filtered server-side
 * by role/permission. Icon names from the API resolve through the
 * `menu-icons` allow-list.
 *
 * `permissions` is only used to decide whether to bother fetching at all
 * (an unprivileged caller would receive an empty list anyway, but
 * skipping the fetch saves a round-trip).
 *
 * Requires an ancestor `SidebarProvider` (mounted by the secure layout).
 */
export function SecureSidebar({ locale, permissions }: { locale: string; permissions: string[] }) {
  const t = useTranslations("shell");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
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

  let body: React.ReactNode;
  if (items === null && errorStatus === null) {
    body = <SidebarMenuSkeleton />;
  } else if (errorStatus !== null) {
    body = (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-red-700">
          {errorStatus === 401 || errorStatus === 403 ? t("unauthorized") : t("menuLoadError")}
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
  } else {
    body = (
      <nav aria-label="Primary" className="p-2">
        <SidebarMenu>
          {(items ?? []).map((item) => {
            const Icon = getMenuIcon(item.icon);
            // Menu hrefs arrive locale-prefixed; LocaleLink re-applies
            // the prefix, and `usePathname` compares locale-less paths.
            const target = item.href.replace(`/${locale}`, "") || "/";
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild isActive={pathname === target} tooltip={item.label}>
                  <LocaleLink href={target as "/"} locale={locale}>
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span>{item.label}</span>
                  </LocaleLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </nav>
    );
  }

  return (
    // `.sh-left` already draws the region border; drop the sidebar's own.
    // `transition-none` keeps the panel width in lockstep with the grid
    // column, which flips instantly between its two fixed sizes (16rem /
    // 3rem) — see the .sh-grid:has(...) rule in app-shell.css.
    <FlexSidebar collapsible="icon" className="border-r-0 transition-none">
      <SidebarContent>{body}</SidebarContent>
    </FlexSidebar>
  );
}
