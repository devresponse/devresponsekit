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
import type { DocCatalogEntry } from "@/lib/docs/source/types";

/**
 * DocsSidebar
 *
 * Catalog navigation for the documentation viewer, grouped by the
 * document's `group`. Follows the FlexSidebar pattern used by the
 * Account/Administrator sidebars (icons in the collapsed rail, labels as
 * tooltips, active item from the locale-less pathname). The tree is built
 * server-side in the layout and passed in as plain data; this component
 * only renders it.
 */
export interface DocsSidebarGroup {
  group: string;
  items: DocCatalogEntry[];
}

const DOC_ICON = "file-text";

export function DocsSidebar({ locale, groups }: { locale: string; groups: DocsSidebarGroup[] }) {
  const t = useTranslations("docs");
  const pathname = usePathname();
  const Icon = getMenuIcon(DOC_ICON);

  return (
    // `.sh-left` already draws the region border; drop the sidebar's own.
    <FlexSidebar collapsible="icon" className="border-r-0 transition-none">
      <SidebarContent>
        <nav aria-label={t("appTitle")}>
          {groups.map((group) => (
            <SidebarGroup key={group.group}>
              <SidebarGroupLabel>{group.group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const href = `/app/docs/${item.slug}`;
                    return (
                      <SidebarMenuItem key={item.slug}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === href}
                          tooltip={item.title}
                        >
                          <LocaleLink href={href as "/"} locale={locale}>
                            {Icon ? <Icon aria-hidden="true" /> : null}
                            <span>{item.title}</span>
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
