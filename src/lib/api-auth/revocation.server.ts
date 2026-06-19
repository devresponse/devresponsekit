import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";

/**
 * JWT `jti` revocation list (design docs/design-api-keys-and-tokens.md
 * §6.4). Access tokens are stateless, so revoking one before its natural
 * `exp` requires recording its `jti` here; the resolver rejects any token
 * whose `jti` is present. The table is small and TTL-pruned.
 */

/** Records a token id as revoked until its original expiry. */
export async function revokeJti(jti: string, expiresAt: Date, reason?: string): Promise<void> {
  await db
    .insertInto("app_revoked_tokens")
    .values({ jti, expires_at: expiresAt, reason: reason ?? null })
    .onConflict((oc) => oc.column("jti").doNothing())
    .execute();
  // This insert is the table's ONLY writer, so pruning expired rows here keeps
  // it bounded to live revocations without a scheduled job (D3) — the same
  // opportunistic pattern as the SSO-nonce purge. The scheduled `pnpm db:prune`
  // covers it too, for deployments that never revoke.
  await pruneExpiredRevocations();
}

/** True when the token id has been revoked. */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  const row = await db
    .selectFrom("app_revoked_tokens")
    .select(["jti"])
    .where("jti", "=", jti)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Removes revocation rows whose tokens have already expired (after `exp`
 * the signature/exp check rejects them anyway). Safe to call opportun-
 * istically; intended for a periodic job.
 */
export async function pruneExpiredRevocations(): Promise<number> {
  const result = await db
    .deleteFrom("app_revoked_tokens")
    .where("expires_at", "<", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(result?.numDeletedRows ?? 0);
}
