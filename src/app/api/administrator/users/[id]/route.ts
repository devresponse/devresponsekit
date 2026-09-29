import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql, type UpdateObject } from "kysely";
import { z } from "zod";
import { preferredLocaleSchema } from "@/lib/validation/users";
import { userNameSchema } from "@/lib/user-name";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  restoreBetterAuthBan,
  updateBetterAuthUser,
  type BanSnapshot,
} from "@/lib/admin/auth-admin.server";
import {
  banForSoftDelete,
  carriedPriorBan,
  finishSoftDelete,
} from "@/lib/admin/user-actions.server";
import {
  actingOrganizationId,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
  banStripsLastGlobalSuperuser,
  LastSuperadminCascadeError,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  LAST_SUPERADMIN_STATUS,
} from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { refuseSharedTarget } from "@/lib/admin/refusals.server";
import {
  isAgentServiceAccount,
  SERVICE_ACCOUNT_ERROR,
  SERVICE_ACCOUNT_STATUS,
} from "@/lib/admin/service-account";
import { humanActorId } from "@/lib/impersonation-attribution.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/users/[id]
 *
 * Fetches a single application user by id: the list endpoint's
 * application columns (minus the `organization_names` aggregate, which is
 * computed only for the list view) plus the deactivation bookkeeping
 * (`status_reason`, `deactivated_*`), and — like the list endpoint — no
 * join against the Better Auth `user`
 * table. The auth-side `banned` / `role` flags are written by the
 * dedicated `/ban` and `/role` endpoints and never read back here
 * (docs/admin-manager.md §8.1).
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const row = await db
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
    .where("id", "=", target.appUserId)
    .executeTakeFirstOrThrow();

  return NextResponse.json({ user: row });
});

/**
 * PATCH /api/administrator/users/[id]
 *
 * Partial update of safe profile fields:
 *   - `displayName` — mirrored to Better Auth `name` so both layers
 *     stay in sync.
 *   - `preferredLocale` — application-only. It picks the language of the
 *     user's transactional emails and SSO claims; it does NOT pick the UI
 *     language, which is the URL's locale segment (F-37).
 *
 * Status changes go through `/status`; ban/role/password each have
 * their own dedicated endpoints (docs/admin-manager.md §8.1). We
 * deliberately do NOT allow editing `primary_email` here in v1 — email
 * changes need a verification flow, which is not yet built.
 *
 * Both fields are account-global: every tenant's console, the invitation
 * emails that quote the name and the language of every transactional email
 * read them. So the edit takes the same target guards as the other
 * account-level actions (F-61): the rank guard, then the AUTHZ-2 shared-target
 * rule.
 */
const patchSchema = z
  .object({
    // F-21: the shared name rule (`user-name.ts`). The value is mirrored to
    // Better Auth `name` and quoted by the invitation email, so a line break
    // or bidi control is refused here, not stored.
    displayName: userNameSchema.optional(),
    // Review #71/#80: constrained to the app's supported locales via the ONE
    // shared schema — a free-form 2-10 char string used to be stored verbatim.
    preferredLocale: preferredLocaleSchema.optional(),
  })
  .strict();

export const PATCH = withAdminRoute(async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.mutate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // F-61: privilege ordering (review #7). Without it an org admin holding
  // `admin.users.update` could rename a superadmin who shares their org, or
  // switch that superadmin's email language — 403 + audit, as on DELETE.
  const outranked = await refuseOutrankingTarget(guard, target, request, "update");
  if (outranked) return outranked;

  // F-61 / AUTHZ-2: the display name (mirrored to Better Auth `name`) and the
  // preferred locale have no per-tenant copy, so an edit to a user shared with
  // other orgs changes what those tenants see too. That is SUPERADMIN-only; an
  // org admin may edit a user confined to their own org.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return refuseSharedTarget(guard, target, request, "update");
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // `UpdateObject`, not `Updateable`: it also takes the `now()` expression.
  const updates: UpdateObject<AppDatabase, "app_users"> = { updated_at: sql`now()` };
  if (parsed.data.displayName !== undefined) {
    updates.display_name = parsed.data.displayName;
  }
  if (parsed.data.preferredLocale !== undefined) {
    updates.preferred_locale = parsed.data.preferredLocale;
  }

  if (Object.keys(updates).length === 1) {
    return adminErrorResponse("no_changes", 400, request);
  }

  await db.updateTable("app_users").set(updates).where("id", "=", target.appUserId).execute();

  // Mirror display name to Better Auth so the auth-side `name` stays
  // in sync. Failures here do not roll back the app update — the auth
  // record can be reconciled later — but we audit the failure. An agent
  // service account has no Better Auth user to mirror to, which audited a
  // failure on every rename (F-77).
  if (parsed.data.displayName !== undefined && !isAgentServiceAccount(target)) {
    try {
      await updateBetterAuthUser({
        userId: target.betterAuthUserId,
        data: { name: parsed.data.displayName },
      });
    } catch (err) {
      await auditUserAction("admin.user.update_auth_mirror_failed", "error", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        organizationId: actingOrganizationId(guard.access),
        email: target.primaryEmail,
        reason: "auth_update_failed",
        metadata: { message: err instanceof Error ? err.message : "unknown" },
      });
    }
  }

  await auditUserAction("admin.user.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    organizationId: actingOrganizationId(guard.access),
    email: target.primaryEmail,
    metadata: { fields: Object.keys(parsed.data) },
  });

  return NextResponse.json({ ok: true });
});

