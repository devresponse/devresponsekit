import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import type { TokenCredentialRef } from "@/lib/api-auth/jwt.server";

/**
 * Revocation of outstanding JWT access tokens (design
 * docs/design-api-keys-and-tokens.md §6.5).
 *
 * Access tokens are stateless, so killing one before its natural `exp`
 * needs a per-request read against SOMETHING that revocation writes. The
 * original design was a `jti` denylist (`app_revoked_tokens`), but nothing
 * ever wrote to it: revoking or rotating a key / client stopped MINTING and
 * left every already-issued token valid until `exp` (review #43). The
 * `revokeJti` / `isJtiRevoked` pair was therefore REMOVED rather than wired:
 * every operational revocation is a credential-level act (revoke the key,
 * revoke the client, rotate either), and a per-token kill switch has no
 * caller or UI. The denylist would have needed a second per-request read on
 * top of the credential check below for no additional coverage.
 *
 * What replaced it: every token carries a `cid` claim naming its source
 * credential, and {@link isSourceCredentialActive} re-reads that row's
 * status on every JWT request — ONE primary-key lookup, the same cost the
 * (always-empty) denylist read used to be. A positive cache was considered
 * and rejected: it would reintroduce a revocation lag equal to its TTL,
 * which is exactly the gap this check exists to close, and the read is a
 * PK hit on a small table.
 *
 * `app_revoked_tokens` itself stays (it is in the frozen 0001 migration and
 * costs nothing empty); {@link pruneExpiredRevocations} keeps the retention
 * job's contract until a later core migration drops the table.
 */

/**
 * True when the credential a token was minted from can still authorise it:
 *   - an API key that is `active` and not past `expires_at` (a token's TTL is
 *     already capped by the key's expiry at mint time, review #48 — the
 *     expiry re-check here only matters if the key's `expires_at` was later
 *     moved earlier);
 *   - an OAuth client that is `active` AND whose secret has not been rotated
 *     since the token was issued (`secret_rotated_at` ≤ `iat`), so rotating
 *     a client secret also retires tokens minted with the old secret.
 *
 * `issuedAt` is the token's `iat`. Unknown ids (deleted rows) are inactive.
 */
export async function isSourceCredentialActive(
  credential: TokenCredentialRef,
  issuedAt: Date,
): Promise<boolean> {
  if (credential.kind === "api_key") {
    const row = await db
      .selectFrom("app_api_keys")
      .select(["status", "expires_at"])
      .where("id", "=", credential.id)
      .executeTakeFirst();
    if (!row || row.status !== "active") return false;
    return !row.expires_at || new Date(row.expires_at).getTime() > Date.now();
  }
  const row = await db
    .selectFrom("app_oauth_clients")
    .select(["status", "secret_rotated_at"])
    .where("id", "=", credential.id)
    .executeTakeFirst();
  if (!row || row.status !== "active") return false;
  // A token whose `iat` precedes the rotation stamp is retired. Both stamps
  // come from the app server's clock (`setIssuedAt` and the `new Date()`
  // written by `rotateOauthClientSecret`), so there is no DB/app skew; `iat`
  // has one-second resolution, so a token minted in the same second as the
  // rotation errs on the strict side and may need one re-mint.
  return !row.secret_rotated_at || new Date(row.secret_rotated_at).getTime() <= issuedAt.getTime();
}

/**
 * Removes rows from the (now vestigial) `jti` denylist whose tokens have
 * already expired. Kept so the scheduled `pnpm db:prune` retention job keeps
 * its contract on databases that still carry the table.
 */
export async function pruneExpiredRevocations(): Promise<number> {
  const result = await db
    .deleteFrom("app_revoked_tokens")
    .where("expires_at", "<", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(result?.numDeletedRows ?? 0);
}
