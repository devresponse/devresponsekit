/**
 * Whether a connection string may carry a migration run (DEP2).
 *
 * Both runners, `pnpm db:app:migrate` and `pnpm db:auth:migrate`, call
 * {@link migrationUrlProblem} before they connect, and every path that
 * migrates goes through them: the migrate-production workflow, `drk-deploy`,
 * the hand gate, `pnpm db:provision` and the Docker init step. Two shapes are
 * refused, by exit code 1, naming the reason and never the URL:
 *
 * - POOLED. DDL and the runner's session-level advisory lock do not survive a
 *   transaction pooler: consecutive statements may reach different backends,
 *   so the lock that serialises two runners guards nothing, and the failure
 *   is quiet. There is deliberately no escape hatch; a provider's direct
 *   endpoint always exists.
 * - REPOINTED. `pg` honours `?host=`, `?port=` and `?user=` over the URL's
 *   authority, and libpq reads `hostaddr` and `dbname` as well, so a URL
 *   carrying one connects somewhere other than the host it shows. The pooled
 *   check reads the authority, and so does every line that names a target
 *   (`[db:provision] target`, the build's `[deploy-gate] target`).
 *
 * {@link pooledReason} and {@link repointingParams} are copies of
 * `vercel-cli/src/lib/migration-target.ts`, which refuses the same URLs before
 * drk-deploy hands one to these runners. drk-deploy cannot import the kit
 * across its package boundary, so `tests/unit/connection-shape.test.ts` runs
 * both copies over one vector list. Pure, so the whole matrix is unit-tested.
 */

/**
 * Why a connection string looks POOLED, or null when it does not.
 *
 * Neon's pooled host carries `-pooler`; Supabase's pooler is a `.pooler.`
 * host on port 6543; PgBouncer setups are marked with `pgbouncer=true`.
 */
export function pooledReason(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (/-pooler(\.|$)/.test(host)) return "its host carries Neon's `-pooler` suffix";
  if (/(^|\.)pooler\./.test(host)) return "its host is a `.pooler.` endpoint";
  if (url.port === "6543") return "it uses port 6543, the transaction pooler's port";
  if (url.searchParams.get("pgbouncer")?.toLowerCase() === "true")
    return "it carries `pgbouncer=true`";
  return null;
}

/**
 * Query parameters that send a connection somewhere other than the URL's own
 * host, port, database or user. Refused, not interpreted: what each driver
 * makes of them differs.
 */
const REPOINTING_PARAMS = ["host", "hostaddr", "port", "dbname", "database", "user"] as const;

/** The query parameters in `url` that re-point its connection, in {@link REPOINTING_PARAMS} order. */
export function repointingParams(url: URL): string[] {
  return REPOINTING_PARAMS.filter((name) => url.searchParams.has(name));
}

/**
 * Why the migration runners must not connect with `raw` (their
 * `DATABASE_URL`), or null when they may. The reason never contains the URL
 * or any part of it but the parameter names it flags.
 */
export function migrationUrlProblem(raw: string | undefined): string | null {
  if (!raw) return "DATABASE_URL is required to run migrations.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "DATABASE_URL is not a postgres:// or postgresql:// URL.";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return "DATABASE_URL is not a postgres:// or postgresql:// URL.";
  }
  const pooled = pooledReason(url);
  if (pooled) {
    return (
      `DATABASE_URL looks pooled: ${pooled}. DDL and the migration advisory lock do not ` +
      "survive a transaction pooler, so migrations need the DIRECT endpoint (on Neon, the " +
      "host without `-pooler`). Nothing was attempted."
    );
  }
  const params = repointingParams(url);
  if (params.length > 0) {
    return (
      `DATABASE_URL re-points the connection with ${params.map((p) => `\`${p}\``).join(", ")} ` +
      "in its query, so it would migrate a database other than the one its host names. Write " +
      "user, host, port and database in the URL itself and drop those parameters. Nothing was " +
      "attempted."
    );
  }
  return null;
}
