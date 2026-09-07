import type { NextRequest } from "next/server";
import { requireApiAccount } from "@/lib/account/guard.server";
import { scopesAuthorize } from "@/lib/api-auth/scopes";
import { v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me
 *
 * Returns the authenticated caller's own identity + effective authority
 * (design §8.2). Works for any credential type. The `effectiveScopes`
 * field reflects what THIS credential can do (its scopes intersected with
 * the principal's permissions), which is what clients should introspect
 * before attempting a scoped call.
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiAccount(request, "account.read");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  const permissions = actor.access.permissions;
  // review #46: introspection MUST answer with the same rule the guards
  // enforce. A literal `.includes` ignored the `prefix.*` wildcard sugar every
  // guard honours via `scopesAuthorize`, so a caller holding `admin.users.*`
  // was told it could do nothing while the API happily served it. Reuse the
  // authorization predicate itself (never a second implementation) — it also
  // folds in the `grantedScopes === null` (cookie = full authority) case.
  const effectiveScopes = permissions.filter((p) => scopesAuthorize(actor.grantedScopes, p));

  return v1JsonResponse(
    {
      betterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      email: actor.access.primaryEmail,
      status: actor.access.status,
      organizationId: actor.access.organizationId,
      preferredLocale: actor.access.preferredLocale,
      authentication: { kind: actor.callerKind, credentialId: actor.credentialId },
      permissions,
      grantedScopes: actor.grantedScopes,
      effectiveScopes,
    },
    request,
  );
}
