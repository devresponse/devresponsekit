import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { canAccessUser, hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { mustUseRestore } from "@/lib/admin/deactivated-user";
import { isErasedAccount } from "@/lib/admin/erased-user";
import { isAgentServiceAccount } from "@/lib/admin/service-account";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/admin/user-target.server";
import { APP_USER_STATUS_VALUES } from "@/lib/status-values";
import { StatusBadge } from "@/components/ui/status-badge";
import { EraseUserButton } from "./_erase-button";
import { ImpersonateUserButton } from "./_impersonate-button";
import { UserDetailTabs } from "./_user-detail-tabs";

export const dynamic = "force-dynamic";

/**
 * Administrator → User detail page (docs/admin-manager.md §8.1).
 *
 * RSC that:
 *   1. Validates the caller holds `admin.users.read` (route guard).
 *   2. Resolves the target `app_users` row — 404 (notFound()) if it does
 *      not exist; this also gives 404 indistinguishability for users
 *      probing for ids they don't have access to (the layout already
 *      gated the entire `/administrator/*` tree on any admin permission,
 *      so passing this read check means the caller is an admin reader).
 *   3. Renders the static metadata header + a client `UserDetailTabs`
 *      component that owns the interactive tabs. Overview, Roles and
 *      Memberships need only `admin.users.read`; every other tab is gated on
 *      the permission ITS OWN API enforces (review #76) — Groups on
 *      `admin.groups.read`, Sessions on `admin.users.sessions`, Audit on
 *      `admin.audit.read` — so a permitted reader is never walked into a 403
 *      by clicking a tab. The flags are derived below and passed down, and
 *      so are the ones the tabs' pickers and cross-links need (F-67).
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

  // ADR-0001: an org admin may only view a user who holds a membership in
  // their org. notFound() (not 403) preserves existence indistinguishability.
  if (!(await canAccessUser(guard.access, user.id))) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.users" });

  // `deactivated_by` stores the ACTOR'S Better Auth user id (see
  // `user-actions.server.ts`), which is meaningless to a human reader
  // (review #212). Resolve it to a display name here — a single indexed
  // lookup, only when the field is set — and fall back to the raw id when
  // the actor is outside the caller's tenant or has no app_users row.
  const deactivatedByLabel = user.deactivated_by
    ? await resolveActorLabel(guard.access, guard.betterAuthUserId, user.deactivated_by)
    : null;

  const canAssignRoles = guard.access.permissions.includes("admin.roles.assign");
  const canManageGroups = guard.access.permissions.includes("admin.groups.assign");
  const canUpdateMemberships = guard.access.permissions.includes("admin.users.update");
  // F-148: the start route refuses a target the secure shell would not admit
  // (403 `target_not_active`), so the button is not offered for an account that
  // is not active. An active account whose memberships in the admin's reach are
  // all inactive is left to the route, which resolves them as the session would.
  // Nor for an agent service account, which has no Better Auth user to open a
  // session on (F-77: the route answers 409 `not_applicable_to_service_account`).
  const canImpersonate =
    guard.access.permissions.includes("admin.users.impersonate") &&
    user.status === "active" &&
    !isAgentServiceAccount({ betterAuthUserId: user.better_auth_user_id });
  const canReadAudit = guard.access.permissions.includes("admin.audit.read");
  // Review #76: the Sessions and Groups tabs each fetch an API that requires
  // MORE than `admin.users.read` — `admin.users.sessions` and
  // `admin.groups.read` respectively — so rendering them for every reader sent
  // the user into a 403 on click. Gate each tab on the permission its OWN API
  // enforces, exactly as the Audit tab already does.
  const canReadSessions = guard.access.permissions.includes("admin.users.sessions");
  const canReadGroups = guard.access.permissions.includes("admin.groups.read");
  // F-67, the same rule one level down: inside the Roles and Memberships tabs,
  // the role picker reads GET /roles, and the role and organization names
  // link to pages guarded on `admin.roles.read` and `admin.orgs.read`. The
  // seeded Limited Admin (`admin.users.read` + `.manage`) held neither and
  // clicked through to a 404 that wrote an access-denied row.
  const canReadRoles = guard.access.permissions.includes("admin.roles.read");
  const canReadOrgs = guard.access.permissions.includes("admin.orgs.read");
  const isSelfTarget = guard.betterAuthUserId === user.better_auth_user_id;
  // F-151: the data-subject export and erasure. The export link needs the
  // export route's own key; the route still applies the rank guard and the
  // shared-target rule, and answers 403 where they refuse. Erasure is offered
  // only where the route would run it: a superadmin with cross-org reach, a
  // soft-deleted account not yet erased, never an agent's service account.
  const isErased = isErasedAccount({ appUserId: user.id, primaryEmail: user.primary_email });
  const canExport = guard.access.permissions.includes("admin.users.export");
  const canErase =
    hasCrossOrgReach(guard.access) &&
    mustUseRestore(user) &&
    !isErased &&
    !isAgentServiceAccount({ betterAuthUserId: user.better_auth_user_id });

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
    deactivated_by_label: deactivatedByLabel,
    deactivated_reason: user.deactivated_reason,
  };

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{user.display_name ?? user.primary_email}</h1>
          <p className="text-muted-foreground text-sm">{user.primary_email}</p>
          {isErased ? (
            <p className="text-muted-foreground text-sm">{t("erasure.erasedNotice")}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canExport ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/administrator/users/${encodeURIComponent(user.id)}/export`} download>
                {t("actions.exportData")}
              </a>
            </Button>
          ) : null}
          {canErase ? <EraseUserButton userId={user.id} email={user.primary_email} /> : null}
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

      <UserDetailTabs
        user={userJson}
        canReadSessions={canReadSessions}
        canReadGroups={canReadGroups}
        canReadRoles={canReadRoles}
        canReadOrgs={canReadOrgs}
        canAssignRoles={canAssignRoles}
        canManageGroups={canManageGroups}
        canUpdateMemberships={canUpdateMemberships}
        canReadAudit={canReadAudit}
        isSelf={isSelfTarget}
      />
    </section>
  );
}

/**
 * Best-effort display name for the actor recorded in `deactivated_by`
 * (review #212), resolved ONLY when that actor is inside the caller's own
 * tenant boundary.
 *
 * The scope check is not redundant with the `canAccessUser` gate above.
 * That gate authorizes the TARGET row; the actor is a DIFFERENT principal,
 * and ADR-0001 is explicit that "a user may hold several memberships"
 * (access-scope.server.ts) — so a target visible to an Org A admin can
 * perfectly well have been deactivated by an Org B admin, or by a platform
 * superadmin with no membership in Org A at all. Rendering that actor's
 * display name or primary email would be a cross-tenant PII leak, so the
 * label is only resolved when the actor IS the caller or passes the same
 * `canAccessUser` predicate; otherwise the raw Better Auth id is returned,
 * which is what the UI showed before #212 and leaks nothing new.
 *
 * Falls back to the raw id for a missing `app_users` row (a platform/seed
 * actor, or a record deleted since) so "Deactivated by" is never empty.
 */
async function resolveActorLabel(
  access: Parameters<typeof canAccessUser>[0],
  callerBetterAuthUserId: string,
  actorBetterAuthUserId: string,
): Promise<string> {
  const actor = await db
    .selectFrom("app_users")
    .select(["id", "display_name", "primary_email"])
    .where("better_auth_user_id", "=", actorBetterAuthUserId)
    .executeTakeFirst();
  if (!actor) return actorBetterAuthUserId;

  const inScope =
    actorBetterAuthUserId === callerBetterAuthUserId || (await canAccessUser(access, actor.id));
  if (!inScope) return actorBetterAuthUserId;

  return actor.display_name ?? actor.primary_email ?? actorBetterAuthUserId;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(APP_USER_STATUS_VALUES);

function translateStatus(t: Awaited<ReturnType<typeof getTranslations>>, status: string): string {
  // Only call into the i18n catalog with known keys to avoid the
  // "missing message" warning; anything else renders verbatim. The known
  // keys are the status vocabulary itself (F-133), and
  // tests/unit/shared-vocabulary-invariant.test.ts holds the catalog to a
  // label for each one.
  return KNOWN_STATUSES.has(status) ? t(`status.${status}` as never) : status;
}
