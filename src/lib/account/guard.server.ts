import "server-only";
import { NextResponse, type NextRequest } from "next/server";
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
  if (!hasBearerCredential(request.headers)) {
    const origin = checkTrustedOrigin(request);
    if (!origin.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: origin.reason ?? "untrusted_origin" },
          { status: 403 },
        ),
      };
    }
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }

  const { access } = caller;
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (!access.appUserId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "not_provisioned" }, { status: 403 }),
    };
  }
  // Bearer credentials must carry the required account scope. Cookie
  // callers have `grantedScopes === null` and pass unconditionally.
  if (requiredScope && !scopesAuthorize(caller.grantedScopes, requiredScope)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "insufficient_scope" }, { status: 403 }),
    };
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
    },
  };
}
