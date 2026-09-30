import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { loadGroupDetail } from "@/lib/admin/groups.server";
import { groupEtag } from "@/lib/admin/record-etag.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { GroupDetailTabs } from "./_group-detail-tabs";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/groups/[groupId]
 *
 * Group detail (ADR-0002). Confined to the actor's org by `canAccessOrg`
 * (404 otherwise). Tabs: Roles (dual-list), Members (grid), Settings.
 */
export default async function AdministratorGroupDetailPage({
  params,
}: {
  params: Promise<{ locale: string; groupId: string }>;
}) {
  const { locale, groupId } = await params;

  const guard = await checkAdminPermissionServer("admin.groups.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!isUuid(groupId)) {
    notFound();
  }

  const group = await loadGroupDetail(groupId);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.groups" });

  const canUpdate = guard.access.permissions.includes("admin.groups.update");
  const canAssign = guard.access.permissions.includes("admin.groups.assign");
  // F-67: the Roles tab reads the org's role catalog (GET /roles) and the
  // Members tab searches users (GET /users) and links each member to the user
  // page. Those need `admin.roles.read` and `admin.users.read`, which this
  // page never checked: a delegated group manager landed on a generic error
  // (Roles is the default tab) and an empty "Add member" picker.
  const canReadRoles = guard.access.permissions.includes("admin.roles.read");
  const canReadUsers = guard.access.permissions.includes("admin.users.read");

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{group.name}</h1>
        <p className="text-muted-foreground text-sm">
          <code className="text-xs">{group.key}</code> ·{" "}
          {t("memberCount", { count: group.memberCount })}
        </p>
      </div>

      <GroupDetailTabs
        group={{
          id: group.id,
          key: group.key,
          name: group.name,
          description: group.description,
          etag: groupEtag(group),
        }}
        canUpdate={canUpdate}
        canAssign={canAssign}
        canReadRoles={canReadRoles}
        canReadUsers={canReadUsers}
      />
    </section>
  );
}
