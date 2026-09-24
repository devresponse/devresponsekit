import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ReadinessRoute from "@/app/api/health/ready/route";
import type { auth as AuthInstance } from "@/lib/auth";
import { REQUIRED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";
import { resolveDatabaseUrl } from "@/db/schema-config";

/**
 * DB-BACKED proof of the readiness probe's Better Auth half (F-26).
 *
 * The unit suite (tests/integration/health.test.ts) mocks Better Auth's
 * verdict; only a live Postgres proves the property production relies on:
 * readiness finds the Better Auth tables and columns where the AUTH POOL
 * finds them, through its `search_path`, with camelCase names such as
 * `"rateLimit"` quoted as Better Auth quotes them. Each "instance" below is a
 * fresh module graph with `DB_SCHEMA` pointing at a scratch schema: its own
 * pool, its own `auth`, its own Better Auth schema check, as a newly started
 * server would have. The dev database's real `auth` schema keeps its own
 * `rateLimit` throughout, so a 503 here can only come from resolving through
 * the instance's `search_path`, not from any table of that name anywhere.
 *
 * Pinned:
 *   1. A schema migrated by Better Auth's own migrator plus a complete ledger
 *      → 200 `ready`, and the kit's adapter really registers the check this
 *      probe reads (`validateSchema` never turned off).
 *   2. A Better Auth TABLE missing (the #199 `rateLimit` case) → 503
 *      `schema_behind`, the table named in the log only.
 *   3. A plugin COLUMN missing (the admin plugin's `session.impersonatedBy`)
 *      → 503 `schema_behind`.
 *   4. The gap repaired from OUTSIDE the instance (as `pnpm db:auth:migrate`
 *      from an operator's shell does) leaves an instance that already saw it
 *      at 503: Better Auth keeps a mismatch verdict until its own migrator
 *      runs in-process, so auth keeps failing there too. A restarted instance
 *      is ready. This is why the runbook says to restart after migrating, and
 *      it fails if better-auth ever starts re-checking, which would make that
 *      step unnecessary.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const SCHEMA = "__dbtest_readiness";

const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

interface Instance {
  route: typeof ReadinessRoute;
  auth: typeof AuthInstance;
}

/** Plain pool with no `search_path` option: DDL on the scratch schema, qualified. */
let admin: Pool;
const instancePools: Array<{ end(): Promise<void> }> = [];

/** A fresh module graph bound to {@link SCHEMA}, as a newly started server would be. */
async function freshInstance(): Promise<Instance> {
  vi.resetModules();
  vi.stubEnv("DB_SCHEMA", SCHEMA);
  const { pgPool } = await import("@/db/database");
  instancePools.push(pgPool);
  const route = await import("@/app/api/health/ready/route");
  const { auth } = await import("@/lib/auth");
  return { route, auth };
}

async function probe(instance: Instance): Promise<{ status: number; body: unknown }> {
  const res = await instance.route.GET();
  return { status: res.status, body: await res.json() };
}

/** The findings the route logged under `auth-schema-behind`, if any. */
function loggedAuthFindings(): unknown[] {
  const call = logServerError.mock.calls.find(
    (args) => (args[1] as { kind?: string } | undefined)?.kind === "auth-schema-behind",
  );
  return call ? (call[1] as { findings: unknown[] }).findings : [];
}

const q = (sql: string) => admin.query(sql);

beforeAll(async () => {
  admin = new Pool({ connectionString: resolveDatabaseUrl(), max: 1 });
  await q(`drop schema if exists "${SCHEMA}" cascade`);
  await q(`create schema "${SCHEMA}"`);
  // The app ledger, complete for this build, so only the Better Auth half can
  // fail the probe below.
  await q(`create table "${SCHEMA}".app_schema_migrations (
             id text primary key,
             applied_at timestamptz not null default now(),
             checksum text)`);
  await admin.query(
    `insert into "${SCHEMA}".app_schema_migrations (id) select unnest($1::text[])`,
    [REQUIRED_CORE_MIGRATIONS],
  );
  // Better Auth's own migrator, exactly as `pnpm db:auth:migrate` runs it.
  const { auth } = await freshInstance();
  const { getMigrations } = await import("better-auth/db/migration");
  const { runMigrations } = await getMigrations(
    auth.options as Parameters<typeof getMigrations>[0],
  );
  await runMigrations();
});

afterAll(async () => {
  try {
    for (const pool of instancePools) await pool.end().catch(() => {});
    await q(`drop schema if exists "${SCHEMA}" cascade`);
  } finally {
    await admin.end();
    vi.unstubAllEnvs();
  }
});

describe("readiness against a live Better Auth schema (F-26)", () => {
  it("is ready on a fully migrated schema, and reads the check the kit's adapter registers", async () => {
    logServerError.mockClear();
    const instance = await freshInstance();
    expect(await probe(instance)).toEqual({ status: 200, body: { status: "ready" } });
    expect(logServerError).not.toHaveBeenCalled();
    // The probe reads Better Auth's own verdict; without a registered check
    // (validateSchema: false) it would see nothing.
    expect(typeof (await instance.auth.$context).checkSchema).toBe("function");
  });

  it("reports schema_behind for a missing Better Auth table, and stays behind until the instance restarts", async () => {
    logServerError.mockClear();
    await q(`alter table "${SCHEMA}"."rateLimit" rename to "rateLimit_f26_gone"`);
    const stale = await freshInstance();
    try {
      const res = await probe(stale);
      expect(res).toEqual({
        status: 503,
        body: { status: "unavailable", reason: "schema_behind" },
      });
      expect(JSON.stringify(res.body)).not.toContain("rateLimit");
      expect(loggedAuthFindings()).toEqual([{ kind: "missing-table", table: "rateLimit" }]);
    } finally {
      await q(`alter table "${SCHEMA}"."rateLimit_f26_gone" rename to "rateLimit"`);
    }

    // Repaired from outside: the instance that saw the gap still refuses...
    expect((await probe(stale)).status).toBe(503);
    await expect((await stale.auth.$context).checkSchema?.()).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
    });
    // ...and a restarted one is ready.
    expect((await probe(await freshInstance())).status).toBe(200);
  });

  it("reports schema_behind for a missing plugin column, not only a missing table", async () => {
    logServerError.mockClear();
    await q(`alter table "${SCHEMA}"."session" drop column "impersonatedBy"`);
    try {
      const res = await probe(await freshInstance());
      expect(res).toEqual({
        status: 503,
        body: { status: "unavailable", reason: "schema_behind" },
      });
      expect(loggedAuthFindings()).toEqual([
        { kind: "missing-column", table: "session", column: "impersonatedBy" },
      ]);
    } finally {
      await q(`alter table "${SCHEMA}"."session" add column "impersonatedBy" text`);
    }
    expect((await probe(await freshInstance())).status).toBe(200);
  });
});
