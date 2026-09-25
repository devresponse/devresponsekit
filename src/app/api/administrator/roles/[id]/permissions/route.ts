import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  isSuperadmin,
  wouldStripLastGlobalSuperuser,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  LAST_SUPERADMIN_STATUS,
  SUPERADMIN_PERMISSION,
} from "@/lib/admin/access-scope.server";
import {
  conferrablePermissions,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/roles/[id]/permissions
 *
 * Returns the permission keys currently attached to a role. Caller MUST
 * hold `admin.roles.read` (the canonical "read role detail"
 * permission). The shape `{ permissions: string[] }` matches what the
 * dual-list editor (§8.4) consumes.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const roleRow = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!roleRow || !canAccessOrg(guard.access, roleRow.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["p.key as key"])
    .where("rp.role_id", "=", id)
    .orderBy("p.key", "asc")
    .execute();

  return NextResponse.json({ permissions: rows.map((r) => r.key) });
});

/**
 * POST/DELETE body shared schema. The dual-list editor saves through both
 * (one POST for `toAdd`, THEN one DELETE for `toRemove`); both endpoints
 * accept the same `{ ids }` body. Each write is atomic on its own, but the
 * pair is not — see `src/lib/admin/dual-list-save.client.ts` for how the
 * editor keeps a half-applied save visible (F-38).
 *
 * `ids` are permission keys (not row UUIDs) — the editor works in the
 * domain language of "admin.users.read" rather than opaque ids.
 */
const idsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(120)).min(1).max(500),
  })
  .strict();

async function loadRoleHeader(roleId: string) {
  return db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", roleId)
    .executeTakeFirst();
}

async function currentPermissionKeys(roleId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["p.key as key"])
    .where("rp.role_id", "=", roleId)
    .execute();
  return rows.map((r) => r.key);
}

/**
 * F-38: the keys of the rows a write ACTUALLY touched, as its `RETURNING`
 * reported them, for the audit row's `added` / `removed`. Before this the
 * audit named the keys the body asked for: a re-POST of an attached key
 * logged it as added again, and a DELETE naming a never-attached key logged
 * it as removed although the route's own contract calls that a no-op. Every
 * returned id came out of `resolved`, so the lookup always hits.
 */
function appliedKeys(
  rows: ReadonlyArray<{ permission_id: string }>,
  resolved: ReadonlyArray<{ id: string; key: string }>,
): string[] {
  const keyById = new Map(resolved.map((p) => [p.id, p.key]));
  return rows
    .map((r) => keyById.get(r.permission_id))
    .filter((key): key is string => key !== undefined)
    .sort();
}

/**
 * POST /api/administrator/roles/[id]/permissions
 *
 * Attaches the given permission keys to the role. Body: `{ ids: string[] }`.
 * Unknown keys are silently dropped — they cannot grant power they
 * don't have. Existing assignments are left untouched (idempotent).
 *
 * Caller MUST hold `admin.roles.update`.
 */
export const POST = withAdminRoute(async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.permissions",
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
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const role = await loadRoleHeader(id);
  if (!role) return adminErrorResponse("not_found", 404, request);
  // ADR-0001: confine an org admin to their org's roles (404 to avoid
  // confirming a foreign/global role exists).
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  // Privilege-escalation guard (AUTHZ-3): a non-SUPERADMIN may attach only
  // permission keys they themselves currently hold. Otherwise an org admin
  // could grant a role authority they lack — including the `superuser` marker
  // (subsumed here, since it is never in a non-superadmin's held set) — and
  // then assign that role to themselves. A bearer credential is bounded by its
  // scopes, not just its owner's permissions, and never takes the SUPERADMIN
  // fast-path (P1-1).
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, parsed.data.ids);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  // Resolve key -> permission_id. Keys not in the catalog are dropped.
  const permRows = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("key", "in", parsed.data.ids)
    .execute();
  const resolved = permRows.map((r) => ({ id: r.id, key: r.key }));

  let added: string[] = [];
  if (resolved.length > 0) {
    // `ON CONFLICT DO NOTHING ... RETURNING` yields only the rows this insert
    // created, so a key the role already carried is not reported as added
    // (F-38).
    const inserted = await db.transaction().execute((trx) =>
      trx
        .insertInto("app_role_permissions")
        .values(resolved.map((p) => ({ role_id: id, permission_id: p.id })))
        .onConflict((oc) => oc.doNothing())
        .returning("permission_id")
        .execute(),
    );
    added = appliedKeys(inserted, resolved);
  }

  const finalKeys = await currentPermissionKeys(id);

  // F-38: a request that changed nothing (every key already attached) is still
  // audited, with an empty `added`: the row records that the actor asked and
  // what the role holds afterwards, and every 200 from this route keeps
  // leaving exactly one row.
  await auditRoleAction("admin.role.permissions_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: role.organization_id,
    metadata: {
      roleId: id,
      key: role.key,
      added,
      removed: [],
      resulting: finalKeys,
    },
  });

  return NextResponse.json({ ok: true, permissions: finalKeys });
});

