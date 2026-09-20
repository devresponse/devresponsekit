import "server-only";
import { type NextRequest, type NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
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
import { problemResponse } from "@/lib/api-auth/problem";

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
 *
 * IMP-1: it additionally refuses an IMPERSONATED session unless the route
 * passes `{ allowImpersonation: true }` — see {@link AccountAccessOptions} for
 * why that default is the safe one on a surface that mints and revokes
 * credentials.
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
 * Per-route options for the shared account decision.
 *
 * IMP-1 — the self-service surface is CLOSED TO IMPERSONATED SESSIONS BY
 * DEFAULT, and a route that wants to stay reachable while an administrator is
 * impersonating must say so explicitly. The default is the safe one on
 * purpose: this family is where credentials are MINTED, ROTATED and REVOKED,
 * and while impersonating, ownership checks all pass — the session simply IS
 * the target. An admin could therefore `POST /api/v1/me/api-keys/[id]/rotate`
 * on a key belonging to the person they borrowed, pocket the one-time
 * plaintext, and walk away with a standalone bearer credential carrying that
 * user's authority in that user's tenant — an impersonation laundered into a
 * credential that outlives it and is attributed to someone else. Revocation is
 * the same story in reverse: destroying another person's credentials or
 * sessions from inside their own account.
 *
 * Putting the default HERE rather than writing a check in each handler is the
 * point: the next self-service route to be added is refused until its author
 * decides otherwise, instead of inheriting the hole by omission.
 */
export interface AccountAccessOptions {
  /**
   * Admit an IMPERSONATED session to this route. Set it ONLY with a reason in
   * a comment at the call site, and only for surfaces that neither issue nor
   * destroy credentials — read-only introspection, or a route that applies its
   * own (narrower or differently-shaped) impersonation refusal.
   */
  allowImpersonation?: boolean;
}

/**
 * A rejection, expressed once and rendered per surface (review #45).
 *
 * The DECISION is surface-independent; only the wire envelope differs. Each
 * rejection therefore carries BOTH renderings — the first-party admin code
 * (`{ error, message: "errors.<code>", requestId }`) and the `/api/v1`
 * RFC 7807 code — so the two entry points can never drift apart in what they
 * admit, only in how they say no.
 */
interface AccountGuardRejection {
  /** Machine code for the first-party `{ error, message }` envelope. */
  adminCode: string;
  /** Documented `/api/v1` problem code (see `problem.ts` TITLES). */
  problemCode: string;
  status: number;
  /** Non-secret problem `detail`; keeps the reason the admin code carries. */
  detail?: string;
  /** Extra headers for the problem rendering (e.g. `WWW-Authenticate`). */
  headers?: Record<string, string>;
}

/** Matches the v1 guard's realm so a client sees ONE challenge vocabulary. */
const BEARER_REALM = 'Bearer realm="devresponse-api"';

/**
 * The shared account decision: active secure member, provisioned, and — for a
 * bearer credential — carrying `requiredScope`. Both public guards below wrap
 * this; nothing else may re-derive it.
 */
async function decideAccountAccess(
  request: NextRequest,
  requiredScope?: string,
  options: AccountAccessOptions = {},
): Promise<{ ok: true; actor: AccountActor } | { ok: false; rejection: AccountGuardRejection }> {
  // CSRF origin guard applies only to ambient (cookie) credentials; a
  // bearer token cannot be attached cross-site (design §10.3). Both
  // origin-guard reasons collapse to the single cataloged `untrusted_origin`
  // code.
  if (!hasBearerCredential(request.headers)) {
    const origin = checkTrustedOrigin(request);
    if (!origin.ok) {
      return {
        ok: false,
        rejection: {
          adminCode: "untrusted_origin",
          problemCode: "forbidden",
          status: 403,
          detail: "The request origin is not trusted.",
        },
      };
    }
  }

  const caller = await resolveCaller(request);
  if (!caller) {
    return {
      ok: false,
      rejection: {
        adminCode: "unauthenticated",
        problemCode: "unauthorized",
        status: 401,
        headers: { "WWW-Authenticate": BEARER_REALM },
      },
    };
  }

  const { access } = caller;
  if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") {
    return {
      ok: false,
      rejection: { adminCode: "forbidden", problemCode: "forbidden", status: 403 },
    };
  }
  if (!access.appUserId) {
    return {
      ok: false,
      rejection: {
        adminCode: "not_provisioned",
        problemCode: "forbidden",
        status: 403,
        detail: "The account is not provisioned.",
      },
    };
  }
  // IMP-1 — fail closed for an impersonated session unless the route opted in
  // (see {@link AccountAccessOptions}). `impersonatorId` is always null for a
  // bearer credential, so this only ever refuses a cookie session, and it is
  // evaluated AFTER the status checks so the reason reported is the most
  // specific true one. The denial is attributed to the HUMAN BEHIND the
  // session — the impersonating admin, not the borrowed identity — matching
  // `/api/sso/launch`, so the audit row names who actually tried.
  if (caller.impersonatorId && options.allowImpersonation !== true) {
    await auditEvent({
      eventType: "account.impersonated_access.denied",
      outcome: "denied",
      reason: "forbidden_while_impersonating",
      actorBetterAuthUserId: caller.impersonatorId,
      appUserId: access.appUserId,
      organizationId: access.organizationId,
      request,
      metadata: {
        impersonatedBetterAuthUserId: caller.betterAuthUserId,
        method: request.method,
        requiredScope: requiredScope ?? null,
      },
    });
    return {
      ok: false,
      rejection: {
        adminCode: "forbidden_while_impersonating",
        problemCode: "forbidden",
        status: 403,
        detail: "An impersonated session cannot perform this action.",
      },
    };
  }

  // Bearer credentials must carry the required account scope. Cookie
  // callers have `grantedScopes === null` and pass unconditionally.
  if (requiredScope && !scopesAuthorize(caller.grantedScopes, requiredScope)) {
    return {
      ok: false,
      rejection: {
        adminCode: "insufficient_scope",
        problemCode: "forbidden",
        status: 403,
        detail: "The credential lacks the required permission or scope.",
      },
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
      impersonatorId: caller.impersonatorId,
    },
  };
}

