/**
 * F-132 — Postgres constraint violations, recognised by what the server
 * REPORTS, not by what it SAYS.
 *
 * The admin routes used to spot a unique violation by testing the error
 * message against `/duplicate key|unique constraint/i`, and a foreign-key
 * violation against `/foreign key/i`. That text follows the server's
 * `lc_messages`: on a server set to French the message reads "la valeur d'une
 * clé dupliquée rompt la contrainte unique …", so a taken slug answered a
 * 500 instead of 409 `slug_taken`. And any unique index on the table matched,
 * so a second one would have been reported under the first one's 409 code.
 *
 * `pg` puts the SQLSTATE on its DatabaseError as `code`, which is never
 * translated, and the name of the violated constraint (for a unique INDEX, the
 * index) as `constraint`. Kysely passes the driver error through unwrapped, so
 * every caller asks here, and names the constraint it expects.
 */

/** SQLSTATE `unique_violation`. */
export const UNIQUE_VIOLATION = "23505";
/** SQLSTATE `foreign_key_violation`. */
export const FOREIGN_KEY_VIOLATION = "23503";

/**
 * The unique constraints and indexes a caller maps to an answer of its own:
 * Postgres' default names for a primary key and the inline `unique` clauses
 * of migration 0001, plus the unique indexes 0001 and 0005 name. Listed here
 * rather than inline so a typo is a type error, and so
 * `tests/db/pg-constraint-names.db.test.ts` can check each one against the
 * migrated schema: a migration that renames one fails that test instead of
 * silently turning its 409 back into a 500.
 */
export const UNIQUE_CONSTRAINTS = [
  "app_enterprise_applications_pkey",
  "idx_app_enterprise_applications_sso_audience",
  "app_groups_organization_id_key_key",
  "idx_app_org_invitations_pending_unique",
  "app_organization_memberships_organization_id_app_user_id_key",
  "app_organizations_slug_key",
  "app_permissions_key_key",
  // Postgres truncates generated names to 63 bytes, hence `…_organization_k_key`.
  "app_provider_organizations_provider_provider_organization_k_key",
  "app_roles_organization_id_key_key",
] as const;
export type UniqueConstraint = (typeof UNIQUE_CONSTRAINTS)[number];

/** The foreign keys a caller maps to an answer of its own (see {@link UNIQUE_CONSTRAINTS}). */
export const FOREIGN_KEY_CONSTRAINTS = [
  "app_audit_events_app_user_id_fkey",
  "app_audit_events_organization_id_fkey",
  "app_enterprise_applications_organization_id_fkey",
  "app_roles_organization_id_fkey",
] as const;
export type ForeignKeyConstraint = (typeof FOREIGN_KEY_CONSTRAINTS)[number];

/**
 * The name of the constraint `err` violated when it is a Postgres error with
 * SQLSTATE `sqlState`; null for anything else. Structural rather than
 * `instanceof DatabaseError`, so it holds whichever copy of `pg` threw.
 */
export function violatedConstraint(
  err: unknown,
  sqlState: typeof UNIQUE_VIOLATION | typeof FOREIGN_KEY_VIOLATION,
): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === sqlState && typeof constraint === "string" ? constraint : null;
}

/** True when `err` is a unique violation (23505) of `constraint`. */
export function isUniqueViolation(err: unknown, constraint: UniqueConstraint): boolean {
  return violatedConstraint(err, UNIQUE_VIOLATION) === constraint;
}

/**
 * True when `err` is a foreign-key violation (23503), of `constraint` when one
 * is named.
 *
 * Name it whenever the failing statement writes the REFERENCING row: that row
 * can break more than one key, and each means something different. Leave it
 * out only for a DELETE of the REFERENCED row. There every 23503 says the same
 * thing (some row still points at this one), and listing the referencing
 * tables would turn the next one a migration adds into a 500.
 */
export function isForeignKeyViolation(err: unknown, constraint?: ForeignKeyConstraint): boolean {
  const violated = violatedConstraint(err, FOREIGN_KEY_VIOLATION);
  return violated !== null && (constraint === undefined || violated === constraint);
}
