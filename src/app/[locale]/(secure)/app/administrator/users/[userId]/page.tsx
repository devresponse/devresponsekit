import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { ImpersonateUserButton } from "./_impersonate-button";
import { UserDetailTabs } from "./_user-detail-tabs";

export const dynamic = "force-dynamic";

/**
 * Administrator → User detail page (docs/admin-manager.md §8.4).
 *
 * RSC that:
 *   1. Validates the caller holds `admin.users.read` (route guard).
 *   2. Resolves the target `app_users` row — 404 (notFound()) if it does
 *      not exist; this also gives 404 indistinguishability for users
 *      probing for ids they don't have access to (the layout already
 *      gated the entire `/administrator/*` tree on any admin permission,
 *      so passing this read check means the caller is an admin reader).
 *   3. Renders the static metadata header + a client `UserDetailTabs`
 *      component that owns the interactive tabs (Overview, Sessions,
 *      and Audit). Roles / Memberships tabs render as "coming soon"
 *      placeholders until Phases 4-5 land their endpoints.
 */
export default async function AdministratorUserDetailPage({
  params,
}: {
  params: Promise<{ locale: string; userId: string }>;
}) {
  const { locale, userId } = await params;

  const guard = await checkAdminPermissionServer("admin.users.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  if (!isUuid(userId)) {
    notFound();
  }

  const user = await db
    .selectFrom("app_users")
    .select([
      "id",
      "better_auth_user_id",
      "primary_email",
      "display_name",
      "status",
      "status_reason",
      "preferred_locale",
      "created_at",
      "updated_at",
      "deactivated_at",
      "deactivated_by",
      "deactivated_reason",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();

  if (!user) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.users" });

  const canUpdateMemberships = guard.access.permissions.includes("admin.users.update");
  const canImpersonate = guard.access.permissions.includes("admin.users.impersonate");
  const isSelfTarget = guard.betterAuthUserId === user.better_auth_user_id;

  // ISO-string-ify timestamps so the value crosses the RSC/client
  // boundary cleanly (Date instances aren't serializable through
  // children props).
  const userJson = {
    id: user.id,
    better_auth_user_id: user.better_auth_user_id,
    primary_email: user.primary_email,
    display_name: user.display_name,
    status: user.status,
    status_reason: user.status_reason,
    preferred_locale: user.preferred_locale,
    created_at: toIso(user.created_at),
    updated_at: toIso(user.updated_at),
    deactivated_at: toIso(user.deactivated_at),
    deactivated_by: user.deactivated_by,
    deactivated_reason: user.deactivated_reason,
  };

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Button asChild variant="link" className="h-auto px-0 text-sm">
            <LocaleLink locale={locale} href="/app/administrator/users">
              ← {t("detail.backToList")}
            </LocaleLink>
          </Button>
          <h1 className="text-lg font-semibold">{user.display_name ?? user.primary_email}</h1>
          <p className="text-muted-foreground text-sm">{user.primary_email}</p>
        </div>
        <div className="flex items-center gap-2">
          {canImpersonate ? (
            <ImpersonateUserButton
              userId={user.id}
              email={user.primary_email}
              isSelf={isSelfTarget}
            />
          ) : null}
          <StatusBadge status={user.status} label={translateStatus(t, user.status)} />
        </div>
      </div>

      <UserDetailTabs user={userJson} canUpdateMemberships={canUpdateMemberships} />
    </section>
  );
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
]);

function translateStatus(t: Awaited<ReturnType<typeof getTranslations>>, status: string): string {
  // Only call into the i18n catalog with known keys to avoid the
  // "missing message" warning + render the raw status verbatim if a
  // future status enum value lands before the translation does.
  return KNOWN_STATUSES.has(status) ? t(`status.${status}` as never) : status;
}
