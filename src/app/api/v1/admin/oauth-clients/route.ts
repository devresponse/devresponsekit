import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { createOauthClient, listOauthClients } from "@/lib/api-auth/oauth-clients.server";
import { IssuingCredentialRevokedError } from "@/lib/api-auth/issuance-fence.server";
import { normalizeScopes } from "@/lib/api-auth/scopes";
import { unissuableScopes } from "@/lib/api-auth/issuance";
import {
  ownerOutranksActor,
  resolveOrgScope,
  userHasMembershipInOrg,
  userHoldsSuperuserGrant,
} from "@/lib/admin/access-scope.server";
import { offsetFor, parseListQuery } from "@/lib/admin/list-query.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";
import { withV1Route } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/oauth-clients — list registrations (`admin.clients.read`).
 */
export const GET = withV1Route(async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.clients.read");
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  // review #47 (sibling of the api-keys listing): same shared list-query
  // parser, so `page`/`pageSize` are integer-parsed and clamped instead of
  // reaching the SQL LIMIT/OFFSET as a fraction or an overflowed float.
  const query = parseListQuery(sp, {
    allowedSortFields: [],
    maxPageSize: 200,
    defaultPageSize: 25,
  });
  const { page, pageSize } = query;
  const status = sp.get("status");

  // Org boundary (ADR-0001): org admin → their org only; superadmin → all.
  const scope = resolveOrgScope(guard.grant.caller.access);
  if (!scope) return v1JsonResponse({ items: [], page, pageSize, total: 0 }, request);

  const { items, total } = await listOauthClients({
    limit: pageSize,
    offset: offsetFor(query),
    status: status === "active" || status === "revoked" ? status : undefined,
    organizationId: scope.kind === "org" ? scope.organizationId : undefined,
  });

  return v1JsonResponse({ items, page, pageSize, total }, request);
});

