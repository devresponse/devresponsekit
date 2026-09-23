import "server-only";
import { db } from "@/db/database";
import { revokeActiveApiKeysOf } from "@/lib/api-auth/api-keys.server";
import { inIssuanceTransaction, lockOwnerForEviction } from "@/lib/api-auth/issuance-fence.server";
import { revokeActiveOauthClientsOf } from "@/lib/api-auth/oauth-clients.server";
import { auditEvent } from "@/lib/audit.server";

/**
 * F-10 — REPLACING A PASSWORD ENDS EVERY BEARER CREDENTIAL THAT AUTHENTICATES
 * AS THE ACCOUNT.
 *
 * A completed password reset, and an administrator setting the password, are
 * the "this account may be compromised" responses. They already end the
 * account's sessions (Better Auth's sweep, plus the sessions it opened as
 * someone else, F-08), but API keys and OAuth clients are app rows that
 * authenticate on their own. Anyone who held the account's cookie for a minute
 * could `POST /api/v1/me/api-keys`, take a key that never expires
 * (`API_KEY_DEFAULT_TTL_DAYS` is unset out of the box), and keep acting as the
 * account after the owner reset the password.
 *
 * So both of those paths call this function. It revokes every ACTIVE API key
 * the account owns (`app_api_keys.app_user_id`) and every active OAuth client
 * whose service principal it is (`app_oauth_clients.app_user_id`), and audits
 * each one as `api_key.revoked` / `oauth_client.revoked` with the trigger in
 * `metadata.reason`. A revoked source credential also ends every JWT minted
 * from it on that token's next request (the `cid` check in
 * `resolveCallerDetailed`), so no access token outlives the reset.
 *
 * It must not leave a credential that is born while it runs. The first version
 * read the active rows once and revoked them one by one, two round trips each,
 * so a key minted after that read (by the thief's still-valid cookie, or by
 * one of the keys still waiting its turn) was never revoked, and neither was
 * the successor of a key rotated mid-loop. Now:
 *
 *   - each pass is ONE transaction: it takes the owner's eviction lock (the
 *     issuance fence, `issuance-fence.server.ts`), then revokes the keys and
 *     the clients with one set-based `UPDATE … RETURNING` each. A fenced
 *     issuance for this account either commits before the pass and is
 *     revoked by it, or waits for it. If it authenticated with one of the
 *     account's own sessions or credentials, that credential is dead by then
 *     and the issuance is refused. An administrator minting for the account
 *     on their own authority goes ahead, as it should;
 *   - passes repeat until one revokes nothing, at most
 *     {@link MAX_EVICTION_PASSES} times. That catches a row an unfenced insert
 *     committed while a pass ran. If the last pass still revoked something,
 *     it throws, so the admin route reports failure and the operator retries;
 *   - the audit rows are written after each pass commits, one per row that
 *     pass revoked. A row some other revoke got to first is not in `RETURNING`,
 *     and that revoke wrote its own audit row, so nothing is audited twice.
 *
 * The callers end the account's sessions BEFORE calling this (the reset hook
 * in `src/lib/auth.ts`, `setBetterAuthUserPassword`), so the fence's re-check
 * refuses a mint that authenticated with one of them.
 *
 * What it deliberately leaves alone:
 *
 *   - Credentials the account minted for SOMEONE ELSE (`created_by` = the
 *     account, `app_user_id` = another principal). They authenticate as that
 *     other principal, whose password did not change, and revoking them would
 *     break a service user's integration whenever the admin who provisioned it
 *     reset their own password. After a compromise, an operator finds them
 *     through the `api_key.created` / `oauth_client.created` audit rows, whose
 *     actor is the account.
 *   - MCP agent principals. They have no Better Auth user and no password, so
 *     neither trigger can name one: a reset finds no account for the address,
 *     and set-password fails inside Better Auth before this runs.
 *   - Self-service change-password. The caller must know the current password,
 *     which a cookie thief does not, and the form sends `revokeOtherSessions`
 *     on every change. Revoking keys there would break the user's integrations
 *     on every routine change. See `auth-session-sweep.ts`.
 *
 * Throws on failure, and every step is idempotent. Callers decide what a
 * failure means. The admin wrapper lets it propagate so the route reports
 * failure and the operator retries. The reset hook logs it, because the
 * password has already changed and cannot be un-reset.
 */

