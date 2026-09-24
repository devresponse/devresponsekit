import { NextResponse } from "next/server";
import { pgPool } from "@/db/database";
import { REQUIRED_CORE_MIGRATIONS, missingCoreMigrations } from "@/db/migrations/migration-plan";
import { betterAuthSchemaVerdict } from "@/lib/auth-schema-check.server";
import { getServerEnv, invalidServerEnvKeys } from "@/lib/env";
import { logServerError } from "@/lib/observability/logger.server";

export const dynamic = "force-dynamic";

type NotReadyReason = "config_invalid" | "database_unreachable" | "schema_behind";

/**
 * GET /api/health/ready — readiness probe.
 *
 * Verifies the app can serve real requests, in this order:
 *
 *   1. The server environment passes its schema (`getServerEnv()`).
 *   2. The database is reachable AND carries every core migration this build
 *      depends on ({@link REQUIRED_CORE_MIGRATIONS}). One fast primary-key
 *      lookup against the `app_schema_migrations` ledger covers both — it
 *      fails when the database is down, and comes back short when a migration
 *      is missing.
 *   3. Better Auth's own schema check passes: every table and column this
 *      configuration writes exists where the auth pool's `search_path`
 *      resolves (`auth-schema-check.server.ts`).
 *
 * Returns 200 `{status:"ready"}`, or 503 with a coarse `reason`:
 *   - `config_invalid` — a server variable fails the env schema, or Better
 *     Auth refused its configuration. F-26: this route used to answer 200
 *     for an instance whose every auth call 500ed on a bad env. On a Node
 *     server `register()` (src/instrumentation.ts) now stops startup for the
 *     same fault, so this is the backstop for a runtime that did not run the
 *     hook; the invalid KEY NAMES are logged (`kind: "config-invalid"`).
 *   - `database_unreachable` — the query failed (DB outage, pool not warm,
 *     or a database that was never migrated at all, which has no ledger).
 *   - `schema_behind` — the database answers but lacks a core migration or a
 *     Better Auth table/column the running code reads or writes. Production
 *     deploys from every push to `main` with no automated migrate step ahead
 *     of it (docs/deployment.md), so a build CAN go live before its
 *     migration; 0004 is the worked case (review #43 landing gate): without
 *     `secret_rotated_at` every request bearing an OAuth-client JWT and every
 *     admin secret rotation is a 500. F-26: a Better Auth table missing is
 *     worse, a 500 on EVERY auth call (#199 added `rateLimit` this way), and
 *     the ledger cannot see it because `db:auth:migrate` does not write to
 *     it. Reporting it here makes the gap a credential-free `curl`, and an
 *     orchestrator's `readinessProbe` stalls the rollout instead of routing
 *     traffic to a build that would 500 (the missing ids / tables are logged
 *     server-side for the operator; `pnpm db:app:migrate` /
 *     `pnpm db:auth:migrate` close the gap, and an instance that already saw
 *     a Better Auth gap also needs a restart, see auth-schema-check.server.ts).
 *
 * Unauthenticated and non-enumerating: the body never carries a variable
 * name, a migration id, a table name or the underlying error. The pool's
 * `connectionTimeoutMillis` bounds how long a down database can hang this
 * check. `no-store` so the result is never cached.
 */
export async function GET() {
  const headers = { "cache-control": "no-store" };
  const notReady = (reason: NotReadyReason) =>
    NextResponse.json({ status: "unavailable", reason }, { status: 503, headers });

  try {
    getServerEnv();
  } catch {
    logServerError("readiness: server environment invalid — fix the named variables", {
      kind: "config-invalid",
      keys: invalidServerEnvKeys(),
    });
    return notReady("config_invalid");
  }

  let applied: string[];
  try {
    const { rows } = await pgPool.query<{ id: string }>(
      "select id from app_schema_migrations where id = any($1::text[])",
      [REQUIRED_CORE_MIGRATIONS],
    );
    applied = rows.map((row) => row.id);
  } catch {
    return notReady("database_unreachable");
  }

  const authSchema = await betterAuthSchemaVerdict();
  if (authSchema.state === "misconfigured") {
    logServerError("readiness: Better Auth failed to initialise", {
      kind: "config-invalid",
      err: authSchema.error,
    });
    return notReady("config_invalid");
  }
  if (authSchema.state === "unreachable") {
    logServerError("readiness: Better Auth schema check failed", {
      kind: "auth-schema-check-failed",
      err: authSchema.error,
    });
    return notReady("database_unreachable");
  }

  // Both gaps are logged before answering, so one probe tells the operator
  // everything that is missing.
  const missing = missingCoreMigrations(applied);
  if (missing.length > 0) {
    logServerError("readiness: core migrations missing — run `pnpm db:app:migrate`", {
      kind: "schema-behind",
      missing,
    });
  }
  if (authSchema.state === "behind") {
    logServerError(
      "readiness: Better Auth schema behind — run `pnpm db:auth:migrate`, then restart this instance",
      { kind: "auth-schema-behind", findings: authSchema.findings },
    );
  }
  if (missing.length > 0 || authSchema.state === "behind") return notReady("schema_behind");
  return NextResponse.json({ status: "ready" }, { headers });
}
