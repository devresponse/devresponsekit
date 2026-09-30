import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Updateable } from "kysely";
import { db } from "@/db/database";
import type { AppRolesTable } from "@/db/schema/app-schema";
import { updateRoleSchema } from "@/lib/validation/roles";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import {
  AdminError,
  assertRoleNotInUse,
  isForeignKeyViolation,
  loadRoleOrThrow,
} from "@/lib/admin/roles.server";
import { lockedRoleEtag, ROLE_ETAG_COLUMNS, roleEtag } from "@/lib/admin/record-etag.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { ifMatchPinsVersion, ifMatchSatisfied } from "@/lib/api-auth/etag";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/roles/[id]
 *
 * Fetches a single role plus its permission keys and member count.
 * Caller MUST hold `admin.roles.read`. The `ETag` is the role's content tag
 * (F-39), which a PATCH may send back as `If-Match`.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  try {
    const role = await loadRoleOrThrow(id);
    // ADR-0001: confine an org admin to their org's roles; a global role is
    // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
    if (!canAccessOrg(guard.access, role.organization_id)) {
      return adminErrorResponse("not_found", 404, request);
    }
    return NextResponse.json({ role }, { headers: { ETag: roleEtag(role) } });
  } catch (err) {
    if (err instanceof AdminError && err.code === "role_not_found") {
      return adminErrorResponse("not_found", 404, request);
    }
    throw err;
  }
});

/**
 * PATCH /api/administrator/roles/[id]
 *
 * Partial update of name / description. The `key` is intentionally
 * read-only after creation (mirrors §8.4 — "Settings" tab) so audit
 * trails referencing it stay valid.
 *
 * F-39: an `If-Match` naming a tag other than the role's current one (see
 * `record-etag.server.ts`) is refused with 412 `precondition_failed`, and
 * nothing is written; the 412 carries the current `ETag`. The comparison runs
 * under a row lock in the writing transaction. Without `If-Match` the update
 * is last-write-wins, as before. A 200 carries the updated role's `ETag`.
 */
export const PATCH = withAdminRoute(async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateRoleSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const updates: Updateable<AppRolesTable> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (Object.keys(updates).length === 0) {
    return adminErrorResponse("no_changes", 400, request);
  }

  const existing = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }
  // ADR-0001: confine an org admin to their org's roles; a global role is
  // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  const ifMatch = request.headers.get("if-match");
  const outcome = await db.transaction().execute(async (trx) => {
    if (ifMatchPinsVersion(ifMatch)) {
      const current = await lockedRoleEtag(trx, id);
      if (current === null) return { kind: "vanished" as const };
      if (!ifMatchSatisfied(ifMatch, current)) return { kind: "stale" as const, etag: current };
    }
    const updated = await trx
      .updateTable("app_roles")
      .set(updates)
      .where("id", "=", id)
      .returning(ROLE_ETAG_COLUMNS)
      .executeTakeFirst();
    return updated
      ? { kind: "updated" as const, etag: roleEtag(updated) }
      : { kind: "vanished" as const };
  });
  // Deleted by a concurrent request after the read above.
  if (outcome.kind === "vanished") {
    return adminErrorResponse("not_found", 404, request);
  }
  if (outcome.kind === "stale") {
    return adminErrorResponse("precondition_failed", 412, request, {
      requestId: guard.requestId,
      headers: { ETag: outcome.etag },
    });
  }

  await auditRoleAction("admin.role.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { roleId: id, key: existing.key, fields: Object.keys(updates) },
  });

  return NextResponse.json({ ok: true }, { headers: { ETag: outcome.etag } });
});

/**
 * DELETE /api/administrator/roles/[id]
 *
 * Refuses with `role_in_use` (HTTP 409) when the role is still
 * referenced by `app_user_roles` or `app_group_roles` (DB-2, review #149).
 * On success: deletes
 * `app_role_permissions` and the `app_roles` row in one transaction so
 * the constraint cannot leave orphan permission rows behind.
 *
 * F-97: the in-use check runs in that SAME transaction, after locking the
 * role row (`assertRoleNotInUse`), so a grant committed while the request
 * is in flight is counted instead of cascade-deleted with the role (a group
 * grant) or failing the delete with 23503 (a direct assignment).
 */
export const DELETE = withAdminRoute(async function DELETE(
  request: NextRequest,
  ctx: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.roles.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }
  // ADR-0001: confine an org admin to their org's roles; a global role is
  // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  try {
    await db.transaction().execute(async (trx) => {
      await assertRoleNotInUse(trx, id);
      await trx.deleteFrom("app_role_permissions").where("role_id", "=", id).execute();
      await trx.deleteFrom("app_roles").where("id", "=", id).execute();
    });
  } catch (err) {
    // A 23503 is the backstop for a reference the guard does not count.
    if ((err instanceof AdminError && err.code === "role_in_use") || isForeignKeyViolation(err)) {
      await auditRoleAction("admin.role.delete_blocked", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: existing.organization_id,
        reason: "role_in_use",
        metadata: { roleId: id, key: existing.key },
      });
      return adminErrorResponse("role_in_use", 409, request);
    }
    // Deleted by a concurrent request after the read above.
    if (err instanceof AdminError && err.code === "role_not_found") {
      return adminErrorResponse("not_found", 404, request);
    }
    throw err;
  }

  await auditRoleAction("admin.role.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { roleId: id, key: existing.key },
  });

  // All reads/writes above used the imported `db` symbol; no extra
  // bookkeeping needed before returning.
  return NextResponse.json({ ok: true });
});
