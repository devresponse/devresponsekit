import "server-only";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * F-07 — WHO ACTUALLY DID IT, for every audit row an impersonated session
 * writes.
 *
 * An impersonated session carries the BORROWED user's identity. Every guard
 * (`requireAdminPermission`, `requireApiPermission`, the account guard, the RSC
 * admin gate) resolves `betterAuthUserId` to the target, and some hundred call
 * sites audit `actorBetterAuthUserId: guard.betterAuthUserId`. So an admin who
 * impersonated a co-admin and then banned users, set passwords or approved
 * accounts left rows naming the co-admin and no trace of themselves beyond a
 * separate `impersonation_started` row to correlate by time and IP. The
 * documented contract (docs/admin-manager.md §12) is the opposite: the actor
 * is the ORIGINAL admin, never the impersonated user.
 *
 * Editing every call site would fix today's routes and leave the next one to
 * remember. Instead the SESSION READ records the impersonation against the
 * request's `Headers` object — the per-request carrier `getOrCreateRequestId`
 * and the session memo already key on — and `auditEvent` consults it for every
 * row that passes the request:
 *
 *   - `resolveCallerDetailed` records it on the route's `request.headers`, which
 *     covers every guard above and every audit a guarded route writes;
 *   - `getCurrentSession` records it on the ambient `headers()` store, which is
 *     the carrier the RSC admin gate audits its denials with;
 *   - the few routes that read the session themselves record it on their own
 *     `request` (navigation menus, invitation acceptance, SSO launch);
 *     `tests/unit/impersonation-attribution-invariant.test.ts` fails the build
 *     when a route reads the session directly and neither records it nor
 *     carries a reviewed reason not to.
 *
 * A `WeakMap`, so an entry dies with its request.
 *
 * Deliberately NOT a session read from inside `auditEvent`: that would run
 * Better Auth's session lookup, with its refresh side effects, from inside
 * Better Auth's own hooks, cron jobs and scripts, and `headers()` hangs during
 * a prerender. Only a request whose session was already resolved is
 * attributed, and that is every request in which an impersonated session can
 * act: nothing acts as the session user without first resolving it.
 */

/** The two identities behind one impersonated request. */
export interface RequestImpersonation {
  /** The borrowed identity: the user the session names. */
  impersonatedBetterAuthUserId: string;
  /** The human behind the session: Better Auth's `impersonatedBy`. */
  impersonatorBetterAuthUserId: string;
}

/** The request carrier as audit calls pass it (NextRequest, `{ headers }`, or `Headers`). */
export type RequestCarrier = { headers: Headers } | Headers;

const impersonationByHeaders = new WeakMap<object, RequestImpersonation>();

function carrierKey(carrier: RequestCarrier | null | undefined): object | null {
  if (!carrier) return null;
  const key = carrier instanceof Headers ? carrier : carrier.headers;
  return key !== null && typeof key === "object" ? key : null;
}

/**
 * Records that `carrier`'s request runs on an impersonated session. A no-op for
 * an ordinary session, a missing session, or a carrier without headers, so a
 * caller can pass whatever it resolved without checking first.
 */
export function noteSessionImpersonation(
  carrier: RequestCarrier | null | undefined,
  session: unknown,
): void {
  const key = carrierKey(carrier);
  if (!key) return;
  const impersonatorBetterAuthUserId = readImpersonatorId(session);
  if (!impersonatorBetterAuthUserId) return;
  const userId = (session as { user?: { id?: unknown } }).user?.id;
  if (typeof userId !== "string" || userId.length === 0) return;
  impersonationByHeaders.set(key, {
    impersonatedBetterAuthUserId: userId,
    impersonatorBetterAuthUserId,
  });
}

/** The impersonation recorded for `carrier`'s request, or `null` for an ordinary one. */
export function readRequestImpersonation(
  carrier: RequestCarrier | null | undefined,
): RequestImpersonation | null {
  const key = carrierKey(carrier);
  return key ? (impersonationByHeaders.get(key) ?? null) : null;
}

/**
 * The principal a per-actor key (a rate-limit bucket) is charged to: the HUMAN
 * when `actorId` is the borrowed identity of an impersonated request, else
 * `actorId` unchanged. Keyed on the borrowed id rather than applied blindly, so
 * a key built from anything else (an IP, a credential id) is left alone.
 */
export function humanActorFor(actorId: string, carrier?: RequestCarrier | null): string {
  const impersonation = readRequestImpersonation(carrier);
  return impersonation && impersonation.impersonatedBetterAuthUserId === actorId
    ? impersonation.impersonatorBetterAuthUserId
    : actorId;
}

/**
 * The human behind a resolved grant or actor: the impersonator when there is
 * one, else the principal itself. For the "who did it" values a route writes
 * directly, where `auditEvent` cannot correct them and the grant is already in
 * hand: the Better Auth user-id columns `deactivated_by`, an invitation's
 * `revoked_by` and a sign-up policy's `updated_by`, plus the test email's
 * `sentBy`. tests/security/impersonation-audit-attribution.test.ts pins each
 * column's route.
 */
export function humanActorId(principal: {
  betterAuthUserId: string;
  impersonatorId?: string | null;
}): string {
  return principal.impersonatorId ?? principal.betterAuthUserId;
}

/**
 * The attribution rule `auditEvent` applies to every row (F-07).
 *
 * On an impersonated request, a row whose actor is the borrowed identity — or
 * already the human, as the IMP-1/IMP-3 refusals write it — is attributed to
 * the HUMAN, and the borrowed identity is recorded in
 * `metadata.impersonatedBetterAuthUserId`: the shape the impersonation refusals
 * have always written, now true of every row. A row naming anyone else (a
 * system actor, the target of the action) or no one is left exactly as the
 * caller wrote it, since it describes a principal other than the session.
 */
export function attributeAuditActor(input: {
  actorBetterAuthUserId?: string | null;
  metadata?: Record<string, unknown>;
  request?: RequestCarrier;
}): { actorBetterAuthUserId: string | null; metadata: Record<string, unknown> | undefined } {
  const actor = input.actorBetterAuthUserId ?? null;
  const impersonation = readRequestImpersonation(input.request);
  if (
    !impersonation ||
    (actor !== impersonation.impersonatedBetterAuthUserId &&
      actor !== impersonation.impersonatorBetterAuthUserId)
  ) {
    return { actorBetterAuthUserId: actor, metadata: input.metadata };
  }
  return {
    actorBetterAuthUserId: impersonation.impersonatorBetterAuthUserId,
    // The session's own answer wins over anything the caller put under the
    // same key: it is what the request actually ran as.
    metadata: {
      ...input.metadata,
      impersonatedBetterAuthUserId: impersonation.impersonatedBetterAuthUserId,
    },
  };
}