/**
 * DELETE /api/administrator/roles/[id]/permissions
 *
 * Detaches the given permission keys from the role. Body: same
 * `{ ids: string[] }` shape. Keys not currently attached are no-ops.
 *
 * Caller MUST hold `admin.roles.update`.
 */
export const DELETE = withAdminRoute(async function DELETE(
  request: NextRequest,
  ctx: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.permissions",
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
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const role = await loadRoleHeader(id);
  if (!role) return adminErrorResponse("not_found", 404, request);
  // ADR-0001: confine an org admin to their org's roles (404 to avoid
  // confirming a foreign/global role exists).
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  // REVOKE-1 (symmetry): the same AUTHZ-3 subset test POST applies, against the
  // REMOVED set. Without it the guard was one-directional — an org admin could
  // not ATTACH `superuser` (or anything else they lack) to a role, but could
  // DETACH it from the seeded org-scoped `superuser` role and silently destroy
  // platform authority they were never trusted with, with no way to put it
  // back (AUTHZ-3 forbids re-conferring it). Measured against the raw requested
  // keys, exactly as POST does, so the two directions cannot drift.
  //
  // Consequence worth stating (review #444): a key that is NOT in
  // `app_permissions` is in nobody's held set, so `unheldPermissionKeys` always
  // reports it and a non-superadmin now gets a 403 where the same request used
  // to be a silent 200 no-op (the key resolved to nothing and nothing was
  // deleted). That is precisely the failure POST has always had for an unknown
  // key; measuring against the catalog-resolved set instead would restore the
  // no-op but break the symmetry this guard exists to hold, so it stays
  // fail-closed. A client replaying a permission key retired from the catalog
  // must drop it from the request.
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, parsed.data.ids);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  const permRows = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("key", "in", parsed.data.ids)
    .execute();
  const resolved = permRows.map((r) => ({ id: r.id, key: r.key }));

  // REVOKE-2: stripping `superuser` off a role kills EVERY grant conferred
  // through it at once, so this is the single most destructive revocation on
  // the platform — and a SUPERADMIN passes the guard above by construction,
  // including when the role they are editing is the one that makes them super.
  // Only the removals that actually land count: `resolved` is what the delete
  // below touches, and a body naming `superuser` for a role that does not carry
  // it removes nothing. The check shares the deleting transaction and its row
  // lock (see `activeGlobalSuperuserGrants`).
  const strippingSuperuser = resolved.some((r) => r.key === SUPERADMIN_PERMISSION);
  let removed: string[] = [];
  if (resolved.length > 0) {
    const outcome = await db.transaction().execute(async (trx) => {
      if (strippingSuperuser && (await wouldStripLastGlobalSuperuser({ roleIds: [id] }, trx))) {
        return "last_superadmin" as const;
      }
      // `RETURNING` names only the rows this delete removed: a key the role
      // never carried is a no-op here and must not be audited as removed
      // (F-38).
      return trx
        .deleteFrom("app_role_permissions")
        .where("role_id", "=", id)
        .where(
          "permission_id",
          "in",
          resolved.map((r) => r.id),
        )
        .returning("permission_id")
        .execute();
    });

    if (outcome === "last_superadmin") {
      await auditRoleAction(LAST_SUPERADMIN_EVENT, "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: role.organization_id,
        requestId: guard.requestId,
        reason: LAST_SUPERADMIN_REASON,
        metadata: {
          action: "role_permissions_detach",
          roleId: id,
          key: role.key,
          removed: resolved.map((r) => r.key).sort(),
        },
      });
      return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
        requestId: guard.requestId,
      });
    }
    removed = appliedKeys(outcome, resolved);
  }

  const finalKeys = await currentPermissionKeys(id);

  // Audited even when nothing was attached to remove (`removed: []`), for the
  // same reason as POST (F-38).
  await auditRoleAction("admin.role.permissions_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: role.organization_id,
    metadata: {
      roleId: id,
      key: role.key,
      added: [],
      removed,
      resulting: finalKeys,
    },
  });

  return NextResponse.json({ ok: true, permissions: finalKeys });
});