/** What replaced the password; recorded as the revoke reason. */
export type CredentialEvictionTrigger = "password_reset" | "password_set";

export interface RevokeBearerCredentialsInput {
  /** Better Auth id of the account whose password was replaced. */
  betterAuthUserId: string;
  trigger: CredentialEvictionTrigger;
  /**
   * Better Auth id of whoever replaced it: the account itself for a reset, the
   * administrator for a set. It becomes the audit rows' actor.
   */
  actorBetterAuthUserId: string;
  /**
   * `app_users` id written to `revoked_by`. Omit it, or pass `null`, to record
   * the account itself, the same fallback the admin revoke routes use.
   */
  revokedByAppUserId?: string | null;
  /** The request the audit rows record: client IP, user agent, request id and F-07 attribution. */
  request?: { headers: Headers };
  requestId?: string | null;
}

export interface RevokedBearerCredentials {
  apiKeyIds: string[];
  oauthClientIds: string[];
}

/**
 * Bound on the eviction's passes. Pass 1 revokes everything the account holds,
 * and pass 2 normally finds nothing. Anything more means credentials of the
 * account are still being created by an unfenced path.
 */
export const MAX_EVICTION_PASSES = 5;

export async function revokeBearerCredentialsOf(
  input: RevokeBearerCredentialsInput,
): Promise<RevokedBearerCredentials> {
  const revoked: RevokedBearerCredentials = { apiKeyIds: [], oauthClientIds: [] };
  // Guard against an empty id: it should match nothing, but a bug upstream
  // must never turn this into a broad revoke.
  if (!input.betterAuthUserId) return revoked;

  const owner = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "=", input.betterAuthUserId)
    .executeTakeFirst();
  // No `app_users` row means the account was never provisioned. It holds no
  // credential, because both credential tables reference `app_users`.
  if (!owner) return revoked;
  const revokedBy = input.revokedByAppUserId ?? owner.id;
  const audit = { request: input.request, requestId: input.requestId ?? null };

  for (let pass = 1; ; pass++) {
    const swept = await inIssuanceTransaction(async (trx) => {
      await lockOwnerForEviction(trx, owner.id);
      const keys = await revokeActiveApiKeysOf(trx, owner.id, revokedBy, input.trigger);
      const clients = await revokeActiveOauthClientsOf(trx, owner.id, revokedBy);
      return { keys, clients };
    });

    for (const key of swept.keys) {
      revoked.apiKeyIds.push(key.id);
      await auditEvent({
        eventType: "api_key.revoked",
        outcome: "success",
        actorBetterAuthUserId: input.actorBetterAuthUserId,
        appUserId: owner.id,
        organizationId: key.organization_id,
        ...audit,
        metadata: { apiKeyId: key.id, reason: input.trigger },
      });
    }
    for (const client of swept.clients) {
      revoked.oauthClientIds.push(client.id);
      await auditEvent({
        eventType: "oauth_client.revoked",
        outcome: "success",
        actorBetterAuthUserId: input.actorBetterAuthUserId,
        appUserId: owner.id,
        organizationId: client.organization_id,
        ...audit,
        metadata: { clientRowId: client.id, reason: input.trigger },
      });
    }

    if (swept.keys.length === 0 && swept.clients.length === 0) return revoked;
    if (pass >= MAX_EVICTION_PASSES) {
      throw new Error(
        `bearer credentials of the account were still being created after ${MAX_EVICTION_PASSES} eviction passes`,
      );
    }
  }
}
