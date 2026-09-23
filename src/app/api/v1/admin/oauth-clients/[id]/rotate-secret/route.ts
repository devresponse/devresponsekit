import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { getOauthClientById, rotateOauthClientSecret } from "@/lib/api-auth/oauth-clients.server";
import {
  canAccessOrg,
  ownerOutranksActor,
  userHoldsSuperuserGrant,
} from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { unissuableScopes } from "@/lib/api-auth/issuance";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/admin/oauth-clients/[id]/rotate-secret
 *
 * Issues a new client secret in place (`admin.clients.manage`). The new
 * secret is returned ONCE; the old one stops working immediately.
 *
 * Reissuing a client whose SERVICE PRINCIPAL is a superuser is refused with
 * `403` for any caller that is not an unbound superadmin (MACHINE-2 layer 2) —
 * see the bound below.
 *
 * The client's scopes must also pass the shared issuance rule
 * ({@link unissuableScopes}, F-01), or `403 invalid_scope`: the new secret
 * carries the client's existing scopes to the caller, so a caller holding only
 * `admin.clients.manage` must not rotate another agent's broader client (or a
 * client carrying another principal's account-writing scopes) and receive it.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return problemResponse("invalid_request", 400, request);
  const client = await getOauthClientById(id);
  if (!client || !canAccessOrg(grant.caller.access, client.organization_id)) {
    return problemResponse("not_found", 404, request);
  }

  // Service-principal REACH bound (MACHINE-2, layer 2) — the twin of the bound
  // on `POST /api/v1/admin/oauth-clients`, and the exact shape of the one on
  // `POST /api/administrator/api-keys/[id]/rotate`: a rotation IS an on-behalf
  // issuance, because it reissues a credential that authenticates as SOMEONE
  // ELSE and hands the new plaintext to the actor.
  //
  // It is the SOFTER target of the pair. The sibling PATCH on `[id]` runs
  // `ungrantableScopesForCaller` before it lets the scopes change; a rotation
  // carries the client's existing scopes forward verbatim, so it never passes
  // through that bound at all. Without this an org admin holding only
  // `admin.clients.manage` could rotate any superuser-owned client in their own
  // org, pocket the new `clientSecret`, exchange it at `/api/v1/auth/token`, and
  // wield that superuser's full authority inside the tenant — authority they
  // never held. (Layer 1 caps the resulting token to the bound org, so this is
  // a within-tenant identity+scope escalation rather than a platform-wide one;
  // it is still precisely what layer 2 exists to refuse.)
  //
  // `userHoldsSuperuserGrant` (not `isSuperadmin` on a resolved context)
  // because all we hold here is the principal's `app_user_id`, and the rank
  // check must not depend on which org happens to resolve for them. It is the
  // RANK predicate, not `userIsGlobalSuperuser` (AUTHORITY), and deliberately
  // so (F-09): a grant sleeping in a suspended org confers nothing today, but
  // it wakes when that org is reactivated, and the secret reissued now would
  // then authenticate as a platform superuser inside this org.
  if (
    ownerOutranksActor(
      await userHoldsSuperuserGrant(client.app_user_id),
      grant.caller.access,
      grant.caller.grantedScopes,
    )
  ) {
    await auditEvent({
      eventType: "oauth_client.secret_rotate_denied",
      outcome: "denied",
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: client.app_user_id,
      organizationId: client.organization_id,
      reason: "service_principal_outranks_actor",
      request,
      requestId: grant.requestId,
      metadata: { clientRowId: id },
    });
    return problemResponse("forbidden", 403, request, {
      detail: "You cannot rotate the secret of a client whose service principal outranks you.",
      requestId: grant.requestId,
    });
  }

  // Scope bound (F-01) — the reach bound above only covered SUPERUSER
  // principals; rotating ANY client hands its scope set to the caller.
  // An inactive client answers 409 whatever its scopes — never a scope denial.
  if (client.status !== "active") {
    return problemResponse("conflict", 409, request, {
      detail: "Client is not active.",
      requestId: grant.requestId,
    });
  }
  const unissuable = unissuableScopes({
    issuer: {
      appUserId: grant.caller.access.appUserId,
      permissions: grant.caller.access.permissions,
      grantedScopes: grant.caller.grantedScopes,
      impersonatorId: grant.caller.impersonatorId,
    },
    ownerAppUserId: client.app_user_id,
    scopes: client.scopes,
  });
  if (unissuable.length > 0) {
    await auditEvent({
      eventType: "oauth_client.secret_rotate_denied",
      outcome: "denied",
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: client.app_user_id,
      organizationId: client.organization_id,
      reason: "scope_not_grantable",
      request,
      requestId: grant.requestId,
      metadata: { clientRowId: id, ungrantableScopes: unissuable },
    });
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot rotate the secret of a client carrying scopes you cannot grant.",
      extra: { ungrantableScopes: unissuable },
      requestId: grant.requestId,
    });
  }

  const secret = await rotateOauthClientSecret(id);
  if (!secret) {
    return problemResponse("conflict", 409, request, {
      detail: "Client is not active.",
      requestId: grant.requestId,
    });
  }

  await auditEvent({
    eventType: "oauth_client.secret_rotated",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: client.app_user_id,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: id },
  });

  return v1JsonResponse({ id, clientId: client.client_id, clientSecret: secret }, request, {
    requestId: grant.requestId,
  });
}
