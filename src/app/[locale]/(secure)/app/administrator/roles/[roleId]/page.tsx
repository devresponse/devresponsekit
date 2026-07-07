import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { AdminError, loadRoleOrThrow } from "@/lib/admin/roles.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { Badge } from "@/components/ui/badge";
import { RoleDetailTabs } from "./_role-detail-tabs";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/roles/[roleId]
 *
 * Server entry for the role detail (docs/admin-manager.md §8.4).
 *
 * Loads the role + its permission keys via the shared
 * `loadRoleOrThrow` helper so the dual-list editor renders the
 * already-assigned set on first paint without a client round-trip.
 *
 * Tabs (rendered client-side):
 *   - Permissions — dual-list editor (POST/DELETE /permissions)
 *   - Members     — paginated grid of users carrying this role
 *   - Settings    — name/description editor (key is read-only)
 */
export default async function AdministratorRoleDetailPage({
  params,
}: {
  params: Promise<{ locale: string; roleId: string }>;
}) {
  const { locale, roleId } = await params;

  const guard = await checkAdminPermissionServer("admin.roles.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!isUuid(roleId)) {
    notFound();
  }

  let role;
  try {
    role = await loadRoleOrThrow(roleId);
  } catch (err) {
    if (err instanceof AdminError && err.code === "role_not_found") {
      notFound();
    }
    throw err;
  }

  // ADR-0001: confine an org admin to their org's roles; a global role is
  // SUPERADMIN-only. notFound() preserves existence indistinguishability.
  if (!canAccessOrg(guard.access, role.organization_id)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.roles" });

  const canUpdate = guard.access.permissions.includes("admin.roles.update");

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{role.name}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-xs">{role.key}</code>
          </p>
        </div>
        <Badge variant="outline">
          {role.organization_id === null ? t("scope.global") : t("scope.org")}
        </Badge>
      </div>

      <RoleDetailTabs
        role={{
          id: role.id,
          organizationId: role.organization_id,
          key: role.key,
          name: role.name,
          description: role.description,
          permissionKeys: role.permissionKeys,
          memberCount: role.memberCount,
        }}
        canUpdate={canUpdate}
      />
    </section>
  );
}