/**
 * POST /api/v1/admin/oauth-clients — register a machine identity
 * (`admin.clients.manage`). Returns the client secret ONCE.
 *
 * The client borrows `serviceAppUserId`'s authority intersected with
 * `scopes`; that service user must already exist (provision it via
 * `/api/v1/users` first). The admin may only grant scopes they themselves
 * hold (design §7), and may not register a client for a service principal that
 * OUTRANKS them — a superuser principal is refused to a non-superadmin actor
 * (MACHINE-2). The account-writing scopes are refused unless the service
 * principal is the caller themselves (F-01; see `src/lib/api-auth/issuance.ts`).
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.string().min(1).max(120)).max(64).default([]),
    serviceAppUserId: z.string().refine(isUuid, "invalid_uuid"),
    organizationId: z.string().refine(isUuid, "invalid_uuid").nullable().optional(),
  })
  .strict();

export const POST = withV1Route(async function POST(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }

  // The service principal must exist as an app user.
  const serviceUser = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("id", "=", parsed.data.serviceAppUserId)
    .executeTakeFirst();
  if (!serviceUser) {
    return problemResponse("invalid_request", 400, request, {
      detail: "serviceAppUserId does not reference an existing user.",
      requestId: grant.requestId,
    });
  }

  // Org boundary (ADR-0001). Org admin: the client is created in THEIR org
  // and the service principal must belong to it; the client-supplied
  // organizationId is ignored. Superadmin: may target any org.
  const scope = resolveOrgScope(grant.caller.access);
  if (!scope) {
    return problemResponse("forbidden", 403, request, { requestId: grant.requestId });
  }
  let organizationId: string | null;
  if (scope.kind === "org") {
    organizationId = scope.organizationId;
    const serviceInOrg = await userHasMembershipInOrg(
      parsed.data.serviceAppUserId,
      scope.organizationId,
    );
    if (!serviceInOrg) {
      return problemResponse("invalid_request", 400, request, {
        detail: "serviceAppUserId does not reference an existing user.",
        requestId: grant.requestId,
      });
    }
  } else {
    organizationId = parsed.data.organizationId ?? null;
  }

  const scopes = normalizeScopes(parsed.data.scopes);
  const ungrantable = unissuableScopes({
    issuer: {
      appUserId: grant.caller.access.appUserId,
      permissions: grant.caller.access.permissions,
      grantedScopes: grant.caller.grantedScopes,
      impersonatorId: grant.caller.impersonatorId,
    },
    ownerAppUserId: serviceUser.id,
    scopes,
  });
  if (ungrantable.length > 0) {
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot grant scopes you do not hold.",
      extra: { ungrantableScopes: ungrantable },
      requestId: grant.requestId,
    });
  }

  // Service-principal REACH bound (MACHINE-2, layer 2) — the twin of the bound
  // on `POST /api/administrator/api-keys`. The registration above constrains
  // which SCOPE NAMES the client may carry, but the client BORROWS
  // `serviceAppUserId`'s identity, and a global superuser's identity reaches
  // every tenant. Without this, an org admin holding `admin.clients.manage`
  // could register a client against a superuser co-member using only scopes
  // they themselves hold, take the one-time `clientSecret`, exchange it at
  // `/api/v1/auth/token`, and administer the platform.
  //
  // Refused rather than silently narrowed: layer 1 caps the resulting tokens to
  // the client's bound org, so a caller who got a 201 here would receive a
  // credential that quietly does less than they asked for.
  //
  // The principal's rank is read with `userHoldsSuperuserGrant`, not
  // `userIsGlobalSuperuser` (F-09): a grant sleeping in a suspended org confers
  // no authority today, but it wakes when that org is reactivated, and the
  // client registered now would then authenticate as a platform superuser.
  if (
    ownerOutranksActor(
      await userHoldsSuperuserGrant(parsed.data.serviceAppUserId),
      grant.caller.access,
      grant.caller.grantedScopes,
    )
  ) {
    await auditEvent({
      eventType: "oauth_client.create_denied",
      outcome: "denied",
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: parsed.data.serviceAppUserId,
      organizationId,
      reason: "service_principal_outranks_actor",
      request,
      requestId: grant.requestId,
      metadata: { scopes },
    });
    return problemResponse("forbidden", 403, request, {
      detail: "You cannot register a client for a service principal that outranks you.",
      requestId: grant.requestId,
    });
  }

  // F-10: behind the issuance fence. A password reset or set that revokes the
  // acting credential while this runs either revokes a client bound to that
  // account too or refuses the registration here.
  let created;
  try {
    created = await createOauthClient({
      name: parsed.data.name,
      scopes,
      organizationId,
      serviceAppUserId: parsed.data.serviceAppUserId,
      createdByAppUserId: grant.caller.access.appUserId ?? parsed.data.serviceAppUserId,
      issuedVia: grant.caller.source ?? null,
    });
  } catch (error) {
    if (!(error instanceof IssuingCredentialRevokedError)) throw error;
    await auditEvent({
      eventType: "oauth_client.create_denied",
      outcome: "denied",
      actorBetterAuthUserId: grant.caller.betterAuthUserId,
      appUserId: parsed.data.serviceAppUserId,
      organizationId,
      reason: "issuing_credential_revoked",
      request,
      requestId: grant.requestId,
      metadata: { callerKind: grant.caller.kind },
    });
    return problemResponse("credential_revoked", 401, request, {
      detail: "The credential this request authenticated with was revoked while it ran.",
      requestId: grant.requestId,
      headers: { "WWW-Authenticate": 'Bearer realm="devresponse-api", error="invalid_token"' },
    });
  }

  await auditEvent({
    eventType: "oauth_client.created",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: parsed.data.serviceAppUserId,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: created.id, clientId: created.client_id, scopes },
  });

  return v1JsonResponse(
    {
      id: created.id,
      clientId: created.client_id,
      name: created.name,
      scopes: created.scopes,
      // Shown ONCE.
      clientSecret: created.clientSecret,
    },
    request,
    { status: 201, requestId: grant.requestId },
  );
});
