import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { getCurrentSession } from "@/lib/auth-guard";
import {
  decideSecureAccess,
  getUserAccessContext,
  type UserAccessContext,
} from "@/lib/auth-status";

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
}

export type AccountGuardResult =
  | { ok: true; actor: AccountActor }
  | { ok: false; response: NextResponse };

export async function requireAccountUser(request: NextRequest): Promise<AccountGuardResult> {
  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: origin.reason ?? "untrusted_origin" }, { status: 403 }),
    };
  }

  const session = await getCurrentSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }

  const access = await getUserAccessContext(session.user.id);
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (!access.appUserId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "not_provisioned" }, { status: 403 }),
    };
  }

  return {
    ok: true,
    actor: { betterAuthUserId: session.user.id, appUserId: access.appUserId, access },
  };
}
