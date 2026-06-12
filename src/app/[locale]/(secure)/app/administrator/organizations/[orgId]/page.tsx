import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdminError, loadOrgOrThrow } from "@/lib/admin/orgs.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { OrganizationDetailTabs } from "./_organization-detail-tabs";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/organizations/[orgId]
 *
 * Server entry for the organization detail (docs/admin-manager.md §19).
 *
 * Loads the organization + its counts via the shared `loadOrgOrThrow`
 * helper so the members, providers tables render the right counts on
 * first paint without a client round-trip.
 *
 * Tabs (rendered client-side):
 *   - Members   — paginated grid of memberships
 *   - Providers — paginated grid of provider bindings
 *   - Settings  — name/slug/status editor
 */
export default async function AdministratorOrganizationDetailPage({
  params,
}: {
  params: Promise<{ locale: string; orgId: string }>;
}) {
  const { locale, orgId } = await params;

  const guard = await checkAdminPermissionServer("admin.orgs.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!isUuid(orgId)) {
    notFound();
  }

  let org;
  try {
    org = await loadOrgOrThrow(orgId);
  } catch (err) {
    if (err instanceof AdminError && err.code === "organization_not_found") {
      notFound();
    }
    throw err;
  }

  const t = await getTranslations({ locale, namespace: "administrator.orgs" });

  const canUpdate = guard.access.permissions.includes("admin.orgs.update");

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Button asChild variant="link" className="h-auto px-0 text-sm">
            <LocaleLink locale={locale} href="/app/administrator/organizations">
              ← {t("backToList")}
            </LocaleLink>
          </Button>
          <h1 className="text-lg font-semibold">{org.name}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-xs">{org.slug}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={org.status} />
          {org.is_default ? <Badge variant="secondary">{t("defaultYes")}</Badge> : null}
        </div>
      </div>

      <OrganizationDetailTabs
        org={{
          id: org.id,
          slug: org.slug,
          name: org.name,
          status: org.status,
          isDefault: org.is_default,
          memberCount: org.member_count,
          bindingCount: org.binding_count,
        }}
        canUpdate={canUpdate}
      />
    </section>
  );
}
