import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { createApiKeySchema } from "@/lib/validation/api-keys";
import { auditEvent } from "@/lib/audit.server";
import { getUserAccessContext, decideSecureAccess } from "@/lib/auth-status";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  likeContains,
  buildListResponse,
  executeListWithTotal,
  offsetFor,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  isSuperadmin,
  ownerOutranksActor,
  resolveOrgScope,
} from "@/lib/admin/access-scope.server";
import { createApiKey } from "@/lib/api-auth/api-keys.server";
import { normalizeScopes, ungrantableScopes } from "@/lib/api-auth/scopes";
import { unissuableScopes } from "@/lib/api-auth/issuance";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Administrator API-key governance console
 * (docs/admin-manager.md §8.8).
 *
 * This is the cookie-session, permission-gated counterpart to the
 * machine `/api/v1/admin/api-keys` surface: it powers the Administrator
 * workspace grid and never returns the secret or its hash. Only the
 * non-secret summary columns plus the resolved owner email are exposed.
 *
 * `created_at` is ambiguous across the `app_api_keys`/`app_users` join,
 * so sort fields are mapped to fully-qualified columns rather than passed
 * to the generic `applySortAndPagination` (which would emit an
 * unqualified `order by`).
 */
const SORT_COLUMNS: Record<string, string> = {
  created_at: "k.created_at",
  name: "k.name",
  status: "k.status",
  last_used_at: "k.last_used_at",
  expires_at: "k.expires_at",
};

/**
 * GET /api/administrator/api-keys
 *
 * Paginated, sortable listing of every API key across users and
 * organizations. Caller MUST hold `admin.apikeys.read`.
 *
 * Filters: `filter[status]` (`active` | `revoked`),
 * `filter[app_user_id]`, `filter[organization_id]`. `q` matches
 * case-insensitively against the key name, display prefix, and owner
 * email.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.apikeys.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: Object.keys(SORT_COLUMNS),
    allowedFilters: ["status", "app_user_id", "organization_id"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  // Org boundary (ADR-0001): SUPERADMIN sees every org; an ORG ADMIN is
  // confined to their own org. A null scope (org admin with no org) lists
  // nothing.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json(buildListResponse([], 0, query));

  let base = db.selectFrom("app_api_keys as k").leftJoin("app_users as u", "u.id", "k.app_user_id");

  if (scope.kind === "org") {
    base = base.where("k.organization_id", "=", scope.organizationId);
  }

  const statusFilter = query.filters.status;
  if (statusFilter === "active" || statusFilter === "revoked") {
    base = base.where("k.status", "=", statusFilter);
  }

  const ownerFilter = query.filters.app_user_id;
  if (typeof ownerFilter === "string" && ownerFilter.length > 0) {
    base = base.where("k.app_user_id", "=", ownerFilter);
  }

  const orgFilter = query.filters.organization_id;
  if (typeof orgFilter === "string" && orgFilter.length > 0) {
    base = base.where("k.organization_id", "=", orgFilter);
  }

  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) =>
      eb.or([
        eb("k.name", "ilike", like),
        eb("k.key_prefix", "ilike", like),
        eb("u.primary_email", "ilike", like),
      ]),
    );
  }

  let itemsQuery = base.select([
    "k.id",
    "k.app_user_id",
    "u.primary_email as owner_email",
    "u.display_name as owner_name",
    "k.organization_id",
    "k.name",
    "k.key_prefix",
    "k.scopes",
    "k.status",
    "k.expires_at",
    "k.last_used_at",
    "k.last_used_ip",
    "k.created_at",
    "k.revoked_at",
    "k.revoked_reason",
  ]);
  for (const s of query.sort) {
    const column = SORT_COLUMNS[s.field];
    if (column) itemsQuery = itemsQuery.orderBy(sql.ref(column), s.direction);
  }
  itemsQuery = itemsQuery.limit(query.pageSize).offset(offsetFor(query));

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * POST /api/administrator/api-keys
 *
 * Issues an API key ON BEHALF OF a user. Caller MUST hold
 * `admin.apikeys.manage`. The plaintext is returned EXACTLY ONCE.
 *
 * Threat / contract:
 *   - The owner must exist and have an `active` access decision.
 *   - The requested scopes are validated against BOTH bounds:
 *     - the OWNER's authority ({@link ungrantableScopes}), so an
 *       admin-minted key can never out-scope the user who will wield it;
 *     - AND the shared issuance rule ({@link unissuableScopes}): the acting
 *       admin's own grantable authority, so an `admin.apikeys.manage` holder
 *       cannot mint an on-behalf key carrying a more-privileged co-member's
 *       (or a superuser owner's) permissions and escalate past their own
 *       authority by pocketing the plaintext; and no account-WRITING scope
 *       on a key for another person (F-01). The same rule bounds every other
 *       issuance path, rotations included.
 *     - AND the owner's org REACH ({@link ownerOutranksActor}, MACHINE-2): a
 *       non-superadmin may not mint on behalf of a SUPERUSER owner at all,
 *       whatever the scopes. Scope names alone never bounded reach.
 *   - Unknown scopes are rejected.
 */

