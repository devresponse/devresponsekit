"use client";

import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { getVisibleAdministratorNavigationGroups } from "./administrator-navigation";

/**
 * AdministratorSidebar
 *
 * Workspace navigation rendered inside the nested `ApplicationShell` for
 * the Administrator app (docs/admin-manager.md §2.3). Entries are gated
 * on the caller's permissions: items the caller cannot view are hidden
 * entirely so the rail isn't full of dead links.
 *
 * Permissions are passed in by the server layout — we never call any
 * permission API from the browser. The server is the source of truth;
 * this component only filters the *view*.
 */
export interface AdministratorSidebarProps {
  locale: string;
  permissions: ReadonlyArray<string>;
}

export function AdministratorSidebar({ locale, permissions }: AdministratorSidebarProps) {
  const t = useTranslations("administrator.nav");
  const visibleGroups = getVisibleAdministratorNavigationGroups(permissions).filter(
    (group) => group.items.length > 0,
  );

  return (
    <nav aria-label={t("overview")} className="flex flex-col gap-3 p-3 text-sm">
      {visibleGroups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <div className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
            {t(group.labelKey)}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.id}>
                <LocaleLink
                  href={item.href as "/"}
                  locale={locale}
                  className="hover:bg-shell-muted block rounded-md px-2 py-1.5"
                >
                  {t(item.labelKey)}
                </LocaleLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
