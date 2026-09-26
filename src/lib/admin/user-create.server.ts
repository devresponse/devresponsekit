import "server-only";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import {
  isSuperadmin,
  resolveOrgScope,
  type AccessLike,
  type OrgScope,
} from "@/lib/admin/access-scope.server";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";
import { scopesAuthorize } from "@/lib/api-auth/scopes";
import { findEmailDomainOrganization } from "@/lib/auth-policy.server";

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
 *
 * The enrolment is a membership add, and an `active` one is an approval too, so
 * a confined creator must hold the permissions those take on their own
 * ({@link refuseConfinedCreation}, F-480). The membership carries no sign-up
 * source (`source_provider` stays NULL), so the org's sign-up policy never
 * activates it at sign-in (`reevaluatePendingActivation`): a pending user stays
 * pending until someone approves it.
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

/*
 * F-480 — A CONFINED CREATE GRANTS NO MORE THAN THE EXPLICIT PATHS WOULD.
 *
 * Before the create enrolled anyone, a caller confined to one org made a user a
 * member of it only through a route with its own permission:
 * `POST /organizations/{id}/members` (`admin.orgs.update`) or
 * `POST /users/{id}/memberships` (`admin.users.update`). And a pending user
 * became active only when someone holding `admin.users.manage` approved it. The
 * create is gated on `admin.users.create` alone, so once it enrolled, a key or
 * MCP agent scoped to just that minted an ACTIVE member of its org, signed in
 * with a password the key's holder chose, with neither permission. So a
 * confined creator must hold one of the membership permissions to enrol at all,
 * and the approval permission to start the user (and its membership) `active`.
 * Both are refused with 403 before anything is written; neither is downgraded
 * silently, and none creates a user with no membership (the orphan the
 * enrolment exists to prevent).
 *
 * "Holds" is decided as `requireAdminPermission` decides it: the principal
 * holds the key (a superadmin holds every key) AND, for a bearer credential,
 * the credential's scopes authorize it. A caller with cross-org reach enrols
 * nobody, so none of this applies to it.
 */

/** Either permission writes a membership in the caller's own org on its own. */
export const ENROLMENT_PERMISSIONS: readonly string[] = ["admin.users.update", "admin.orgs.update"];
/** Approving a pending user (`POST /users/{id}/status` `approve`). */
export const ACTIVATION_PERMISSION = "admin.users.manage";

/** The caller as both guards hand it over: its access context and credential scopes. */
export interface CreationCaller {
  access: AccessLike;
  /** `null` for a cookie session (full user authority); the credential's scopes otherwise. */
  grantedScopes: ReadonlyArray<string> | null;
}

export type CreationRefusalReason =
  "enrolment_not_permitted" | "activation_not_permitted" | "email_domain_claimed";

export interface CreationRefusal {
  reason: CreationRefusalReason;
  /** What the audit row records about the refusal (never another org's id). */
  metadata: Record<string, unknown>;
}

/** The `detail` the v1 problem carries, so an API client or agent can act on it. */
export const CREATION_REFUSAL_DETAIL: Record<CreationRefusalReason, string> = {
  enrolment_not_permitted:
    "Creating a user enrols it in the credential's organization, which also needs " +
    "admin.users.update or admin.orgs.update.",
  activation_not_permitted:
    "Creating an active user also needs admin.users.manage. Omit initialAppStatus to create " +
    "a pending user, and approve it with POST /api/v1/users/{id}/status.",
  email_domain_claimed:
    "The address's email domain is bound to another organization. Invite the address instead.",
};

function holds(caller: CreationCaller, permission: string): boolean {
  return (
    (isSuperadmin(caller.access) || caller.access.permissions.includes(permission)) &&
    scopesAuthorize(caller.grantedScopes, permission)
  );
}

/**
 * The permission half of {@link refuseConfinedCreation}: why this caller may not
 * create a user who starts `status`, or `null`. It needs no address and no
 * database, so the New user page asks it the same question the API will.
 */
