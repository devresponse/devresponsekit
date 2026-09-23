import "server-only";
import { sql, type Kysely } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import type { TokenCredentialRef } from "@/lib/api-auth/jwt.server";
import { isSourceCredentialActive } from "@/lib/api-auth/revocation.server";

/**
 * F-10 — THE ISSUANCE FENCE: NO CREDENTIAL IS BORN AFTER ITS OWNER WAS SWEPT.
 *
 * A password reset or an admin set-password revokes every bearer credential
 * of the account (`revokeBearerCredentialsOf`). On its own that is a race. A
 * request that authenticated a moment earlier, with the account's cookie or
 * one of its keys, can insert a new key after the revoke has read the table,
 * and that key never gets revoked. Keys can mint keys (`account.apikeys.manage`
 * is always self-grantable), so an attacker can keep that request in flight on
 * purpose.
 *
 * Both sides therefore take a row lock on the OWNER's `app_users` row, and each
 * side's work happens under it:
 *
 *   - the eviction takes `FOR NO KEY UPDATE` ({@link lockOwnerForEviction}),
 *     then revokes every active key and client of the owner in the same
 *     transaction;
 *   - an issuance takes `FOR SHARE` ({@link enterIssuanceFence}), then
 *     re-checks that the credential the request authenticated with is still
 *     live, then inserts.
 *
 * The two locks conflict, so the transactions serialize. If the issuance holds
 * the lock first, the eviction waits for it to commit and then revokes the new
 * row too. If the eviction holds it first, the issuance waits, and its re-check
 * then sees the revocation and refuses with {@link IssuingCredentialRevokedError}.
 * Two issuances do not block each other. A plain insert's foreign-key check
 * takes only `FOR KEY SHARE`, which neither lock blocks. The eviction's own
 * `revoked_by` foreign key takes the same weak lock on the revoker, so two
 * administrators resetting each other at once cannot deadlock.
 *
 * The re-check reads the calling credential in a statement that starts after
 * the lock was granted. Under READ COMMITTED that statement sees everything
 * committed before, including the eviction. REPEATABLE READ would fix the
 * snapshot before the lock wait, so {@link inIssuanceTransaction} pins the
 * level instead of trusting the server default.
 *
 * Deleting the account's sessions is not a row lock on `app_users`, so both
 * password paths delete them BEFORE the eviction starts. A cookie request is
 * then refused by the re-check (its session is gone), or it committed before
 * the eviction took the lock and is revoked by it.
 */

/**
 * The credential a request authenticated with, as a re-checkable reference.
 * `resolveCallerDetailed` fills it for every caller. A JWT minted without a
 * `cid` (a legacy token) has no source it can be checked against, so its
 * caller carries `null` and nothing can be re-checked.
 */
export type CallerSource =
  | { kind: "session"; sessionId: string }
  | { kind: "api_key"; id: string }
  | { kind: "token"; credential: TokenCredentialRef; issuedAt: Date };

/**
 * The request's own credential was revoked, or its session ended, while the
 * request was issuing a credential. Routes answer 401: the caller is no longer
 * authenticated.
 */
export class IssuingCredentialRevokedError extends Error {
  constructor() {
    super("the credential issuing this request was revoked while it ran");
    this.name = "IssuingCredentialRevokedError";
  }
}

/**
 * Runs `fn` in a READ COMMITTED transaction, or inside `executor` when it
 * already is one (the caller then owns the isolation level).
 */
export function inIssuanceTransaction<T>(
  fn: (trx: Kysely<AppDatabase>) => Promise<T>,
  executor: Kysely<AppDatabase> = db,
): Promise<T> {
  if (executor.isTransaction) return fn(executor);
  return executor.transaction().setIsolationLevel("read committed").execute(fn);
}

/** The eviction's half of the fence; call it first in the eviction's transaction. */
export async function lockOwnerForEviction(
  trx: Kysely<AppDatabase>,
  ownerAppUserId: string,
): Promise<void> {
  await trx
    .selectFrom("app_users")
    .select("id")
    .where("id", "=", ownerAppUserId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/** The issuance's lock, without a re-check. Rotation uses it on its own (see `rotateApiKey`). */
export async function lockOwnerForIssuance(
  trx: Kysely<AppDatabase>,
  ownerAppUserId: string,
): Promise<void> {
  await trx
    .selectFrom("app_users")
    .select("id")
    .where("id", "=", ownerAppUserId)
    .forShare()
    .executeTakeFirst();
}

/**
 * The issuance's half of the fence; call it first in the issuing transaction,
 * before the insert. Throws {@link IssuingCredentialRevokedError} when the
 * calling credential died.
 */
export async function enterIssuanceFence(
  trx: Kysely<AppDatabase>,
  ownerAppUserId: string,
  issuedVia: CallerSource,
): Promise<void> {
  await lockOwnerForIssuance(trx, ownerAppUserId);
  if (!(await isCallerSourceLive(issuedVia, trx))) throw new IssuingCredentialRevokedError();
}

/**
 * True when the credential a request authenticated with would still
 * authenticate it: the session row exists and has not expired, or the key or
 * the token's source credential passes the same check the resolver applies
 * (`isSourceCredentialActive`).
 */
export async function isCallerSourceLive(
  source: CallerSource,
  executor: Kysely<AppDatabase> = db,
): Promise<boolean> {
  if (source.kind === "session") {
    const row = await executor
      .selectFrom("session")
      .select("id")
      .where("id", "=", source.sessionId)
      .where("expiresAt", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row !== undefined;
  }
  if (source.kind === "api_key") {
    return isSourceCredentialActive({ kind: "api_key", id: source.id }, new Date(), executor);
  }
  return isSourceCredentialActive(source.credential, source.issuedAt, executor);
}
