import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Kysely } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/http/rate-limit.server";
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
import { refuseUnconferrable, type RefusingGuard } from "@/lib/admin/refusals.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/http/route-handler.server";
import { dualListPatchSchema } from "@/lib/validation/dual-list";

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
 * POST/DELETE body shared schema: both endpoints accept the same `{ ids }`
 * body. Each write is atomic on its own; a client that adds and removes in one
 * save uses PATCH (below), which applies both in one transaction, as the
 * dual-list editor does (F-38).
 *
 * `ids` are permission keys (not row UUIDs) — the editor works in the
 * domain language of "admin.users.read" rather than opaque ids.
 */
const permissionKeySchema = z.string().min(1).max(120);
const idsSchema = z
  .object({
    ids: z.array(permissionKeySchema).min(1).max(500),
  })
  .strict();
/** PATCH: `{ add?, remove? }` permission keys (F-38, `dualListPatchSchema`). */
const patchSchema = dualListPatchSchema(permissionKeySchema);

async function loadRoleHeader(roleId: string) {
  return db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", roleId)
    .executeTakeFirst();
}

async function currentPermissionKeys(
  roleId: string,
  executor: Kysely<AppDatabase> = db,
): Promise<string[]> {
  const rows = await executor
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
 * F-58: audit the AUTHZ-3 / REVOKE-1 refusal and return its 403. The subset
 * test measures the raw requested keys, so a key the catalog does not know is
 * refused (see DELETE), but the row records only the refused keys the catalog
 * knows, and how many others the body named. `ids` are caller-chosen strings,
 * up to 500 of 120 characters, and this table is append-only: recorded
 * verbatim, one refused request parked about 60 KB of the caller's text in it
 * (F-15). The success row records only catalog-resolved keys too (F-38).
 */
async function refuseUnheldKeys(
  guard: RefusingGuard,
  request: NextRequest,
  role: { id: string; organization_id: string | null; key: string },
  action: string,
  unheld: string[],
): Promise<NextResponse> {
  const known = await db
    .selectFrom("app_permissions")
    .select("key")
    .where("key", "in", unheld)
    .execute();
  const knownKeys = new Set(known.map((r) => r.key));
  const recorded = unheld.filter((key) => knownKeys.has(key));
  return refuseUnconferrable(guard, request, {
    action,
    organizationId: role.organization_id,
    unheld: recorded,
    metadata: {
      roleId: role.id,
      key: role.key,
      unknownPermissionKeyCount: unheld.length - recorded.length,
    },
  });
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
  // fast-path (P1-1). A refusal is audited (F-58, `refuseUnheldKeys`).
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, parsed.data.ids);
    if (unheld.length > 0) {
      return refuseUnheldKeys(guard, request, role, "role_permissions_add", unheld);
    }
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
  // must drop it from the request. A refusal is audited like POST's (F-58).
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, parsed.data.ids);
    if (unheld.length > 0) {
      return refuseUnheldKeys(guard, request, role, "role_permissions_remove", unheld);
    }
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

/**
 * PATCH /api/administrator/roles/[id]/permissions
 *
 * F-38: the dual-list editor's save, in ONE request. Body
 * `{ add?: string[], remove?: string[] }` (permission keys; at least one, and
 * none on both sides). Both sets are applied in one transaction, so a save
 * lands whole or not at all. The editor used to send a POST and then a
 * DELETE, and a DELETE refused after its POST had landed left the addition
 * committed, live for every holder of the role.
 *
 * Every guard runs before anything is written:
 *   - AUTHZ-3 / REVOKE-1 on `add`, then on `remove`, exactly as POST and
 *     DELETE apply them (403 and an `admin.permission.conferral_denied` row
 *     naming the direction). Both are judged against the actor's authority as
 *     this request found it, so swapping the permission the actor's own
 *     `admin.roles.update` comes through for an equivalent one succeeds: the
 *     removal cannot take away the authority the addition is judged by.
 *   - REVOKE-2: removing `superuser` from the last role that carries it is 409
 *     `last_superadmin`, checked in the writing transaction under its row
 *     locks, and nothing is added either.
 *
 * One `admin.role.permissions_changed` row records the delta applied, read
 * from `RETURNING` (a key already attached is not `added`, one never attached
 * is not `removed`), and the resulting set. Caller MUST hold
 * `admin.roles.update`. POST and DELETE keep working for API clients.
 */
export const PATCH = withAdminRoute(async function PATCH(request: NextRequest, ctx: RouteContext) {
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
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const { add, remove } = parsed.data;

  const role = await loadRoleHeader(id);
  if (!role) return adminErrorResponse("not_found", 404, request);
  // ADR-0001: confine an org admin to their org's roles (404 to avoid
  // confirming a foreign/global role exists).
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  // AUTHZ-3 (add) and REVOKE-1 (remove), on the raw requested keys as POST
  // and DELETE measure them, so an unknown key is refused here too. A bearer
  // credential is bounded by its scopes and never takes the SUPERADMIN
  // fast-path (P1-1). A refusal is audited (F-58) and writes nothing.
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheldAdded = unheldPermissionKeys(conferrable, add);
    if (unheldAdded.length > 0) {
      return refuseUnheldKeys(guard, request, role, "role_permissions_add", unheldAdded);
    }
    const unheldRemoved = unheldPermissionKeys(conferrable, remove);
    if (unheldRemoved.length > 0) {
      return refuseUnheldKeys(guard, request, role, "role_permissions_remove", unheldRemoved);
    }
  }

  // Keys not in the catalog resolve to nothing, as on POST and DELETE.
  const permRows = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("key", "in", [...add, ...remove])
    .execute();
  const resolved = permRows.map((r) => ({ id: r.id, key: r.key }));
  const toAdd = resolved.filter((p) => add.includes(p.key));
  const toRemove = resolved.filter((p) => remove.includes(p.key));

  // REVOKE-2, as on DELETE: only a removal that lands counts.
  const strippingSuperuser = toRemove.some((r) => r.key === SUPERADMIN_PERMISSION);
  const outcome = await db.transaction().execute(async (trx) => {
    if (strippingSuperuser && (await wouldStripLastGlobalSuperuser({ roleIds: [id] }, trx))) {
      return "last_superadmin" as const;
    }
    const inserted =
      toAdd.length > 0
        ? await trx
            .insertInto("app_role_permissions")
            .values(toAdd.map((p) => ({ role_id: id, permission_id: p.id })))
            .onConflict((oc) => oc.doNothing())
            .returning("permission_id")
            .execute()
        : [];
    const deleted =
      toRemove.length > 0
        ? await trx
            .deleteFrom("app_role_permissions")
            .where("role_id", "=", id)
            .where(
              "permission_id",
              "in",
              toRemove.map((p) => p.id),
            )
            .returning("permission_id")
            .execute()
        : [];
    return { inserted, deleted, resulting: await currentPermissionKeys(id, trx) };
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
        added: toAdd.map((p) => p.key).sort(),
        removed: toRemove.map((p) => p.key).sort(),
      },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  await auditRoleAction("admin.role.permissions_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: role.organization_id,
    metadata: {
      roleId: id,
      key: role.key,
      added: appliedKeys(outcome.inserted, resolved),
      removed: appliedKeys(outcome.deleted, resolved),
      resulting: outcome.resulting,
    },
  });

  return NextResponse.json({ ok: true, permissions: outcome.resulting });
});
