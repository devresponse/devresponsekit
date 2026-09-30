import "server-only";
import { db } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { getUserAccessContext, decideSecureAccess } from "@/lib/auth-status";
import { ssoSessionTokenPrefix } from "@/lib/session-lifetime";
import {
  signSsoHandoff,
  clampSsoHandoffTtl,
  type SsoHandoffClaims,
} from "@/lib/jwt-handoff.server";

export interface CreateSsoHandoffRedirectInput {
  applicationId: string;
  betterAuthUserId: string;
}

interface SsoAccessContext {
  appUserId: string;
  email: string;
  organizationId: string;
  locale: string;
}

/**
 * Loads the SSO access context required to sign a handoff token.
 *
 * This function is the authorization gate for SSO launches: it fails when
 * the user does not have an active membership or lacks access to the
 * target application. The caller MUST treat any thrown error as a 403.
 */
async function loadSsoAccessContext(
  betterAuthUserId: string,
  targetApp: { organization_id: string | null },
): Promise<SsoAccessContext> {
  const access = await getUserAccessContext(betterAuthUserId);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    throw new Error(`sso_denied:${decision}`);
  }
  if (!access.appUserId || !access.organizationId || !access.primaryEmail) {
    throw new Error("sso_denied:missing_context");
  }

  // Verify access to the target application: either the application is
  // global (no organization_id) or it belongs to the user's organization.
  // F-09: `access.organizationId` is only ever an ACTIVE org (the resolver
  // ignores memberships in suspended, archived or pending tenants), so this
  // equality also refuses a launch into an app whose owning org is not active,
  // and a member of only such tenants never gets this far (`decision` above).
  if (targetApp.organization_id && targetApp.organization_id !== access.organizationId) {
    throw new Error("sso_denied:application_not_in_organization");
  }

  return {
    appUserId: access.appUserId,
    email: access.primaryEmail,
    organizationId: access.organizationId,
    locale: access.preferredLocale,
  };
}

/**
 * Creates a short-lived JWT handoff redirect URL for cross-subdomain SSO.
 *
 * Threat / contract:
 *   - JWT is at most 60 seconds, EdDSA-signed with this deployment's
 *     `SSO_HANDOFF_PRIVATE_KEY` (review #5); consumers verify against the
 *     public JWKS and hold no signing capability.
 *   - A one-time `jti` is persisted before signing so a replayed token
 *     can be detected by the consumer atomically.
 *   - The URL is returned to the route handler which then issues the
 *     redirect with `Referrer-Policy: no-referrer`.
 *   - Claims are minimised (review #60): the token rides in a query string,
 *     so it carries only `email`, `locale` and `targetApplicationId` beyond
 *     the registered claims. `organizationId`, `appUserId` and `roles[]` are
 *     NOT sent — no consumer reads them, and satellites resolve membership,
 *     roles and permissions from their own store.
 */
export async function createSsoHandoffRedirect(input: CreateSsoHandoffRedirectInput): Promise<URL> {
  const targetApp = await db
    .selectFrom("app_enterprise_applications")
    .selectAll()
    .where("id", "=", input.applicationId)
    .where("status", "=", "available")
    .executeTakeFirst();
  if (!targetApp) {
    throw new Error("sso_denied:application_unavailable");
  }

  const context = await loadSsoAccessContext(input.betterAuthUserId, targetApp);

  // Review #209: read the TTL from the VALIDATED env schema, not raw
  // `process.env`. The schema already coerces, bounds (1..300) and defaults
  // it at boot; the raw read re-implemented the default and would have
  // silently produced `NaN` (→ an `Invalid Date` nonce row) for a value the
  // schema would have rejected outright. `clampSsoHandoffTtl` still applies
  // the tighter <=60s signing ceiling on top.
  const ttlSeconds = clampSsoHandoffTtl(getServerEnv().SSO_HANDOFF_TTL_SECONDS);
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Opportunistically purge long-expired nonces so the table does not
  // grow without bound; tokens live <= 60s, so anything expired for
  // over an hour can never be consumed again.
  await db
    .deleteFrom("app_sso_handoff_nonces")
    .where("expires_at", "<", new Date(Date.now() - 60 * 60 * 1000))
    .execute();

  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti,
      app_user_id: context.appUserId,
      target_application_id: input.applicationId,
      expires_at: expiresAt,
    })
    .execute();

  const claims: SsoHandoffClaims = {
    email: context.email,
    targetApplicationId: input.applicationId,
    locale: context.locale,
  };

  const token = await signSsoHandoff({
    betterAuthUserId: input.betterAuthUserId,
    audience: targetApp.sso_audience,
    jti,
    ttlSeconds,
    claims,
  });

  const redirectUrl = new URL("/api/sso/consume", targetApp.origin);
  redirectUrl.searchParams.set("token", token);
  return redirectUrl;
}

