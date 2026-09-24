/**
 * F-30 — "Better Auth already holds this email", in both shapes the create
 * path raises it.
 *
 * `POST /api/administrator/users` and `POST /api/v1/users` check `app_users`
 * for the address first, but that check is only a courtesy. `app_users` has
 * no unique key on the email (its one unique key is `better_auth_user_id`);
 * the Better Auth `"user"` table's unique `email` is the real constraint. So
 * two cases pass the courtesy check and then fail INSIDE
 * `createBetterAuthUser`:
 *
 *   - an address Better Auth holds with no `app_users` row: a self-sign-up
 *     whose best-effort provisioning failed, the identity a failed create
 *     leaves behind, or a satellite's sign-up on a shared Option C schema;
 *   - the loser of two concurrent creates of one address.
 *
 * Both are the documented 409, not an identity-provider outage (502), and the
 * routes use this to tell them apart. The refusal arrives in one of two shapes:
 *
 *   1. The admin plugin's own lookup before its insert throws an `APIError`
 *      whose `body.code` is `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`
 *      (better-auth 1.7). The core's `USER_ALREADY_EXISTS` is the same refusal
 *      on the sign-up path and is accepted too, so a plugin release that
 *      switches between them keeps mapping.
 *   2. Two creates that both pass that lookup race to the insert, and the
 *      loser gets Postgres' unique violation (SQLSTATE 23505) on the `"user"`
 *      email key. Better Auth's Kysely adapter passes the driver error through
 *      unwrapped (`tests/db/user-create-failure-audit.db.test.ts` pins both).
 *
 * Structural rather than `instanceof APIError`, so the check holds whichever
 * copy of the class threw it. Apply it only to errors from the Better Auth
 * create call: a 23505 anywhere else is a different fact.
 */
const EMAIL_TAKEN_CODES: ReadonlySet<string> = new Set([
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
]);

export function isAuthEmailTakenError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { body, code, constraint } = err as {
    body?: unknown;
    code?: unknown;
    constraint?: unknown;
  };
  if (typeof body === "object" && body !== null) {
    const bodyCode = (body as { code?: unknown }).code;
    if (typeof bodyCode === "string" && EMAIL_TAKEN_CODES.has(bodyCode)) return true;
  }
  return code === "23505" && typeof constraint === "string" && /email/i.test(constraint);
}
