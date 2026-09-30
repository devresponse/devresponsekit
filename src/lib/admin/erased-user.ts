/**
 * F-151 — AN ERASED ACCOUNT IS FINAL.
 *
 * `app_users_pseudonymise` (migration 0008) replaces a soft-deleted account's
 * personal data in place: the address becomes `erased+<app_users.id>@erased.invalid`
 * on `app_users` and on the Better Auth user, the name goes, and every session
 * and sign-in credential is deleted. The account row stays, `deactivated`, so
 * the audit trail and every foreign key still resolve.
 *
 * The console tells an erased account apart by that address, derived from the
 * account's OWN id: nobody can sign up with it in advance (the id does not
 * exist yet) and no route edits `primary_email`. Restore refuses one with 409
 * `user_erased`, single-row and bulk (`performRestore`), because bringing it
 * back would put a nameless account with no way to sign in into every org's
 * approval queue. Erasing it again is harmless (the function is idempotent),
 * and every other transition already refuses a deactivated account with
 * `use_restore` (`deactivated-user.ts`), so restore is the one exit to close.
 *
 * No `server-only` and no imports: routes, the bulk helpers and the detail
 * page read the same rule. Keep `erasedEmailFor` equal to the SQL expression
 * `'erased+' || id || '@erased.invalid'` in the migration.
 */
export const USER_ERASED_ERROR = "user_erased";
export const USER_ERASED_STATUS = 409;

/** The address `app_users_pseudonymise` gives the account `appUserId`. */
export function erasedEmailFor(appUserId: string): string {
  return `erased+${appUserId.toLowerCase()}@erased.invalid`;
}

/** True when `account` has been erased (F-151). */
export function isErasedAccount(account: { appUserId: string; primaryEmail: string }): boolean {
  return account.primaryEmail === erasedEmailFor(account.appUserId);
}
