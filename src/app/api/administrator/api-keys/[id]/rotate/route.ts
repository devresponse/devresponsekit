import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  ownerOutranksActor,
  userHoldsSuperuserGrant,
} from "@/lib/admin/access-scope.server";
import { rotateApiKey } from "@/lib/api-auth/api-keys.server";
import { unissuableScopes } from "@/lib/api-auth/issuance";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/administrator/api-keys/:id/rotate
 *
 * Rotates an API key: issues a fresh secret with the same owner, scopes,
 * and expiry, then revokes the old key — atomically. Caller MUST hold
 * `admin.apikeys.manage`. The new plaintext is returned EXACTLY ONCE.
 *
 * Only `active` keys can be rotated; rotating a missing key returns
 * `404`, an already-revoked key returns `409`.
 *
 * Reissuing on behalf of a SUPERUSER owner is refused with `403` for a
 * non-superadmin actor (MACHINE-2) — see the bound below.
 *
 * The key's scopes must also be ones the actor could grant on a fresh
 * on-behalf mint ({@link unissuableScopes}, F-01): otherwise `403
 * invalid_scope`. Rotation carries the ORIGINAL scopes forward and hands the
 * plaintext to the actor, so without it an org admin holding only
 * `admin.apikeys.manage` could rotate a co-member's `admin.users.*` key — or
 * any key carrying an account-writing scope — and receive it.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apikeys.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apikeys.rotate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const actorAppUserId = guard.access.appUserId;
  if (!actorAppUserId) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }

  const existing = await db
    .selectFrom("app_api_keys")
    .select(["id", "app_user_id", "status", "organization_id", "scopes"])
    .where("id", "=", id)
    .executeTakeFirst();
  // ADR-0001: org admins may only rotate their own org's keys.
  if (!existing || !canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("api_key_not_found", 404, request, { requestId: guard.requestId });
  }
  if (existing.status !== "active") {
    return adminErrorResponse("api_key_inactive", 409, request, { requestId: guard.requestId });
  }

  // Owner-reach bound (MACHINE-2, layer 2) — the same rule the on-behalf mint
  // enforces, because a rotation IS an on-behalf issuance: it reissues a
  // credential that authenticates as SOMEONE ELSE and returns the new plaintext
  // to the actor. It is in fact the softer target of the two: rotation carries
  // the ORIGINAL key's scopes forward verbatim, so it never passed through
  // `ungrantableScopesForCaller` and an org admin holding only
  // `admin.apikeys.manage` could hand themselves a superuser co-member's
  // fully-scoped key without holding a single one of those scopes.
  //
  // `userHoldsSuperuserGrant` (not `isSuperadmin` on a resolved context)
  // because all we hold here is the owner's `app_user_id`, and the rank check
  // must not depend on which org happens to resolve for them. It is the RANK
  // predicate, not `userIsGlobalSuperuser` (AUTHORITY), and deliberately so
  // (F-09): a grant sleeping in a suspended org confers nothing today, but it
  // wakes when that org is reactivated, and the key reissued now would then
  // authenticate as a platform superuser inside this org.
  if (
    ownerOutranksActor(
      await userHoldsSuperuserGrant(existing.app_user_id),
      guard.access,
      guard.grantedScopes,
    )
  ) {
    await auditEvent({
      eventType: "admin.api_key.rotate_denied",
      outcome: "denied",
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: existing.app_user_id,
      organizationId: existing.organization_id,
      reason: "owner_outranks_actor",
      request,
      requestId: guard.requestId,
      metadata: { apiKeyId: id },
    });
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  // Scope bound (F-01) — rotation IS issuance, so the successor's scope set
  // (the original, carried forward verbatim) must pass the same rule a fresh
  // on-behalf mint does. The reach bound above only ever covered SUPERUSER
  // owners; this covers every owner.
  const unissuable = unissuableScopes({
    issuer: {
      appUserId: actorAppUserId,
      permissions: guard.access.permissions,
      grantedScopes: guard.grantedScopes,
      impersonatorId: guard.impersonatorId,
    },
    ownerAppUserId: existing.app_user_id,
    scopes: existing.scopes,
  });
  if (unissuable.length > 0) {
    await auditEvent({
      eventType: "admin.api_key.rotate_denied",
      outcome: "denied",
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: existing.app_user_id,
      organizationId: existing.organization_id,
      reason: "scope_not_grantable",
      request,
      requestId: guard.requestId,
      metadata: { apiKeyId: id, ungrantableScopes: unissuable },
    });
    return adminErrorResponse("invalid_scope", 403, request, {
      requestId: guard.requestId,
      extra: { ungrantableScopes: unissuable },
    });
  }

  const rotated = await rotateApiKey(id, actorAppUserId);
  if (!rotated) {
    // Lost a race with a concurrent revoke/rotate — surface as inactive.
    return adminErrorResponse("api_key_inactive", 409, request, { requestId: guard.requestId });
  }

  await auditEvent({
    eventType: "admin.api_key.rotated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: existing.app_user_id,
    request,
    requestId: guard.requestId,
    metadata: { rotatedFromApiKeyId: id, apiKeyId: rotated.id, prefix: rotated.key_prefix },
  });

  return NextResponse.json(
    {
      id: rotated.id,
      rotatedFrom: id,
      name: rotated.name,
      prefix: rotated.key_prefix,
      scopes: rotated.scopes,
      expiresAt: rotated.expires_at,
      // Shown ONCE — persist it now, it cannot be retrieved again.
      key: rotated.plaintext,
    },
    { status: 201 },
  );
}
