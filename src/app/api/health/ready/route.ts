import { NextResponse } from "next/server";
import { pgPool } from "@/db/database";
import { REQUIRED_CORE_MIGRATIONS, missingCoreMigrations } from "@/db/migrations/migration-plan";
import { logServerError } from "@/lib/observability/logger.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/ready — readiness probe.
 *
 * Verifies the app can serve real requests: the database is reachable AND
 * the schema carries every core migration this build depends on
 * ({@link REQUIRED_CORE_MIGRATIONS}). One fast primary-key lookup against
 * the `app_schema_migrations` ledger covers both — it fails when the database
 * is down, and comes back short when a migration is missing.
 *
 * Returns 200 `{status:"ready"}`, or 503 with a coarse `reason`:
 *   - `database_unreachable` — the query failed (DB outage, pool not warm,
 *     or a database that was never migrated at all, which has no ledger).
 *   - `schema_behind` — the database answers but lacks a core migration the
 *     running code reads or writes. Production deploys from every push to
 *     `main` with no automated migrate step ahead of it (docs/deployment.md),
 *     so a build CAN go live before its migration; 0004 is the worked case
 *     (review #43 landing gate): without `secret_rotated_at` every request
 *     bearing an OAuth-client JWT and every admin secret rotation is a 500.
 *     Reporting it here makes the gap a credential-free `curl`, and an
 *     orchestrator's `readinessProbe` stalls the rollout instead of routing
 *     traffic to a build that would 500 (the missing ids are logged
 *     server-side for the operator; `pnpm db:app:migrate` closes the gap).
 *
 * Unauthenticated and non-enumerating: the body never carries the missing
 * migration ids or the underlying database error. The pool's
 * `connectionTimeoutMillis` bounds how long a down database can hang this
 * check. `no-store` so the result is never cached.
 */
export async function GET() {
  const headers = { "cache-control": "no-store" };
  let applied: string[];
  try {
    const { rows } = await pgPool.query<{ id: string }>(
      "select id from app_schema_migrations where id = any($1::text[])",
      [REQUIRED_CORE_MIGRATIONS],
    );
    applied = rows.map((row) => row.id);
  } catch {
    return NextResponse.json(
      { status: "unavailable", reason: "database_unreachable" },
      { status: 503, headers },
    );
  }
  const missing = missingCoreMigrations(applied);
  if (missing.length > 0) {
    logServerError("readiness: core migrations missing — run `pnpm db:app:migrate`", {
      kind: "schema-behind",
      missing,
    });
    return NextResponse.json(
      { status: "unavailable", reason: "schema_behind" },
      { status: 503, headers },
    );
  }
  return NextResponse.json({ status: "ready" }, { headers });
}
