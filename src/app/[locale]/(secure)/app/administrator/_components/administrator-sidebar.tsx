"use client";

import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";

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

interface NavItem {
  id: string;
  href: `/${string}`;
  labelKey: string;
  /** Caller must have at least one of these to see the item. */
  requires: ReadonlyArray<string>;
}

interface NavGroup {
  id: string;
  labelKey: string;
  items: NavItem[];
}

const GROUPS: ReadonlyArray<NavGroup> = [
  {
    id: "overview",
    labelKey: "overview",
    items: [
      {
        id: "overview-home",
        href: "/app/administrator",
        labelKey: "overview",
        // Visible to anyone with any admin.* permission — gated by
        // the layout itself.
        requires: [],
      },
    ],
  },
  {
    id: "identity",
    labelKey: "identity",
    items: [
      {
        id: "users",
        href: "/app/administrator/users",
        labelKey: "users",
        requires: ["admin.users.read"],
      },
    ],
  },
  {
    id: "access",
    labelKey: "access",
    items: [
      {
        id: "roles",
        href: "/app/administrator/roles",
        labelKey: "roles",
        requires: ["admin.roles.read"],
      },
      {
        id: "permissions",
        href: "/app/administrator/permissions",
        labelKey: "permissions",
        requires: ["admin.roles.read"],
      },
    ],
  },
  {
    id: "tenancy",
    labelKey: "tenancy",
    items: [
      {
        id: "organizations",
        href: "/app/administrator/organizations",
        labelKey: "organizations",
        requires: ["admin.orgs.read"],
      },
      {
        id: "memberships",
        href: "/app/administrator/memberships",
        labelKey: "memberships",
        requires: ["admin.orgs.read"],
      },
    ],
  },
  {
    id: "apps",
    labelKey: "apps",
    items: [
      {
        id: "enterprise-apps",
        href: "/app/administrator/enterprise-apps",
        labelKey: "enterpriseApps",
        requires: ["admin.apps.read"],
      },
    ],
  },
  {
    id: "activity",
    labelKey: "activity",
    items: [
      {
        id: "audit",
        href: "/app/administrator/audit",
        labelKey: "auditLog",
        requires: ["admin.audit.read"],
      },
    ],
  },
];

export function AdministratorSidebar({ locale, permissions }: AdministratorSidebarProps) {
  const t = useTranslations("administrator.nav");
  const has = (item: NavItem) =>
    item.requires.length === 0 || item.requires.some((p) => permissions.includes(p));

  const visibleGroups = GROUPS.map((g) => ({ ...g, items: g.items.filter(has) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <nav aria-label={t("overview")} className="flex flex-col gap-3 p-3 text-sm">
      {visibleGroups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <div className="text-muted-foreground px-2 py-1 text-xs font-semibold uppercase tracking-wide">
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
