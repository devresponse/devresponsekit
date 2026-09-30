import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { isUniqueViolation } from "@/db/pg-errors";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import {
  conferrablePermissions,
  permissionKeysForRoles,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  filterValues,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { loadScopedOrg, ORGANIZATION_NOT_ACTIVE_ERROR } from "@/lib/admin/org-route.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT } from "@/lib/http/rate-limit.server";
import { enforceSharedRateLimit } from "@/lib/http/rate-limit-shared.server";
import { ADMIN_MAIL_EVENTS, enforceOrgAdminMailBudget } from "@/lib/admin/admin-mail-budget.server";
import { adminMailLocale } from "@/lib/admin/admin-mail-locale.server";
import { refuseUnconferrable } from "@/lib/admin/refusals.server";
import type { SendAppEmailResult } from "@/lib/email/send.server";
import { createInvitation, sendInvitationEmail } from "@/lib/invitations.server";
import { createInvitationSchema } from "@/lib/validation/invitations";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";
import { withAdminRoute } from "@/lib/http/route-handler.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/organizations/:id/invitations
 *
 * Paginated invitations for this organization. Filters: `status`
 * (pending/accepted/revoked/expired), repeatable: any of its values matches
 * (F-74). `q` searches the invitee email.
 * Token hashes are never returned.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
  if (org instanceof NextResponse) return org;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["status", "email", "created_at", "expires_at"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_organization_invitations as i")
    .leftJoin("app_roles as r", "r.id", "i.role_id")
    .leftJoin("app_users as u", "u.id", "i.invited_by")
    .where("i.organization_id", "=", org.id);

  // `expired` is a derived status, not a stored one: a `pending` row past
  // `expires_at` is dead (findValidInvitationByToken/consume reject it) but
  // the column still reads `pending`. Compute the effective status so the
  // grid badge and the `status` filter tell the truth. A repeated `status`
  // matches any of its values (F-74); it used to be dropped, which listed
  // every invitation.
  const statuses = filterValues(query, "status");
  if (statuses.length > 0) {
    const stored = statuses.filter((s) => s !== "expired" && s !== "pending");
    base = base.where((eb) =>
      eb.or([
        ...(statuses.includes("expired")
          ? [eb.and([eb("i.status", "=", "pending"), eb("i.expires_at", "<=", sql<Date>`now()`)])]
          : []),
        ...(statuses.includes("pending")
          ? [eb.and([eb("i.status", "=", "pending"), eb("i.expires_at", ">", sql<Date>`now()`)])]
          : []),
        ...(stored.length > 0 ? [eb("i.status", "in", stored)] : []),
      ]),
    );
  }
  if (query.q) {
    base = base.where("i.email", "ilike", likeContains(query.q));
  }

  const itemsQuery = applySortAndPagination(
    base.select((eb) => [
      "i.id",
      "i.email",
      eb
        .case()
        .when(eb.and([eb("i.status", "=", "pending"), eb("i.expires_at", "<=", sql<Date>`now()`)]))
        .then(sql.lit("expired"))
        .else(eb.ref("i.status"))
        .end()
        .as("status"),
      "i.role_id",
      "r.name as role_name",
      "u.display_name as invited_by_display_name",
      "i.expires_at",
      "i.accepted_at",
      "i.created_at",
      "i.updated_at",
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
});

/**
 * POST /api/administrator/organizations/:id/invitations
 *
 * Invites an email address into the organization (optionally with a role
 * belonging to it) and sends the accept link through the outbox. 409
 * `member_exists` when the address already belongs to an ACTIVE member;
 * 409 `invitation_exists` when a pending invitation is already out; 409
 * `organization_not_active` when the org is not `active` (F-09).
 *
 * Attaching a role is a deferred role ASSIGNMENT, so it is bound by the same
 * privilege-escalation guard (AUTHZ-3) as `users/[id]/app-roles`: a
 * non-SUPERADMIN may only attach a role whose conferred permissions are a
 * subset of what they can confer themselves — 403 `forbidden` and an
 * `admin.permission.conferral_denied` row otherwise (F-58).
 *
 * F-64: the invitation is a mail to an address the caller chooses, so its
 * per-actor budget comes from the shared bucket, and an org-confined caller
 * spends the org's daily admin-mail budget (429 `rate_limited` once spent).
 *
 * F-104: `ok` is false when the provider rejected the email: the invitation is
 * created, but nobody received its link. The audit row carries the outbox id
 * and the email's status, and is `error` for a rejection or a send that threw.
 *
 * Caller MUST hold `admin.orgs.manage` (F-69: invitations are people management).
 */
export const POST = withAdminRoute(async function POST(
  request: NextRequest,
  context: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.orgs.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  // F-64: from the SHARED bucket, shared with resend: kept per process, it
  // multiplied by the instance count, and every token here mails someone.
  const limited = await enforceSharedRateLimit(
    "admin.orgs.invitations",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
  if (org instanceof NextResponse) return org;

  // F-09: an invitation into a suspended, archived or pending org could not be
  // accepted (`findValidInvitationByToken` treats it as dead), so sending one
  // would only mail out a link that fails. Refuse it up front instead.
  if (org.status !== ACTIVE_ORGANIZATION_STATUS) {
    return adminErrorResponse(ORGANIZATION_NOT_ACTIVE_ERROR, 409, request, {
      requestId: guard.requestId,
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createInvitationSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const email = parsed.data.email.trim().toLowerCase();

  // The optional role must belong to THIS org — never a cross-org grant.
  if (parsed.data.roleId) {
    const role = await db
      .selectFrom("app_roles")
      .select(["id"])
      .where("id", "=", parsed.data.roleId)
      .where("organization_id", "=", org.id)
      .executeTakeFirst();
    if (!role) {
      return adminErrorResponse("role_not_found", 404, request);
    }
    // Privilege-escalation guard (AUTHZ-3, review #6): the invitee receives
    // this role on acceptance, so the inviter must be able to confer every
    // permission it carries — otherwise an org admin could invite their own
    // alternate mailbox with the seeded `superuser` role and mint a second,
    // global-superadmin account. Identical wiring to the sibling conferral
    // routes: a bearer credential is bounded by its scopes and never takes
    // the SUPERADMIN fast-path (P1-1). `consumeInvitation` re-checks against
    // the inviter's authority at accept time (defense in depth). A refusal is
    // audited under this org, naming the address and the role (F-58).
    if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
      const conferred = await permissionKeysForRoles([role.id]);
      const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
      const unheld = unheldPermissionKeys(conferrable, conferred);
      if (unheld.length > 0) {
        return refuseUnconferrable(guard, request, {
          action: "invitation_create",
          organizationId: org.id,
          unheld,
          email,
          metadata: { roleId: role.id },
        });
      }
    }
  }

  // Already an active member? Inviting again is a no-op the admin should
  // see as a conflict (a PENDING member may legitimately be re-invited —
  // acceptance is what activates them).
  const activeMember = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .select(["m.id"])
    .where("m.organization_id", "=", org.id)
    .where("m.status", "=", "active")
    .where(sql`lower(u.primary_email)`, "=", email)
    .executeTakeFirst();
  if (activeMember) {
    return adminErrorResponse("member_exists", 409, request);
  }

  // F-64: checked last, just before anything is written or sent, so a request
  // the checks above refuse neither waits on nor reports the budget.
  const overBudget = await enforceOrgAdminMailBudget(guard, org.id, request);
  if (overBudget) return overBudget;

  // F-102: the language of the email and of its link: the invitee's own if
  // the address has an account with a membership in this org (the outbox row
  // is this org's, so it must not reveal an account elsewhere), else the
  // inviting admin's. Read before the invitation is written, so a failed read
  // leaves nothing to audit.
  const locale = await adminMailLocale(email, org.id, request, guard.access);

  let created: { id: string; plaintextToken: string; expiresAt: Date };
  try {
    created = await createInvitation({
      organizationId: org.id,
      email,
      roleId: parsed.data.roleId ?? null,
      invitedByAppUserId: guard.access.appUserId,
    });
  } catch (err) {
    // F-132: by SQLSTATE and constraint, never by the (translatable) message.
    if (isUniqueViolation(err, "idx_app_org_invitations_pending_unique")) {
      return adminErrorResponse("invitation_exists", 409, request);
    }
    throw err;
  }

  // F-104: the audit names what became of the email. A rejected one is an
  // `error`: the invitation stands, but its only copy of the link was refused.
  const audit = (delivery: SendAppEmailResult | null) =>
    auditOrgAction(
      ADMIN_MAIL_EVENTS.invitationCreated,
      delivery && delivery.status !== "failed" ? "success" : "error",
      {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: org.id,
        requestId: guard.requestId,
        reason:
          delivery === null
            ? "email_send_failed"
            : delivery.status === "failed"
              ? "email_rejected"
              : null,
        metadata: {
          organizationId: org.id,
          slug: org.slug,
          invitationId: created.id,
          email,
          roleId: parsed.data.roleId ?? null,
          outboxId: delivery?.outboxId ?? null,
          emailStatus: delivery?.status ?? null,
        },
      },
    );

  // Outbox-first delivery (specs.md §35): the accept link exists only in
  // this email; the DB holds the token's hash.
  const delivery = await sendInvitationEmail({
    to: email,
    // ADR-0001 / review #220: the outbox row belongs to the inviting org, so
    // its admins can see the invitation in their own Email workspace.
    organizationId: org.id,
    organizationName: org.name,
    inviterAppUserId: guard.access.appUserId,
    plaintextToken: created.plaintextToken,
    locale,
  }).catch(async (err: unknown) => {
    // F-104: the invitation exists already, so a send that throws still
    // leaves its audit row before the 500. It threw before its outbox row
    // was written (sendAppEmail returns every outcome after that, a failed
    // row UPDATE included), so nothing was queued. An admin who tries again
    // meets 409 `invitation_exists`, and resends instead.
    await audit(null);
    throw err;
  });
  await audit(delivery);

  return NextResponse.json(
    {
      // F-104: false when the provider rejected the email (see above).
      ok: delivery.status !== "failed",
      id: created.id,
      expiresAt: created.expiresAt.toISOString(),
    },
    { status: 201 },
  );
});
