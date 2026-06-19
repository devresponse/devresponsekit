import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
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
} from "@/lib/admin/access-scope.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/users/[id]
 *
 * Fetches a single application user by id. Returns the same column set
 * the list endpoint exposes. Joining with the Better Auth user table is
 * intentionally a separate fetch (kept in the page layer) per plan §13.
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
 * their own dedicated endpoints (plan §5.2). We deliberately do NOT
 * allow editing `primary_email` here in v1 — email changes need a
 * verification flow, which is not yet built.
 */
const patchSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    preferredLocale: z.string().min(2).max(10).optional(),
  })
  .strict();

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.mutate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
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
      await updateBetterAuthUser(
        {
          userId: target.betterAuthUserId,
          data: { name: parsed.data.displayName },
        },
        request,
      );
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
 * Soft-delete only (plan §4.1). Performs in a single Kysely tx:
 *   1. Indefinite Better Auth ban (so the user cannot sign in).
 *   2. `app_users.status = 'deactivated'` + `deactivated_*` columns.
 *
 * Hard delete via `auth.api.removeUser` is intentionally NOT exposed in
 * v1 (decision §20.1.11). A `restore` endpoint inverts this action.
 */
const deleteSchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.mutate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

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
    await banBetterAuthUser(
      {
        userId: target.betterAuthUserId,
        banReason: reason ?? "deleted",
        // Omit `banExpiresIn` for indefinite per Better Auth semantics.
      },
      request,
    );
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
      await trx
        .updateTable("app_users")
        .set({
          status: "deactivated",
          status_reason: reason,
          deactivated_at: sql`now()`,
          deactivated_by: guard.betterAuthUserId,
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
      // leaving them silently inaccessible (plan §4.1).
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
      await unbanBetterAuthUser(target.betterAuthUserId, request);
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