export async function POST(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.apikeys.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apikeys.create",
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

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }
  const parsed = createApiKeySchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request, { requestId: guard.requestId });
  }
  const input = parsed.data;

  const owner = await db
    .selectFrom("app_users")
    .select(["id", "better_auth_user_id"])
    .where("id", "=", input.ownerAppUserId)
    .executeTakeFirst();
  if (!owner) {
    return adminErrorResponse("owner_not_found", 404, request, { requestId: guard.requestId });
  }

  const ownerAccess = await getUserAccessContext(owner.better_auth_user_id);
  if (decideSecureAccess(ownerAccess.status, ownerAccess.membershipStatus) !== "allow") {
    return adminErrorResponse("owner_inactive", 409, request, { requestId: guard.requestId });
  }

  // ADR-0001: an org admin may only issue keys for a user in their own
  // org. 404 (as "owner_not_found") avoids confirming the user exists.
  if (!canAccessOrg(guard.access, ownerAccess.organizationId)) {
    return adminErrorResponse("owner_not_found", 404, request, { requestId: guard.requestId });
  }

  const scopes = normalizeScopes(input.scopes);

  // Bound 1 — the minted key authenticates AS the owner, so it must never
  // carry a scope the owner does not hold (a key can't out-scope its wielder).
  const ownerUngrantable = ungrantableScopes(ownerAccess.permissions, scopes);
  if (ownerUngrantable.length > 0) {
    return adminErrorResponse("invalid_scope", 422, request, {
      requestId: guard.requestId,
      extra: { ungrantableScopes: ownerUngrantable },
    });
  }

  // Bound 2 — the acting admin may only confer scopes they can grant
  // themselves. Without this, an `admin.apikeys.manage` holder could mint an
  // on-behalf key carrying a more-privileged co-member's authority (up to a
  // superuser owner's) and wield the returned plaintext, escalating past
  // their own permissions. For a cookie admin `grantedScopes` is null (full
  // user authority); a superadmin holds every permission so this is a no-op
  // for them.
  //
  // The shared issuance rule also refuses the account-WRITING scopes here
  // unless the owner is the actor (F-01): they act on the OWNER's own account,
  // and an on-behalf key carrying `account.apikeys.manage` let the actor rotate
  // the owner's keys in other tenants through `/api/v1/me/api-keys`.
  const actorUngrantable = unissuableScopes({
    issuer: {
      appUserId: actorAppUserId,
      permissions: guard.access.permissions,
      grantedScopes: guard.grantedScopes,
      impersonatorId: guard.impersonatorId,
    },
    ownerAppUserId: owner.id,
    scopes,
  });
  if (actorUngrantable.length > 0) {
    return adminErrorResponse("invalid_scope", 422, request, {
      requestId: guard.requestId,
      extra: { ungrantableScopes: actorUngrantable },
    });
  }

  // Bound 3 — the owner's org REACH (MACHINE-2, layer 2). Bounds 1 and 2
  // constrain only WHICH SCOPE NAMES may ride along; neither says anything
  // about how far the resulting credential can see. A global superuser's reach
  // is every tenant, so an org admin holding `admin.apikeys.manage` who shares
  // an org with any superuser — support staff parked in a customer tenant, or
  // the seeded default admin — could mint a key on that superuser's behalf
  // using only scopes they themselves hold (passing both bounds), pocket the
  // one-time plaintext, and administer the whole platform with it.
  //
  // Layer 1 already confines such a key to its bound org at USE time, so this
  // is defence in depth — but it is also the difference between a 403 the
  // caller can act on and a credential that silently does less than they asked
  // for. A superadmin actor is exempt: they already hold every power, so they
  // are conferring nothing they lack — but only a COOKIE superadmin, per the
  // P1-1 rule inside `ownerOutranksActor`: a superuser-OWNED key is not itself
  // superuser authority.
  //
  // The owner's rank is `isSuperadmin(ownerAccess)` here, where the `[id]/rotate`
  // twin uses `userIsGlobalSuperuser(app_user_id)`. That asymmetry is
  // deliberate, and this is the BROADER of the two: `userIsGlobalSuperuser`
  // joins `app_user_roles` only, so it does not see a `superuser` marker
  // conferred through a GROUP (ADR-0002: app_group_memberships → app_group_roles),
  // whereas `ownerAccess.permissions` is the UNION of direct and group-conferred
  // roles and then folds in `userIsGlobalSuperuser` anyway (auth-status.ts).
  // So `isSuperadmin(ownerAccess)` ⊇ `userIsGlobalSuperuser(owner)` — do NOT
  // "harmonize" this to the rotate twin's primitive; that would WEAKEN the very
  // bound that closes the reported exploit. The rotate paths hold only an
  // `app_user_id` and no resolved context, which is why they use the narrower
  // one; the residual gap there is a group-conferred marker.
  //
  // `ownerAccess` resolves via the cookie path, so WHICH org the owner resolves
  // in follows the actor's `active_org`. That is sound only because the
  // `owner_inactive` 409 above guarantees an active membership resolved at all
  // (an empty context would make `isSuperadmin` vacuously false) — keep that
  // check before this one.
  if (ownerOutranksActor(isSuperadmin(ownerAccess), guard.access, guard.grantedScopes)) {
    await auditEvent({
      eventType: "admin.api_key.create_denied",
      outcome: "denied",
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: owner.id,
      organizationId: ownerAccess.organizationId,
      reason: "owner_outranks_actor",
      request,
      requestId: guard.requestId,
      metadata: { ownerAppUserId: owner.id, scopes },
    });
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const env = getServerEnv();
  const ttlDays = input.expiresInDays ?? env.API_KEY_DEFAULT_TTL_DAYS ?? null;
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : null;

  const created = await createApiKey({
    ownerAppUserId: owner.id,
    organizationId: ownerAccess.organizationId,
    name: input.name,
    scopes,
    expiresAt,
    createdByAppUserId: actorAppUserId,
  });

  await auditEvent({
    eventType: "admin.api_key.created",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: owner.id,
    organizationId: ownerAccess.organizationId,
    request,
    requestId: guard.requestId,
    // NEVER the plaintext or hash — only non-secret metadata.
    metadata: {
      apiKeyId: created.id,
      ownerAppUserId: owner.id,
      scopes,
      prefix: created.key_prefix,
    },
  });

  return NextResponse.json(
    {
      id: created.id,
      name: created.name,
      prefix: created.key_prefix,
      scopes: created.scopes,
      expiresAt: created.expires_at,
      // Shown ONCE — persist it now, it cannot be retrieved again.
      key: created.plaintext,
    },
    { status: 201 },
  );
}
