import "server-only";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";

/**
 * The `app_users` write both create routes share (`POST /api/administrator/users`
 * and `POST /api/v1/users`, which the MCP `createUser` tool calls), and the
 * membership that places the new user in its creator's org.
 *
 * A user's tenant is its membership (ADR-0001): every follow-up on
 * `/users/{id}` goes through `canAccessUser`, which lets a caller without
 * cross-org reach act only on a member of its own org. That caller is an org
 * admin's session or any API key or JWT, since every bearer credential is bound
 * to one org (MACHINE-2). A create that added no membership handed such a
 * caller a user it could not read, approve, ban or enrol: 404 on each, until a
 * superadmin attached it. So a creator confined to one org enrols the user
 * there, in the same transaction as the `app_users` row, and neither row exists
 * without the other. The membership takes the user's initial status, so a
 * `pending_approval` user is a pending member and approving it activates both
 * (`performAdminStatusChange`). A creator with cross-org reach passes no org:
 * the user is created in none, as before, and placed with
 * `POST /api/administrator/users/{id}/memberships`.
 */
export interface NewAppUser {
  betterAuthUserId: string;
  email: string;
  displayName: string | null;
  status: "active" | "pending_approval";
  preferredLocale: string;
  /**
   * The org the creator is confined to (`scopeOrganizationId` of its
   * `resolveOrgScope`), or `null` for a creator with cross-org reach.
   */
  enrolOrganizationId: string | null;
}

export interface CreationMembership {
  id: string;
  organizationId: string;
  slug: string;
}

export interface CreatedAppUser {
  appUser: { id: string; primary_email: string; status: string };
  membership: CreationMembership | null;
}

/**
 * Inserts the `app_users` row and, for a confined creator, its membership, in
 * one transaction. Throws on any failure; the caller audits it as
 * `db_insert_failed`, since either way no `app_users` row exists.
 */
export async function insertCreatedUser(input: NewAppUser): Promise<CreatedAppUser> {
  return db.transaction().execute(async (trx) => {
    const appUser = await trx
      .insertInto("app_users")
      .values({
        better_auth_user_id: input.betterAuthUserId,
        primary_email: input.email,
        display_name: input.displayName,
        status: input.status,
        preferred_locale: input.preferredLocale,
      })
      .returning(["id", "primary_email", "status"])
      .executeTakeFirstOrThrow();

    const organizationId = input.enrolOrganizationId;
    if (!organizationId) return { appUser, membership: null };

    const membership = await trx
      .insertInto("app_organization_memberships")
      .values({ organization_id: organizationId, app_user_id: appUser.id, status: input.status })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const org = await trx
      .selectFrom("app_organizations")
      .select(["slug"])
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();
    return { appUser, membership: { id: membership.id, organizationId, slug: org.slug } };
  });
}

/**
 * The two rows `POST /api/administrator/users/{id}/memberships` writes for an
 * added membership, so an enrolment at creation shows on the member's and the
 * org's Audit tabs like one added by hand. `metadata` carries the route's own
 * extras (`via`).
 */
export async function auditCreationMembership(
  membership: CreationMembership,
  ctx: {
    request: NextRequest;
    actorBetterAuthUserId: string;
    appUserId: string;
    status: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const metadata = {
    organizationId: membership.organizationId,
    slug: membership.slug,
    appUserId: ctx.appUserId,
    membershipId: membership.id,
    status: ctx.status,
    ...ctx.metadata,
  };
  await Promise.all([
    auditUserAction("admin.user.membership_added", "success", {
      request: ctx.request,
      actorBetterAuthUserId: ctx.actorBetterAuthUserId,
      appUserId: ctx.appUserId,
      organizationId: membership.organizationId,
      requestId: ctx.requestId,
      metadata,
    }),
    auditOrgAction("admin.organization.member_added", "success", {
      request: ctx.request,
      actorBetterAuthUserId: ctx.actorBetterAuthUserId,
      organizationId: membership.organizationId,
      requestId: ctx.requestId,
      metadata,
    }),
  ]);
}
