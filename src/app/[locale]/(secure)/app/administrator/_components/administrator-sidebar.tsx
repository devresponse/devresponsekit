"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { LocaleLink } from "@/components/i18n/locale-link";
import { getMenuIcon } from "@/components/navigation/menu-icons";
import {
  FlexSidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/flexsidebar";
import { getVisibleAdministratorNavigationGroups } from "./administrator-navigation";

/**
 * AdministratorSidebar
 *
 * Workspace navigation rendered inside the nested `ApplicationShell` for
 * the Administrator app (docs/admin-manager.md §2.3), following the same
 * FlexSidebar pattern as the root `SecureSidebar`: lucide icons stay
 * visible in the collapsed icon rail, labels show as tooltips while
 * collapsed, group labels auto-hide, and the active item is derived
 * from the locale-less pathname.
 *
 * Entries are gated on the caller's permissions: items the caller
 * cannot view are hidden entirely so the rail isn't full of dead links.
 * Permissions are passed in by the server layout — we never call any
 * permission API from the browser. The server is the source of truth;
 * this component only filters the *view*.
 *
 * Requires the ancestor `SidebarProvider` mounted by the administrator
 * layout (its own provider, separate cookie — independent of the root
 * shell's sidebar state).
 */
export interface AdministratorSidebarProps {
  locale: string;
  permissions: ReadonlyArray<string>;
}

export function AdministratorSidebar({ locale, permissions }: AdministratorSidebarProps) {
  const t = useTranslations("administrator.nav");
  const pathname = usePathname();
  const visibleGroups = getVisibleAdministratorNavigationGroups(permissions).filter(
    (group) => group.items.length > 0,
  );

  return (
    // `.sh-left` already draws the region border; drop the sidebar's own.
    // `transition-none` keeps the panel width in lockstep with the grid
    // column, which flips instantly between its two fixed sizes.
    <FlexSidebar collapsible="icon" className="border-r-0 transition-none">
      <SidebarContent>
        <nav aria-label={t("overview")}>
          {visibleGroups.map((group) => (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = getMenuIcon(item.icon);
                    const label = t(item.labelKey);
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === item.href}
                          tooltip={label}
                        >
                          <LocaleLink href={item.href as "/"} locale={locale}>
                            {Icon ? <Icon aria-hidden="true" /> : null}
                            <span>{label}</span>
                          </LocaleLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
    </FlexSidebar>
  );
}
