import "server-only";
import { type NextRequest, type NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { type UserAccessContext } from "@/lib/auth-status";
import { decideSecureAccess } from "@/lib/auth-status";
import {
  hasBearerCredential,
  resolveCaller,
  type CallerKind,
} from "@/lib/api-auth/resolve-caller.server";
import { scopesAuthorize } from "@/lib/api-auth/scopes";

/**
 * Shared authorization gate for the self-service Account API
 * (`/api/account/*`).
 *
 * Resolves the CURRENT user from the session and guarantees an active
 * secure member, returning the resolved actor or an error `NextResponse`.
 * It deliberately exposes ONLY the caller's own identity (`appUserId`,
 * Better Auth `userId`) — account routes must scope every write to these
 * values and never accept an id from the request body, which is what
 * keeps the surface free of IDOR.
 *
 * On unsafe methods (POST/PUT/PATCH/DELETE) it also enforces the
 * trusted-origin CSRF check, mirroring the administrator mutation guard.
 * This is user-level: it requires no `admin.*` permission, only an active
 * session + active membership (`shell.view` is implied by membership).
 */
export interface AccountActor {
  betterAuthUserId: string;
  appUserId: string;
  access: UserAccessContext;
  callerKind: CallerKind;
  credentialId: string | null;
  /** The calling credential's scopes (null for cookies = full authority). */
  grantedScopes: string[] | null;
  /**
   * The impersonating admin's id when the session is an impersonation
   * session, else `null` (always `null` for bearer credentials). Lets a
   * route confine an impersonated session (P0-1 active-org contract) without
   * re-reading the session (review #28).
   */
  impersonatorId: string | null;
}

export type AccountGuardResult =
  { ok: true; actor: AccountActor } | { ok: false; response: NextResponse };

/**
 * @param requiredScope Account scope a BEARER credential must carry to be
 *   admitted (e.g. `account.profile.write`). Cookie sessions carry full
 *   user authority and ignore it. Omit for read-only entry points.
 */
export async function requireAccountUser(
  request: NextRequest,
  requiredScope?: string,
): Promise<AccountGuardResult> {
  // CSRF origin guard applies only to ambient (cookie) credentials; a
  // bearer token cannot be attached cross-site (design §10.3).
  // All failures use the shared first-party envelope (adminErrorResponse:
  // `{ error, message: "errors.<code>", requestId }` + x-request-id), so the
  // account/invitation surfaces answer identically to the admin one (P3-12) —
  // no route hand-rolls a bare `{ error }`. Both origin-guard reasons collapse
  // to the single cataloged `untrusted_origin` code.
  if (!hasBearerCredential(request.headers)) {
    const origin = checkTrustedOrigin(request);
    if (!origin.ok) {
      return { ok: false, response: adminErrorResponse("untrusted_origin", 403, request) };
    }
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    return { ok: false, response: adminErrorResponse("unauthenticated", 401, request) };
  }

  const { access } = caller;
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") {
    return { ok: false, response: adminErrorResponse("forbidden", 403, request) };
  }
  if (!access.appUserId) {
    return { ok: false, response: adminErrorResponse("not_provisioned", 403, request) };
  }
  // Bearer credentials must carry the required account scope. Cookie
  // callers have `grantedScopes === null` and pass unconditionally.
  if (requiredScope && !scopesAuthorize(caller.grantedScopes, requiredScope)) {
    return { ok: false, response: adminErrorResponse("insufficient_scope", 403, request) };
  }

  return {
    ok: true,
    actor: {
      betterAuthUserId: caller.betterAuthUserId,
      appUserId: access.appUserId,
      access,
      callerKind: caller.kind,
      credentialId: caller.credentialId,
      grantedScopes: caller.grantedScopes,
      impersonatorId: caller.impersonatorId,
    },
  };
}
