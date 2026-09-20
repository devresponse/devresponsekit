import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { updateOrganizationSchema } from "@/lib/validation/organizations";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  AdminError,
  assertOrgEmpty,
  assertOrgNotDefault,
  loadOrgOrThrow,
} from "@/lib/admin/orgs.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/organizations/:id
 *
 * Returns detailed view of an organization with associated counts.
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  // ADR-0001: an org admin may read only their own org.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  try {
    const org = await loadOrgOrThrow(id);
    return NextResponse.json(org);
  } catch (err) {
    if (err instanceof AdminError && err.code === "organization_not_found") {
      return adminErrorResponse(err.code, 404, request);
    }
    throw err;
  }
}

/**
 * PATCH /api/administrator/organizations/:id
 *
 * Updates organization fields. Caller MUST hold `admin.orgs.update`.
 *
 * Body fields (all optional):
 *   - slug: string
 *   - name: string
 *   - status: "active" | "pending" | "suspended" | "archived"
 *   - isDefault: boolean
 */

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  // ADR-0001: mutating the org entity (rename/status/default) is a
  // platform-level, SUPERADMIN-only action. Note this gate is reached for ANY
  // org id — there is no `canAccessOrg` narrowing below it — so before
  // MACHINE-2 a superuser-owned key minted in org A could rename or re-home
  // org B.
  // MACHINE-2: `hasCrossOrgReach`, not `isSuperadmin` — an ORG-BOUND bearer
  // credential never takes the SUPERADMIN bypass on a platform-wide action,
  // even when its owner is a global superuser.
  if (!hasCrossOrgReach(guard.access)) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateOrganizationSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const existing = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const updates: Record<string, unknown> = {};
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.name !== undefined) updates.name = input.name;
  if (input.status !== undefined) updates.status = input.status;
  if (input.isDefault !== undefined) updates.is_default = input.isDefault;
  updates.updated_at = new Date();

  try {
    if (input.isDefault === true) {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("app_organizations")
          .set({ is_default: false })
          .where("is_default", "=", true)
          .execute();
        await trx.updateTable("app_organizations").set(updates).where("id", "=", id).execute();
      });
    } else {
      await db.updateTable("app_organizations").set(updates).where("id", "=", id).execute();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("slug_taken", 409, request);
    }
    throw err;
  }

  await auditOrgAction("admin.organization.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: id,
    metadata: { organizationId: id, slug: input.slug ?? existing.slug, changes: input },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/organizations/:id
 *
 * Deletes an organization if empty and not the default.
 * Caller MUST hold `admin.orgs.delete`.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  // ADR-0001: deleting a tenant is a SUPERADMIN-only action, on ANY org id.
  // MACHINE-2: `hasCrossOrgReach`, not `isSuperadmin` — an ORG-BOUND bearer
  // credential never takes the SUPERADMIN bypass on a platform-wide action,
  // even when its owner is a global superuser.
  if (!hasCrossOrgReach(guard.access)) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  try {
    await assertOrgNotDefault(id);
    await assertOrgEmpty(id);
  } catch (err) {
    if (err instanceof AdminError) {
      await auditOrgAction("admin.organization.delete_blocked", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: id,
        metadata: { organizationId: id, slug: existing.slug, reason: err.code },
      });
      return adminErrorResponse(err.code, 409, request);
    }
    throw err;
  }

  // DB-3: the success audit is written INSIDE the deleting transaction and
  // BEFORE the delete statement. Written afterwards (as it was), the INSERT
  // named an `organization_id` whose parent row was already gone: DB-1's
  // `ON DELETE SET NULL` detaches audit rows that ALREADY EXIST when the org
  // is removed, but it says nothing about a NEW insert naming a missing id, so
  // that insert was a plain foreign-key violation. It landed outside the FK
  // handler below, so EVERY successful tenant delete ended in an unhandled 500
  // — after the row was already committed as deleted — and
  // `admin.organization.deleted` was never recorded at all.
  //
  // Inside the transaction the parent still exists, so the FK resolves; the
  // delete then cascades the same SET NULL tombstone over this row as over the
  // org's older audit history. The surviving row therefore has a NULL
  // `organization_id` by design — `metadata.organizationId` / `metadata.slug`
  // are what tell an operator WHICH tenant was removed, alongside the actor and
  // `created_at` for who and when.
  //
  // Ordering also makes the audit atomic with the outcome it claims: a delete
  // that rolls back (the FK 409 below, or any later failure) takes the success
  // row with it, and a tenant can no longer be removed without one.
  let blockedByForeignKey = false;
  let vanishedMidRequest = false;
  try {
    await db.transaction().execute(async (trx) => {
      try {
        await auditOrgAction("admin.organization.deleted", "success", {
          request,
          actorBetterAuthUserId: guard.betterAuthUserId,
          organizationId: id,
          metadata: { organizationId: id, slug: existing.slug },
          executor: trx,
        });
      } catch (err) {
        // DB-5: the existence check above ran on the pool, so a second
        // superadmin can commit its own delete of this tenant between that
        // read and this INSERT. Making the audit the FIRST statement in the
        // transaction (DB-3) also makes it the statement that DISCOVERS the
        // race: its `organization_id` has no parent left and the FK rejects it.
        // Unhandled, that reaches the generic rethrow below and the caller gets
        // a 500 — for a tenant this same handler answers 404 for whenever the
        // row happens to be missing a moment sooner. Flag it so the outer catch
        // gives that documented answer instead.
        //
        // Matched on the CONSTRAINT NAME rather than the sibling branch's
        // generic /foreign key/i: `app_audit_events_organization_id_fkey` is
        // pinned by migration 0001 (it drops whatever constraint is present and
        // re-adds it under exactly this name), and it is the only FK on this
        // INSERT that a missing org can break. The looser pattern would also
        // catch the row's `app_user_id` FK and report an unrelated fault as a
        // missing tenant. If the name ever stops matching, this falls through
        // to the rethrow — the pre-DB-5 behaviour, never a wrong answer.
        const message = err instanceof Error ? err.message : "unknown";
        if (/app_audit_events_organization_id_fkey/i.test(message)) vanishedMidRequest = true;
        throw err;
      }

      try {
        await trx.deleteFrom("app_organizations").where("id", "=", id).execute();
      } catch (err) {
        // The emptiness guard only covers memberships. An org can still own
        // roles, provider bindings, enterprise apps, or API/OAuth credentials
        // whose FKs block the delete. Translate that FK violation into the
        // documented 409 (DB-1) instead of letting it surface as a raw 500.
        // The flag is set HERE, on the delete statement alone, so an FK error
        // from any other statement in the transaction still surfaces as itself
        // rather than being mislabelled `organization_in_use`.
        const message = err instanceof Error ? err.message : "unknown";
        if (/foreign key/i.test(message)) blockedByForeignKey = true;
        // Rethrow regardless: the failed statement has already aborted the
        // transaction, and rolling back is what discards the success audit.
        throw err;
      }
    });
  } catch (err) {
    // DB-5: the tenant was already gone before this request could touch it, so
    // answer exactly as the existence check above answers for an id that was
    // never there. No audit row, for the same two reasons that branch writes
    // none: there is no tenant left to name, and the rollback has already taken
    // back the success row this request wrote a moment ago.
    if (vanishedMidRequest) return adminErrorResponse("organization_not_found", 404, request);
    if (!blockedByForeignKey) throw err;
    await auditOrgAction("admin.organization.delete_blocked", "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      metadata: { organizationId: id, slug: existing.slug, reason: "organization_in_use" },
    });
    return adminErrorResponse("organization_in_use", 409, request);
  }

  return NextResponse.json({ ok: true });
}
