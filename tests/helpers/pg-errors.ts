/**
 * F-132 — Postgres constraint violations shaped the way `pg` raises them: the
 * SQLSTATE in `code`, the violated constraint (or unique index) in
 * `constraint`.
 *
 * The message is the one a server with `lc_messages = 'fr_FR.UTF-8'` sends, on
 * purpose: a handler that still recognised the violation by its English text
 * ("duplicate key", "foreign key") misses these and answers 500, so a route
 * test built on them fails for exactly the fault F-132 removed. A test that
 * pins the opposite (a violation of ANOTHER constraint is not this route's
 * 409) asks for the English text instead, which the old match would claim.
 */
export function pgUniqueViolation(constraint: string, lcMessages: "fr" | "en" = "fr"): Error {
  const message =
    lcMessages === "fr"
      ? `la valeur d'une clé dupliquée rompt la contrainte unique « ${constraint} »`
      : `duplicate key value violates unique constraint "${constraint}"`;
  return Object.assign(new Error(message), { code: "23505", constraint });
}

export function pgForeignKeyViolation(constraint: string): Error {
  return Object.assign(
    new Error(
      `une instruction insert ou update sur la table viole la contrainte de clé étrangère « ${constraint} »`,
    ),
    { code: "23503", constraint },
  );
}
