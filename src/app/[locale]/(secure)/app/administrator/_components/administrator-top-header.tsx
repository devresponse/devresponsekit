"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  type AdministratorNavigationAction,
  type AdministratorNavigationActionId,
  getVisibleAdministratorNavigationGroups,
} from "./administrator-navigation";

export interface AdministratorTopHeaderProps {
  locale: string;
  permissions: ReadonlyArray<string>;
}

/**
 * AdministratorTopHeader
 *
 * Desktop-style application menubar for the Administrator workspace.
 * It uses the same permission-filtered navigation model as the left
 * rail, but exposes quick-create actions directly from each menu.
 */
export function AdministratorTopHeader({ locale, permissions }: AdministratorTopHeaderProps) {
  const router = useRouter();
  const tAdmin = useTranslations("administrator");
  const tNav = useTranslations("administrator.nav");
  const tUsers = useTranslations("administrator.users");
  const tRoles = useTranslations("administrator.roles");
  const tOrganizations = useTranslations("administrator.orgs");
  const tEnterpriseApps = useTranslations("administrator.enterpriseApps");

  const actionLabels: Record<AdministratorNavigationActionId, string> = {
    "new-enterprise-app": tEnterpriseApps("newButton"),
    "new-organization": tOrganizations("newButton"),
    "new-role": tRoles("newButton"),
    "new-user": tUsers("newButton"),
  };
  const visibleGroups = getVisibleAdministratorNavigationGroups(permissions);
  const navigateTo = (href: `/${string}`) => router.push(href, { locale });
  const getActionLabel = (action: AdministratorNavigationAction) => actionLabels[action.id];

  return (
    <div className="bg-background sticky top-0 z-30 overflow-x-auto">
      <div className="flex h-9 min-w-max items-stretch">
        <div className="text-muted-foreground flex shrink-0 items-center border-r px-3 text-[11px] font-semibold tracking-[0.16em] uppercase">
          {tAdmin("appTitle")}
        </div>
        <Menubar
          aria-label={tAdmin("appTitle")}
          className="h-full min-w-max flex-1 justify-start space-x-0 rounded-none border-0 p-0 shadow-none"
        >
          {visibleGroups.map((group) => (
            <MenubarMenu key={group.id}>
              <MenubarTrigger className="text-foreground/80 focus:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground data-[state=open]:border-border h-full rounded-none border-r border-transparent px-3 py-0 text-[12px] font-medium">
                {tNav(group.labelKey)}
              </MenubarTrigger>
              <MenubarContent
                alignOffset={0}
                sideOffset={0}
                className="border-border bg-background min-w-60 rounded-t-none rounded-b-lg border p-0 shadow-lg"
              >
                {group.items.map((item) => (
                  <MenubarItem
                    key={item.id}
                    className="rounded-none px-3 py-2"
                    onSelect={() => navigateTo(item.href)}
                  >
                    {tNav(item.labelKey)}
                  </MenubarItem>
                ))}
                {group.items.length > 0 && group.actions.length > 0 ? (
                  <MenubarSeparator className="mx-0" />
                ) : null}
                {group.actions.map((action) => (
                  <MenubarItem
                    key={action.id}
                    className="rounded-none px-3 py-2 font-medium"
                    onSelect={() => navigateTo(action.href)}
                  >
                    {getActionLabel(action)}
                  </MenubarItem>
                ))}
              </MenubarContent>
            </MenubarMenu>
          ))}
        </Menubar>
      </div>
    </div>
  );
}