/**
 * DELETE /api/administrator/users/[id]
 *
 * Soft-delete only (docs/admin-manager.md §8.1). Three steps (review #137):
 *   1. Indefinite Better Auth ban — an auth-API call, NOT transactional;
 *      a failure aborts with 502 before anything app-side changes.
 *   2. App-side bookkeeping (`app_users.status = 'deactivated'` +
 *      `deactivated_*` columns) and the membership cascade in ONE Kysely
 *      tx, with a compensating unban if that tx fails (#B6), which puts
 *      back any ban step 1 replaced (F-57).
 *   3. Once that commits, the user's API keys and OAuth clients are revoked
 *      (I-19), and the audit row records the ban restore puts back (F-57).
 *
 * Hard delete via `auth.api.removeUser` is intentionally NOT exposed in
 * v1: soft-delete keeps the row restorable and its audit trail intact. A
 * `restore` endpoint inverts this action (docs/admin-manager.md §8.1). An
 * agent service account is 409 `not_applicable_to_service_account` (F-77).
 */
const deleteSchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

export const DELETE = withAdminRoute(async function DELETE(
  request: NextRequest,
  ctx: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.users.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.mutate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // Privilege ordering (review #7): a non-SUPERADMIN may not act on a target
  // who outranks them (a superadmin, or a more-privileged peer) — 403 + audit.
  const outranked = await refuseOutrankingTarget(guard, target, request, "soft_delete");
  if (outranked) return outranked;

  // AUTHZ-2: soft-delete is an account-global lockout (Better Auth ban +
  // deactivation + cascade). A non-SUPERADMIN may not apply it to a user
  // shared with other orgs — that would deactivate them in tenants the actor
  // does not administer. Such a user is SUPERADMIN-only.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return adminErrorResponse("not_found", 404, request);
  if (await requiresSuperadminForSharedTarget(scope, target.appUserId)) {
    return refuseSharedTarget(guard, target, request, "soft_delete");
  }

  // F-77: step 1 bans the Better Auth user, which an agent service account
  // does not have, so this was a 502. Its lifecycle is the Agents console's.
  if (isAgentServiceAccount(target)) {
    return adminErrorResponse(SERVICE_ACCOUNT_ERROR, SERVICE_ACCOUNT_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  // Body is optional for DELETE — treat missing/empty as no reason.
  let body: unknown = {};
  try {
    body = (await request.json().catch(() => ({}))) ?? {};
  } catch {
    body = {};
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const reason = parsed.data.reason ?? null;

  // Step 1 — Better Auth indefinite ban. Failures here abort the soft
  // delete so we don't leave the auth record signed-in-able while the
  // app row says "deactivated". It reports the ban it replaced (F-57). A
  // repeated soft-delete carries the first one's record forward; reading it
  // is a database read, so it stays outside the `auth_ban_failed` handling
  // and a failure is the generic 500.
  const carried = await carriedPriorBan(target);
  let bans: { previousBan: BanSnapshot | null; priorBan: BanSnapshot | null };
  try {
    bans = await banForSoftDelete(
      target,
      { banReason: reason ?? "deleted", actorBetterAuthUserId: guard.betterAuthUserId },
      carried,
    );
  } catch (err) {
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: "auth_ban_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("auth_ban_failed", 502, request, {
      cause: err,
      requestId: guard.requestId,
    });
  }

  // Step 2 — application soft-delete bookkeeping. Wrapped in a saga:
  // if the DB transaction fails after we already banned the user in
  // Better Auth, we issue a compensating unban so the two stores
  // don't drift (#B6).
  try {
    await db.transaction().execute(async (trx) => {
      // REVOKE-2 (review #444): the cascade below blocks EVERY membership this
      // user holds, which is precisely what stops a `superuser` assignment
      // counting — the same transition `PATCH/DELETE …/memberships` refuses
      // with 409. The rank guard above exempts a SUPERADMIN actor outright, so
      // without this the platform's last superadmin could soft-delete
      // themselves in one click and leave nobody able to administer it. Run
      // inside the transaction that performs the cascade so it shares the row
      // locks that serialize it against the four revocation routes; the throw
      // rolls the transaction back and the saga's compensating unban (below)
      // undoes the Better Auth ban we already applied. F-56: a grant counts
      // only for an account that can sign in, so the check is measured as the
      // ban applied in step 1 — read as a membership cascade, the ban would
      // already have emptied the set and nothing would be refused.
      if (await banStripsLastGlobalSuperuser(target, trx)) {
        throw new LastSuperadminCascadeError();
      }

      await trx
        .updateTable("app_users")
        .set({
          status: "deactivated",
          status_reason: reason,
          deactivated_at: sql`now()`,
          // F-07: the human who did it — the impersonating admin, not the
          // borrowed identity, when the session is an impersonation.
          deactivated_by: humanActorId(guard),
          deactivated_reason: reason,
          updated_at: sql`now()`,
        })
        .where("id", "=", target.appUserId)
        .execute();

      // Cascade memberships to `blocked` so the user disappears from the
      // active member views without losing the audit trail of which orgs
      // they belonged to. Snapshot the prior status into
      // `pre_deactivation_status` so the matching `restore` endpoint
      // can return each membership to its original state instead of
      // leaving them silently inaccessible (docs/admin-manager.md §8.1).
      await trx
        .updateTable("app_organization_memberships")
        .set({
          pre_deactivation_status: sql`status`,
          status: "blocked",
          updated_at: sql`now()`,
        })
        .where("app_user_id", "=", target.appUserId)
        // Only snapshot rows that aren't already in the soft-delete
        // state (defends against double-deletes overwriting the
        // snapshot with the cascade value `'blocked'`).
        .where("status", "!=", "blocked")
        .execute();
    });
  } catch (err) {
    // Compensate the Better Auth ban so the two systems stay in sync: back to
    // the ban it replaced, not to no ban at all (F-57). Failure of the
    // compensation itself is audited but does not change the response
    // status — the caller still needs to know the operation failed.
    try {
      await restoreBetterAuthBan(target.betterAuthUserId, bans.previousBan);
    } catch (unbanErr) {
      await auditUserAction("admin.user.soft_delete_compensation_failed", "error", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        organizationId: actingOrganizationId(guard.access),
        email: target.primaryEmail,
        requestId: guard.requestId,
        reason: "compensation_unban_failed",
        metadata: {
          message: unbanErr instanceof Error ? unbanErr.message : "unknown",
        },
      });
    }
    // REVOKE-2: an expected refusal, not a fault. The transaction rolled back
    // untouched and the ban has just been compensated above, so the account is
    // exactly as it was — answer 409 with the shared vocabulary the four
    // revocation routes use, never the 500 a real cascade failure gets.
    if (err instanceof LastSuperadminCascadeError) {
      await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
        organizationId: actingOrganizationId(guard.access),
        email: target.primaryEmail,
        requestId: guard.requestId,
        reason: LAST_SUPERADMIN_REASON,
        metadata: { action: "soft_delete" },
      });
      return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
        requestId: guard.requestId,
      });
    }
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      organizationId: actingOrganizationId(guard.access),
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: "db_cascade_failed",
      metadata: { message: err instanceof Error ? err.message : "unknown" },
    });
    return adminErrorResponse("soft_delete_failed", 500, request, {
      cause: err,
      requestId: guard.requestId,
    });
  }

  // Step 3 — revoke the user's API keys and OAuth clients, so a restore never
  // re-arms them (I-19), and write the audit row that records the ban restore
  // must put back (F-57). A failed revocation is a 500 the operator retries.
  const finished = await finishSoftDelete(target, bans.priorBan, {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: actingOrganizationId(guard.access),
    revokedByAppUserId: guard.access.appUserId,
    requestId: guard.requestId,
    reason,
  });
  if (!finished.ok) {
    return adminErrorResponse("soft_delete_failed", 500, request, {
      cause: finished.cause,
      requestId: guard.requestId,
    });
  }

  return NextResponse.json({ ok: true });
});
