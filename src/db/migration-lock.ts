/**
 * How long a migration runner waits for the migration lock (DEP2).
 *
 * Both runners take the same session-level advisory lock,
 * `pg_advisory_lock(hashtext('app_schema_migrations'))`, so two runs started
 * together serialise (review #85; the Better Auth runner since DEP2). By
 * default the wait is unbounded: a second runner queues behind the first
 * however long it takes. That is right at a terminal and wrong for an
 * unattended run: a hand run left open, or a stuck session, would keep the
 * migrate-production workflow waiting until its job timeout, with nothing in
 * the log saying why, while the production build's schema gate times out.
 *
 * `DB_MIGRATE_LOCK_WAIT_MS` bounds it:
 *
 * - unset or empty: the unbounded `pg_advisory_lock`, as before;
 * - a whole number of milliseconds from 1 to {@link MAX_MIGRATION_LOCK_WAIT_MS}
 *   (one hour): `pg_try_advisory_lock` every {@link MIGRATION_LOCK_POLL_MS}
 *   until the deadline, then the runner exits 1 with "another session holds
 *   the migration lock";
 * - anything else, `0` and `5m` included: refused before connecting, like a
 *   malformed `DB_MIGRATE_LOCK_TIMEOUT_MS` (F-94). Silently running unbounded
 *   would hide the setting the operator asked for.
 *
 * The polling itself is `acquireMigrationLock` in
 * `src/db/migrations/apply-migration.ts`; this module is the pure parse.
 */

/** The longest bounded wait: one hour. */
export const MAX_MIGRATION_LOCK_WAIT_MS = 3_600_000;

/** How often a bounded wait retries `pg_try_advisory_lock`. */
export const MIGRATION_LOCK_POLL_MS = 1_000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads `DB_MIGRATE_LOCK_WAIT_MS`: `undefined` for the unbounded wait, else
 * the bound in milliseconds. Throws on any other value, before the runner
 * connects.
 */
export function resolveMigrationLockWait(env: Env = process.env): number | undefined {
  const raw = (env.DB_MIGRATE_LOCK_WAIT_MS ?? "").trim();
  if (raw === "") return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(ms >= 1 && ms <= MAX_MIGRATION_LOCK_WAIT_MS)) {
    throw new Error(
      `DB_MIGRATE_LOCK_WAIT_MS must be a whole number of milliseconds from 1 to ${MAX_MIGRATION_LOCK_WAIT_MS}, ` +
        `or unset for an unbounded wait, got "${raw}".`,
    );
  }
  return ms;
}