function permissionRefusal(
  scope: OrgScope,
  caller: CreationCaller,
  status: NewAppUser["status"],
): CreationRefusal | null {
  if (scope.kind !== "org") return null;

  if (!ENROLMENT_PERMISSIONS.some((permission) => holds(caller, permission))) {
    return { reason: "enrolment_not_permitted", metadata: { required: ENROLMENT_PERMISSIONS } };
  }
  // Fail closed on the status: anything but the pending default is an approval.
  if (status !== "pending_approval" && !holds(caller, ACTIVATION_PERMISSION)) {
    return {
      reason: "activation_not_permitted",
      metadata: { required: [ACTIVATION_PERMISSION], initialAppStatus: status },
    };
  }
  return null;
}

/**
 * Whether the permission rules let the caller create a user who starts
 * `status`: always for a creator with cross-org reach, which enrols nobody;
 * for a confined one, only with a membership permission, and for `active` the
 * approval permission too; never for a context with no org. The New user page
 * renders its form only when `pending_approval` passes, and offers the Active
 * status only when `active` does, so it offers no choice whose every submit is
 * a 403. The email-domain rule depends on the address, so only a submit
 * decides it.
 */
export function mayCreateUser(caller: CreationCaller, status: NewAppUser["status"]): boolean {
  const scope = resolveOrgScope(caller.access);
  return scope !== null && permissionRefusal(scope, caller, status) === null;
}

/**
 * Why a confined creator may not create this user, or `null` when it may. Both
 * create routes call it after resolving the scope and before anything is
 * written, the Better Auth identity included.
 *
 * Beyond the two permissions (see above), it refuses an address whose email
 * domain a superadmin bound to ANOTHER org (F-04, `findEmailDomainOrganization`).
 * Such a binding says that domain's people belong to that org; a creator in a
 * different org that pre-creates and enrols one of them would keep the account
 * after its real owner turns up, since provisioning never places an existing
 * account by domain again. An address on the creator's own bound domain, or on
 * an unbound one, is not refused (see docs/admin-manager.md §8.1 for what that
 * leaves open). Inviting the address works in every case: acceptance proves the
 * mailbox.
 */
export async function refuseConfinedCreation(input: {
  scope: OrgScope;
  caller: CreationCaller;
  email: string;
  status: NewAppUser["status"];
}): Promise<CreationRefusal | null> {
  const { scope, caller } = input;
  if (scope.kind !== "org") return null;

  const refused = permissionRefusal(scope, caller, input.status);
  if (refused) return refused;

  // Accepted trade-off: this refusal tells a creator that SOME other org bound
  // the domain. Hiding the reason would not hide that: any refusal differs from
  // a 201, and this creator already passed the permission checks above. It
  // never learns which org, here or in the audit row.
  const bound = await findEmailDomainOrganization(input.email);
  if (bound && bound.organizationId !== scope.organizationId) {
    // The domain only: the row is filed under the creator's org, whose
    // auditors must not learn which other tenant claims it.
    return { reason: "email_domain_claimed", metadata: { domain: bound.providerOrganizationKey } };
  }
  return null;
}

/**
 * The `admin.user.create_denied` row for a {@link refuseConfinedCreation}
 * refusal. No user exists, so it names none; the address is in `email`, and the
 * org is the creator's, so that tenant's auditors see the attempt.
 */
export async function auditCreationRefusal(
  refusal: CreationRefusal,
  ctx: {
    request: NextRequest;
    actorBetterAuthUserId: string;
    organizationId: string | null;
    email: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await auditUserAction("admin.user.create_denied", "denied", {
    request: ctx.request,
    actorBetterAuthUserId: ctx.actorBetterAuthUserId,
    appUserId: null,
    organizationId: ctx.organizationId,
    email: ctx.email,
    reason: refusal.reason,
    requestId: ctx.requestId,
    metadata: { ...refusal.metadata, ...ctx.metadata },
  });
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
