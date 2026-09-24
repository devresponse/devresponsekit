import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { preferredLocaleSchema } from "@/lib/validation/users";
import { userNameSchema } from "@/lib/user-name";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  banBetterAuthUser,
  unbanBetterAuthUser,
  updateBetterAuthUser,
} from "@/lib/admin/auth-admin.server";
import {
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
  membershipCascadeStripsLastGlobalSuperuser,
  LastSuperadminCascadeError,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  LAST_SUPERADMIN_STATUS,
} from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { humanActorId } from "@/lib/impersonation-attribution.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

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
export async function GET(request: NextRequest, ctx: RouteContext) {
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
}

/**
 * PATCH /api/administrator/users/[id]
 *
 * Partial update of safe profile fields:
 *   - `displayName` — mirrored to Better Auth `name` so both layers
 *     stay in sync.
 *   - `preferredLocale` — application-only, used by next-intl.
 *
 * Status changes go through `/status`; ban/role/password each have
 * their own dedicated endpoints (docs/admin-manager.md §8.1). We
 * deliberately do NOT allow editing `primary_email` here in v1 — email
 * changes need a verification flow, which is not yet built.
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

export async function PATCH(request: NextRequest, ctx: RouteContext) {
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

  const updates: Record<string, unknown> = { updated_at: sql`now()` };
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
  // record can be reconciled later — but we audit the failure.
  if (parsed.data.displayName !== undefined) {
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
    email: target.primaryEmail,
    metadata: { fields: Object.keys(parsed.data) },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/users/[id]
 *
 * Soft-delete only (docs/admin-manager.md §8.1). Two steps (review #137):
 *   1. Indefinite Better Auth ban — an auth-API call, NOT transactional;
 *      a failure aborts with 502 before anything app-side changes.
 *   2. App-side bookkeeping (`app_users.status = 'deactivated'` +
 *      `deactivated_*` columns) and the membership cascade in ONE Kysely
 *      tx, with a compensating unban if that tx fails (#B6).
 *
 * Hard delete via `auth.api.removeUser` is intentionally NOT exposed in
 * v1: soft-delete keeps the row restorable and its audit trail intact. A
 * `restore` endpoint inverts this action (docs/admin-manager.md §8.1).
 */
const deleteSchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

export async function DELETE(request: NextRequest, ctx: RouteContext) {
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
    return adminErrorResponse("forbidden", 403, request);
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
  // app row says "deactivated".
  try {
    await banBetterAuthUser({
      userId: target.betterAuthUserId,
      banReason: reason ?? "deleted",
      // Omit `banExpiresIn` for indefinite per Better Auth semantics.
      // A caller soft-deleting themselves is refused here, before anything
      // app-side changes.
      actorBetterAuthUserId: guard.betterAuthUserId,
    });
  } catch (err) {
    await auditUserAction("admin.user.soft_delete_failed", "error", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
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
      // undoes the Better Auth ban we already applied.
      if (await membershipCascadeStripsLastGlobalSuperuser(target.appUserId, trx)) {
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
    // Compensate the Better Auth ban so the two systems stay in sync.
    // Failure of the compensation itself is audited but does not
    // change the response status — the caller still needs to know the
    // operation failed.
    try {
      await unbanBetterAuthUser(target.betterAuthUserId);
    } catch (unbanErr) {
      await auditUserAction("admin.user.soft_delete_compensation_failed", "error", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: target.appUserId,
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

  await auditUserAction("admin.user.soft_deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    reason,
  });

  return NextResponse.json({ ok: true });
}
