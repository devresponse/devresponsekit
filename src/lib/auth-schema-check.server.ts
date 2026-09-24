import "server-only";

/**
 * The Better Auth half of the readiness probe (F-26): can THIS instance serve
 * auth, as far as the database schema goes?
 *
 * better-auth 1.7 validates its own schema. The Kysely adapter compares the
 * tables and columns this configuration writes (core tables, plugin columns
 * such as the admin plugin's `impersonatedBy`, the `rateLimit` table that
 * `storage: "database"` needs, additional user fields) with what the
 * connection's `search_path` resolves to, and every `/api/auth/*` request and
 * every server-side `auth.api.*` call awaits that verdict first. A missing
 * table or column therefore fails ALL of auth with a 500, sign-in and
 * `getSession` on every guarded page included, while the app's own migration
 * ledger, which is all readiness used to read, says nothing is wrong.
 *
 * So this asks Better Auth for its verdict instead of re-deriving the schema:
 *
 *   - The expected tables and columns come from the running configuration,
 *     not from a hand-typed list that a better-auth upgrade or a new plugin
 *     would leave stale.
 *   - They resolve through the SAME pool, so the same `search_path`
 *     (`DB_SCHEMA`, or the role default behind a transaction pooler) and the
 *     same quoting of camelCase names such as `"rateLimit"`.
 *   - It can never disagree with the check that gates the requests: readiness
 *     reports `schema_behind` exactly when Better Auth refuses to serve.
 *
 * Cost: Better Auth starts the check when its context is created and shares
 * one promise between callers. A clean verdict is cached for the life of the
 * process, so after the first call this issues no query at all. A
 * connection failure is not cached; the next call asks the database again.
 *
 * A MISMATCH IS CACHED TOO, until Better Auth's own migrator runs in this
 * same process. Running `pnpm db:auth:migrate` from somewhere else fixes the
 * database but not an instance that has already seen the gap: it keeps
 * refusing auth, and keeps reporting `schema_behind` here, until it restarts.
 * That is the truth about the instance, which is why this reads the verdict
 * rather than re-querying the catalog; the runbook says to redeploy or
 * restart after the migration (docs/troubleshooting.md).
 *
 * Better Auth only skips the check when `advanced.database.validateSchema` is
 * `false`, and then it does not gate requests either. The kit never sets it,
 * and `tests/db/readiness.db.test.ts` fails if the kit's adapter stops
 * registering the check, because this probe would then see nothing.
 */

/** One problem Better Auth found, as data. Table and column names only. */
export interface AuthSchemaFinding {
  kind: string;
  table: string;
  column?: string;
}

export type AuthSchemaVerdict =
  /** Better Auth's check passed (or is disabled, see above). */
  | { state: "ok" }
  /** The database cannot hold what this configuration writes. */
  | { state: "behind"; findings: AuthSchemaFinding[] }
  /** The check could not reach the database; not cached, so retried next call. */
  | { state: "unreachable"; error: unknown }
  /** Better Auth itself did not initialise (a configuration it refuses). */
  | { state: "misconfigured"; error: unknown };

/**
 * The findings of Better Auth's `SchemaMismatchError`, or `null` for any
 * other error. Matched by its documented `code` rather than `instanceof`:
 * the class is exported only from `@better-auth/core/db/internal`, which this
 * app does not depend on directly.
 */
export function schemaMismatchFindings(error: unknown): AuthSchemaFinding[] | null {
  if (!(error instanceof Error)) return null;
  const { code, findings } = error as { code?: unknown; findings?: unknown };
  if (code !== "SCHEMA_MISMATCH" || !Array.isArray(findings)) return null;
  return findings.map((finding: { kind?: unknown; table?: unknown; column?: unknown }) => ({
    kind: String(finding.kind),
    table: String(finding.table),
    ...(finding.column === undefined ? {} : { column: String(finding.column) }),
  }));
}

/**
 * Better Auth's schema verdict for this process. Never throws. Imports
 * `@/lib/auth` lazily: that module validates the env at load, so the caller
 * checks the env first and this stays out of the readiness route's static
 * graph.
 */
export async function betterAuthSchemaVerdict(): Promise<AuthSchemaVerdict> {
  let checkSchema: (() => Promise<void> | undefined) | undefined;
  try {
    const { auth } = await import("@/lib/auth");
    ({ checkSchema } = await auth.$context);
  } catch (error) {
    return { state: "misconfigured", error };
  }
  try {
    await checkSchema?.();
    return { state: "ok" };
  } catch (error) {
    const findings = schemaMismatchFindings(error);
    return findings ? { state: "behind", findings } : { state: "unreachable", error };
  }
}
