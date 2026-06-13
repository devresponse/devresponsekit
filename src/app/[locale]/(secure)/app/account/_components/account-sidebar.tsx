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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/flexsidebar";
import { getVisibleAccountSections } from "../_sections";

/**
 * AccountSidebar
 *
 * Section navigation for the self-service Account app, rendered inside
 * the nested `ApplicationShell`. Follows the same FlexSidebar pattern as
 * `AdministratorSidebar` (icons in the collapsed rail, labels as
 * tooltips, active item from the locale-less pathname) but is built from
 * the {@link ACCOUNT_SECTIONS} registry — adding a section here is
 * automatic once its descriptor exists.
 *
 * `permissions` only filters the VIEW; the server is the source of
 * truth. Sections require the baseline `shell.view` (user-level).
 */
export function AccountSidebar({
  locale,
  permissions,
}: {
  locale: string;
  permissions: ReadonlyArray<string>;
}) {
  const t = useTranslations("account");
  const pathname = usePathname();
  const sections = getVisibleAccountSections(permissions);

  return (
    // `.sh-left` already draws the region border; drop the sidebar's own.
    // `transition-none` keeps the panel width in lockstep with the grid
    // column, which flips instantly between its two fixed sizes.
    <FlexSidebar collapsible="icon" className="border-r-0 transition-none">
      <SidebarContent>
        <nav aria-label={t("appTitle")}>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {sections.map((section) => {
                  const Icon = getMenuIcon(section.icon);
                  const label = t(section.labelKey);
                  return (
                    <SidebarMenuItem key={section.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={pathname === section.href}
                        tooltip={label}
                      >
                        <LocaleLink href={section.href as "/"} locale={locale}>
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
        </nav>
      </SidebarContent>
    </FlexSidebar>
  );
}
