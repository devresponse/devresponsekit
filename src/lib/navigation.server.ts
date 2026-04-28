import "server-only";
import { db } from "@/db/database";
import type { UserAccessContext } from "@/lib/auth-status";
import type {
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
} from "@/components/navigation/menu-types";

/**
 * Pure menu filtering helper.
 *
 * Removes any item that requires a permission the caller does not have.
 * Kept pure so it can be unit-tested independently of the database.
 */
export function filterMenuByPermissions<TItem extends { requiredPermissions?: string[] }>(
  items: readonly TItem[],
  permissions: readonly string[],
): TItem[] {
  const granted = new Set(permissions);
  return items.filter((item) => {
    const required = item.requiredPermissions ?? [];
    return required.every((p) => granted.has(p));
  });
}

/**
 * Loads the application switcher menu (MENU #1).
 *
 * Returns SSO launch URLs only; never tokens. The launch URL points to
 * `/api/sso/launch`, which validates session/membership before signing
 * the short-lived JWT handoff.
 */
export async function loadApplicationsMenu(
  access: UserAccessContext,
  locale: string,
): Promise<NavigationMenuResponse<EnterpriseApplicationMenuItem>> {
  const rows = await db
    .selectFrom("app_enterprise_applications")
    .selectAll()
    .where("status", "in", ["available", "degraded"])
    .where((eb) =>
      eb.or([
        eb("organization_id", "is", null),
        access.organizationId
          ? eb("organization_id", "=", access.organizationId)
          : eb("organization_id", "is", null),
      ]),
    )
    .orderBy("sort_order", "asc")
    .execute();

  const items: EnterpriseApplicationMenuItem[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description ?? undefined,
    environment: "production",
    subdomain: row.subdomain,
    origin: row.origin,
    ssoLaunchUrl: `/api/sso/launch?applicationId=${encodeURIComponent(row.id)}&locale=${encodeURIComponent(locale)}`,
    status: row.status as EnterpriseApplicationMenuItem["status"],
  }));

  return {
    menuId: "applications",
    kind: "applications",
    locale,
    generatedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Loads a primary sidebar menu for a given application scope.
 *
 * The menu is built server-side from a static manifest filtered by the
 * caller's permissions. UI components MUST NOT import this manifest
 * directly — only the API route handler may call this function.
 */
export async function loadShellMenu(
  access: UserAccessContext,
  scope: string,
  locale: string,
): Promise<NavigationMenuResponse<NavigationMenuItem>> {
  const items: NavigationMenuItem[] = filterMenuByPermissions(
    DEFAULT_SHELL_MENU,
    access.permissions,
  ).map((item) => ({
    id: item.id,
    label: item.label,
    href: `/${locale}${item.href}`,
    icon: item.icon,
  }));

  return {
    menuId: `shell-menu:${scope}`,
    kind: "shell-menu",
    locale,
    generatedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Loads nested-application menu items (MENU #2).
 *
 * Currently returns the static set of secondary apps for the active
 * organization. Real implementations would join `app_enterprise_applications`
 * with role-based access; the contract here mirrors that envelope so the
 * UI can be implemented before the join is wired.
 */
export async function loadNestedAppsMenu(
  access: UserAccessContext,
  applicationId: string,
  locale: string,
): Promise<NavigationMenuResponse<NavigationMenuItem>> {
  const items: NavigationMenuItem[] = filterMenuByPermissions(
    DEFAULT_NESTED_MENU,
    access.permissions,
  ).map((item) => ({
    id: `${applicationId}:${item.id}`,
    label: item.label,
    href: `/${locale}${item.href}`,
    icon: item.icon,
  }));

  return {
    menuId: `nested-apps:${applicationId}`,
    kind: "nested-apps",
    locale,
    generatedAt: new Date().toISOString(),
    items,
  };
}

interface InternalMenuItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  requiredPermissions?: string[];
}

const DEFAULT_SHELL_MENU: InternalMenuItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/app/dashboard",
    requiredPermissions: ["shell.view"],
  },
  {
    id: "workspace",
    label: "Workspace",
    href: "/app/workspace",
    requiredPermissions: ["shell.view"],
  },
  {
    id: "admin-users",
    label: "Users",
    href: "/app/admin/users",
    requiredPermissions: ["admin.users.manage"],
  },
  {
    id: "admin-audit",
    label: "Audit",
    href: "/app/admin/audit",
    requiredPermissions: ["audit.view"],
  },
];

const DEFAULT_NESTED_MENU: InternalMenuItem[] = [
  {
    id: "settings",
    label: "Settings",
    href: "/app/workspace/settings",
    requiredPermissions: ["shell.view"],
  },
];