/**
 * What {@link consumeSsoHandoffNonce} did. Only `"consumed"` lets the caller
 * establish a session; the other three say why the burn missed (F-85).
 */
export type SsoNonceConsumeResult = "consumed" | "replayed" | "expired" | "unknown";

/**
 * Atomically consumes a handoff `jti`, returning `"consumed"` exactly once per
 * token.
 *
 * The burn is predicated on `targetApplicationId` as well as `jti` (review
 * #15): the nonce row records which app the launch was FOR, so a consumer
 * can only spend nonces minted for its own application id — even if two
 * registered apps were to share an `sso_audience`.
 *
 * F-85: the one UPDATE misses for two different reasons, already spent or past
 * `expires_at`, and the consume route reported both as `token_already_used`. A
 * token can pass the verifier and still be past `expires_at`: the verifier
 * allows 5 s past `exp` for clock skew, and `expires_at` has no such allowance.
 * So an expiry reached satellite support as a replay. On a miss the row is
 * read back to tell them apart. A set `consumed_at` is a replay; an unset one
 * can only have missed on `expires_at`, since `jti` and the application id are
 * the lookup key. No row for this application is an unknown nonce, which is
 * what a consumer on its own database hits on every handoff
 * (integration-satellite-apps.md §4.5). The read comes after the atomic UPDATE,
 * so it cannot weaken the one-winner guarantee, and a concurrent winner between
 * the two statements reads as a replay, which it is.
 */
export async function consumeSsoHandoffNonce(
  jti: string,
  targetApplicationId: string,
): Promise<SsoNonceConsumeResult> {
  const result = await db
    .updateTable("app_sso_handoff_nonces")
    .set({ consumed_at: new Date() })
    .where("jti", "=", jti)
    .where("target_application_id", "=", targetApplicationId)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .returning(["jti"])
    .executeTakeFirst();
  if (result) return "consumed";

  const row = await db
    .selectFrom("app_sso_handoff_nonces")
    .select("consumed_at")
    .where("jti", "=", jti)
    .where("target_application_id", "=", targetApplicationId)
    .executeTakeFirst();
  if (!row) return "unknown";
  return row.consumed_at === null ? "expired" : "replayed";
}

/**
 * Ends the SSO handoffs of an application being disabled or deleted, as far
 * as this deployment can see them (F-82). Disabling an app used to end
 * nothing: a new launch was refused, but every session a handoff had already
 * opened on the satellite kept rolling.
 *
 *   1. A handoff still in flight (a nonce not yet burned, ≤60 s old) is expired
 *      first, so its consume answers `token_expired` rather than opening a
 *      session after the sessions below are gone.
 *   2. Every session a handoff opened for the app is deleted, found by its
 *      token prefix (`ssoSessionTokenPrefix`, minted by `createSsoSession`).
 *      A consumer on this deployment's database and schema keeps its sessions
 *      in this `session` table, so its users are signed out on their next
 *      request. A consumer with a session store of its own is out of reach:
 *      its sessions end `SSO_SESSION_LIFETIME_HOURS` after their handoff, and
 *      the next launch is refused. Both hold only for a consumer that mints
 *      this token and enforces that lifetime, as the kit does: a satellite
 *      fork gets them by porting F-82 (the CHANGELOG's fork-port list), and
 *      until then its sessions carry Better Auth's plain token, which this
 *      sweep never matches.
 *
 * The delete goes through Better Auth's adapter, as in
 * `impersonation-sessions.server.ts`. Its `starts_with` is a `LIKE` with no
 * escaping, which the hex prefix makes safe: it holds no `%` or `_`. Throws on
 * failure, after the caller's change has committed. The enterprise-app route
 * audits that change either way; a disabling save then answers 500, and
 * saving again runs this again (every step is idempotent), while a delete,
 * which cannot be retried, stands and leaves what this missed to the lifetime.
 *
 * @returns the number of sessions deleted.
 */
export async function endSsoHandoffsOfApplication(applicationId: string): Promise<number> {
  // An empty id would still yield a narrow prefix (`sso..`), but a bug
  // upstream must not reach a delete at all.
  if (!applicationId) return 0;

  await db
    .updateTable("app_sso_handoff_nonces")
    .set({ expires_at: new Date() })
    .where("target_application_id", "=", applicationId)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .execute();

  // Lazy, like `revokeSessionsImpersonatedBy`: keeps the Better Auth instance
  // (and its pool) out of the admin route's static import graph.
  const ctx = await (await import("@/lib/auth")).auth.$context;
  return ctx.adapter.deleteMany({
    model: "session",
    where: [
      { field: "token", operator: "starts_with", value: ssoSessionTokenPrefix(applicationId) },
    ],
  });
}
