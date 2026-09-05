/**
 * Canonical status vocabularies for the identity / credential tables — the
 * TypeScript source of truth the database CHECK constraints in
 * `src/db/migrations/0004-integrity-constraints.sql` are copied from
 * (review #217). `tests/unit/migration-status-check-sync.test.ts` parses the
 * SQL and diffs it against these arrays in both directions, so adding a value
 * here without a forward migration — or in a migration without updating the
 * runtime — fails CI.
 *
 * Deliberately a pure module (no `server-only`, no db import) so both the
 * runtime (`auth-status.ts`) and the migration sync test can import it.
 * `ORGANIZATION_STATUSES` (organizations) and `APP_STATUS_VALUES` (enterprise
 * apps) already live next to their validators and are re-exported here so the
 * sync test has ONE import for every constrained column.
 */
export { ORGANIZATION_STATUSES } from "@/lib/validation/organizations";
export { APP_STATUS_VALUES } from "@/lib/admin/enterprise-apps";

/** `app_users.status`. */
export const APP_USER_STATUS_VALUES = [
  "active",
  "pending_approval",
  "blocked",
  "suspended",
  "deactivated",
] as const;

/** `app_organization_memberships.status` (and `pre_deactivation_status`). */
export const MEMBERSHIP_STATUS_VALUES = [
  "active",
  "pending_approval",
  "blocked",
  "suspended",
] as const;

/** `app_api_keys.status` and `app_oauth_clients.status`. */
export const CREDENTIAL_STATUS_VALUES = ["active", "revoked"] as const;
