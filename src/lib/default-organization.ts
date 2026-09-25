/**
 * The default organization's ONE identity is `app_organizations.is_default`
 * (F-40). Neutral module (no `server-only`, no database import) so the tsx seed
 * scripts share the same lock and initial values as the runtime; the resolver
 * and the flag-moving helpers live in `default-organization.server.ts`.
 *
 * Before F-40 the default org had two identities: sign-up routing, the sign-up
 * policy lookup and the seed found it by the slug `default`, while the delete
 * guard and the admin UI used `is_default`. Renaming its slug in Settings made
 * the next unmapped sign-up auto-create a second, adminless "Default
 * Organization" under the platform policy, and moving the flag to another org
 * routed nothing there. The slug is now only a name: nothing looks the default
 * org up by it.
 */

/**
 * Transaction-scoped advisory lock taken by EVERY writer of `is_default` (the
 * admin create and update routes and the seed) before it reads or moves the
 * flag. A row lock on the current default is not enough: when two moves race,
 * the second one's clearing UPDATE was planned against a snapshot in which the
 * first one's new default was not yet set, so it skips that row and two orgs
 * end up flagged; and with no default at all there is no row to lock. Taking
 * this lock first serializes the writers, so each one's clearing statement sees
 * every default committed before it. Two-int4 form, like the MCP registration
 * lock, so it cannot collide with a lock keyed on a bare hash.
 *
 * No partial unique index backs this (`on app_organizations ((true)) where
 * is_default` would need a core migration); a legacy database that already
 * holds two defaults is resolved deterministically to the OLDEST one (see
 * `getDefaultOrganization`), which is always the original, since the old seed
 * re-run only ever added newer rows.
 */
export const DEFAULT_ORGANIZATION_LOCK_SQL =
  "select pg_advisory_xact_lock(hashtext('app_organizations'), hashtext('is_default'))";

/**
 * Slug and name a database with NO default organization gets one created
 * under (the seed; migration 0001 inserts the same row on a fresh schema).
 * Initial data only: nothing ever looks the default org up by this slug.
 */
export const INITIAL_DEFAULT_ORGANIZATION = {
  slug: "default",
  name: "Default Organization",
} as const;

/**
 * The label a sign-up placed in the default org carries as its membership's
 * `provider_organization_key` (display only; never resolved back to an org).
 */
export const DEFAULT_ORGANIZATION_PROVIDER_KEY = "default";
