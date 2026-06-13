import "server-only";
import { createTranslator, type Messages } from "next-intl";
import { db } from "@/db/database";
import type { UserAccessContext } from "@/lib/auth-status";
import { ANY_ADMIN_PERMISSION } from "@/lib/admin/permissions";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import type {
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
} from "@/components/navigation/menu-types";

/**
 * Builds a `shell`-namespace translator for menu labels. Uses
 * `createTranslator` with directly imported catalogs (rather than the
 * request-scoped `getTranslations`) so the loaders stay callable from
 * any server context, including tests. The loader map uses static
 * specifiers so every bundler/test resolver can see them.
 */
const MESSAGE_LOADERS: Record<string, () => Promise<{ default: Messages }>> = {
  en: () => import("@/messages/en.json"),
  fr: () => import("@/messages/fr.json"),
  es: () => import("@/messages/es.json"),
  uk: () => import("@/messages/uk.json"),
};

async function shellTranslator(locale: string) {
  const safeLocale = isSupportedLocale(locale) ? locale : defaultLocale;
  const loader = MESSAGE_LOADERS[safeLocale] ?? MESSAGE_LOADERS[defaultLocale]!;
  const messages = (await loader()).default;
  return createTranslator({ locale: safeLocale, messages, namespace: "shell" });
}

/**
 * Pure menu filtering helper.
 *
 * Removes any item that the caller cannot see based on the supplied
 * permission set. An item is kept when:
 *   - every key in `requiredPermissions` is granted (AND semantics), AND
 *   - if `anyOfPermissions` is non-empty, at least one of those keys is
 *     granted (OR semantics).
 *
 * The OR gate exists so menu entries can mirror the layout-level
 * `ANY_ADMIN_PERMISSION` guard without enumerating every admin.* key
 * in `requiredPermissions` (which would be AND'd and therefore wrong).
 *
 * Kept pure so it can be unit-tested independently of the database.
 */
export function filterMenuByPermissions<
  TItem extends { requiredPermissions?: string[]; anyOfPermissions?: string[] },
>(items: readonly TItem[], permissions: readonly string[]): TItem[] {
  const granted = new Set(permissions);
  return items.filter((item) => {
    const required = item.requiredPermissions ?? [];
    if (!required.every((p) => granted.has(p))) return false;
    const anyOf = item.anyOfPermissions ?? [];
    if (anyOf.length > 0 && !anyOf.some((p) => granted.has(p))) return false;
    return true;
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
  const t = await shellTranslator(locale);
  const items: NavigationMenuItem[] = filterMenuByPermissions(
    DEFAULT_SHELL_MENU,
    access.permissions,
  ).map((item) => ({
    id: item.id,
    label: t(item.labelKey),
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
  const t = await shellTranslator(locale);
  const items: NavigationMenuItem[] = filterMenuByPermissions(
    DEFAULT_NESTED_MENU,
    access.permissions,
  ).map((item) => ({
    id: `${applicationId}:${item.id}`,
    label: t(item.labelKey),
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
  /** `shell`-namespace message key resolved per request locale. */
  labelKey: "dashboard" | "workspace" | "account" | "admin" | "users" | "audit" | "settings";
  href: string;
  /**
   * Icon NAME (not a component) — resolved client-side through the
   * allow-list in `src/components/navigation/menu-icons.ts`. Keys used
   * here MUST exist in that map.
   */
  icon?: string;
  requiredPermissions?: string[];
  anyOfPermissions?: string[];
}

const DEFAULT_SHELL_MENU: InternalMenuItem[] = [
  {
    id: "dashboard",
    labelKey: "dashboard",
    href: "/app/dashboard",
    icon: "layout-dashboard",
    requiredPermissions: ["shell.view"],
  },
  {
    id: "workspace",
    labelKey: "workspace",
    href: "/app/workspace",
    icon: "briefcase",
    requiredPermissions: ["shell.view"],
  },
  {
    id: "account",
    labelKey: "account",
    href: "/app/account",
    icon: "circle-user",
    // User-level self-service; every active member can manage their own
    // account. No `admin.*` permission is involved.
    requiredPermissions: ["shell.view"],
  },
  {
    id: "administrator",
    labelKey: "admin",
    href: "/app/administrator",
    icon: "shield",
    // Mirrors the layout-level guard in
    // `src/app/[locale]/(secure)/app/administrator/layout.tsx`: any
    // single `admin.*` permission is enough to enter the workspace, so
    // the launcher entry surfaces for every administrator (including
    // the canonical `superuser` role) without enumerating each key.
    anyOfPermissions: [...ANY_ADMIN_PERMISSION],
  },
  {
    id: "admin-users",
    labelKey: "users",
    href: "/app/administrator/users",
    icon: "users",
    requiredPermissions: ["admin.users.manage"],
  },
  {
    id: "admin-audit",
    labelKey: "audit",
    href: "/app/administrator/audit",
    icon: "scroll-text",
    requiredPermissions: ["audit.view"],
  },
];

const DEFAULT_NESTED_MENU: InternalMenuItem[] = [
  {
    id: "settings",
    labelKey: "settings",
    href: "/app/workspace/settings",
    icon: "settings",
    requiredPermissions: ["shell.view"],
  },
];
