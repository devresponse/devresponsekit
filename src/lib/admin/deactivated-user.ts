/**
 * F-57 — A SOFT-DELETED ACCOUNT LEAVES `deactivated` ONLY THROUGH RESTORE.
 *
 * A soft-delete writes two stores: an indefinite Better Auth ban, and
 * `app_users.status = 'deactivated'` with the membership snapshot restore
 * reads back. Restore is the one action that undoes both together. The other
 * account transitions used to apply to a deactivated account too, and each
 * undid one half:
 *
 *   - approve / reactivate moved the account to `active` and left the ban, the
 *     `deactivated_*` columns and the membership snapshot, so the user still
 *     could not sign in and restore then answered 409 `not_deactivated`. Block
 *     and suspend left the same stale state behind;
 *   - unban lifted the ban and left the account `deactivated`, so Better Auth
 *     issued sessions to a "deleted" account's self-service endpoints again,
 *     and a timed ban turned the soft-delete's permanent ban into one that
 *     lapses.
 *
 * So each of them refuses a deactivated account with 409 `use_restore`:
 * `performAdminStatusChange` (both status routes and the bulk status actions;
 * decided inside its transaction), `POST /users/[id]/ban` and `/unban`, and
 * the bulk dispatcher (`executeBulkUserAction`). Restore refuses every other
 * account with 409 `not_deactivated`, so the two predicates split the
 * lifecycle between them. A repeated soft-delete is still accepted.
 *
 * No `server-only` and no imports: the status core, the bulk helpers and the
 * routes all read the same rule.
 */
export const USE_RESTORE_ERROR = "use_restore";
export const USE_RESTORE_STATUS = 409;

/** True when `account` is soft-deleted, so only restore may move it. */
export function mustUseRestore(account: { status: string }): boolean {
  return account.status === "deactivated";
}