/**
 * FIRST-PARTY surfaces (`/api/account/*`, `/api/preferences/*`).
 *
 * All failures use the shared first-party envelope (adminErrorResponse:
 * `{ error, message: "errors.<code>", requestId }` + x-request-id), so the
 * account/invitation surfaces answer identically to the admin one (P3-12) —
 * no route hand-rolls a bare `{ error }`.
 *
 * @param requiredScope Account scope a BEARER credential must carry to be
 *   admitted (e.g. `account.profile.write`). Cookie sessions carry full
 *   user authority and ignore it. Omit for read-only entry points.
 * @param options Per-route exceptions — today only the IMP-1 impersonation
 *   opt-in (see {@link AccountAccessOptions}).
 */
export async function requireAccountUser(
  request: NextRequest,
  requiredScope?: string,
  options?: AccountAccessOptions,
): Promise<AccountGuardResult> {
  const decision = await decideAccountAccess(request, requiredScope, options);
  if (decision.ok) return { ok: true, actor: decision.actor };
  // The `WWW-Authenticate` challenge is a bearer-protocol affordance for the
  // v1 rendering only; the first-party envelope keeps its existing shape.
  const { adminCode, status } = decision.rejection;
  return { ok: false, response: adminErrorResponse(adminCode, status, request) };
}

/**
 * VERSIONED surface (`/api/v1/me*`) — same decision, `application/problem+json`
 * (review #45).
 *
 * `/api/v1` publishes ONE error contract (design §8.1, and the OpenAPI
 * document `$ref`s every 4xx at `components/responses/*` to the `Problem`
 * schema). The self-service v1 routes reused `requireAccountUser` and so
 * emitted the admin `{ error, message }` envelope on every rejection, which
 * contradicted the published spec and the generated SDK: a client that parsed
 * a problem document got `undefined` for `type`/`status`/`code`. This wrapper
 * renders the identical decision as a problem document, and adds the RFC 6750
 * `WWW-Authenticate` challenge on a 401 exactly like `requireApiPermission`.
 */
export async function requireApiAccount(
  request: NextRequest,
  requiredScope?: string,
  options?: AccountAccessOptions,
): Promise<AccountGuardResult> {
  const decision = await decideAccountAccess(request, requiredScope, options);
  if (decision.ok) return { ok: true, actor: decision.actor };
  const { problemCode, status, detail, headers } = decision.rejection;
  return {
    ok: false,
    response: problemResponse(problemCode, status, request, { detail, headers }),
  };
}
