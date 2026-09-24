import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LivenessRoute from "@/app/api/health/route";
import type * as ReadinessRoute from "@/app/api/health/ready/route";
import { REQUIRED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";

/**
 * Health probes (OPS-1):
 *   - GET /api/health        → liveness: always 200, never touches the DB.
 *   - GET /api/health/ready  → readiness: 200 when the env is valid, the
 *                              ledger holds every core migration this build
 *                              needs AND Better Auth's schema check passes;
 *                              503 `config_invalid` for a bad env or a Better
 *                              Auth that did not initialise (F-26), 503
 *                              `schema_behind` when a core migration is
 *                              missing (review #43 landing gate — a build
 *                              promoted ahead of its migration) or a Better
 *                              Auth table/column is (F-26), 503
 *                              `database_unreachable` when a query throws.
 *
 * The env module is the REAL one, driven through `process.env`; the pool and
 * Better Auth's context are mocked. The DB-backed half, against real tables in
 * a scratch schema, is tests/db/readiness.db.test.ts.
 */
const query = vi.fn();
const logServerError = vi.fn();
/** Better Auth's `ctx.checkSchema`: returns nothing when clean, else a promise. */
const checkSchema = vi.fn<() => Promise<void> | undefined>();
/** How `auth.$context` settles; a test may make Better Auth fail to initialise. */
let authContext: () => Promise<unknown>;
vi.mock("@/db/database", () => ({ pgPool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logServerError(...a),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    get $context() {
      return authContext();
    },
  },
}));

const ledgerRows = (ids: readonly string[]) => ({ rows: ids.map((id) => ({ id })) });

/** The error better-auth 1.7 throws from `checkSchema` (`SchemaMismatchError`). */
function schemaMismatch(findings: Array<{ kind: string; table: string; column?: string }>) {
  return Object.assign(new Error("Database schema mismatch"), {
    code: "SCHEMA_MISMATCH",
    findings,
  });
}

/** Every `kind` the readiness route logged, in order. */
const loggedKinds = () =>
  logServerError.mock.calls.map((call) => (call[1] as { kind?: string } | undefined)?.kind);

let liveness: typeof LivenessRoute;
let readiness: typeof ReadinessRoute;

beforeEach(async () => {
  query.mockReset();
  logServerError.mockReset();
  checkSchema.mockReset();
  authContext = async () => ({ checkSchema: () => checkSchema() });
  liveness = await import("@/app/api/health/route");
  readiness = await import("@/app/api/health/ready/route");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("GET /api/health (liveness)", () => {
  it("returns 200 + ok without querying the database", async () => {
    const res = liveness.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("returns 200 + ready when the env is valid, the ledger is complete and the auth schema is clean", async () => {
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
    const res = await readiness.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ready" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(logServerError).not.toHaveBeenCalled();
    // Better Auth's own verdict was consulted (F-26), not skipped.
    expect(checkSchema).toHaveBeenCalledTimes(1);
  });

  it("asks the ledger for exactly the build's required core ids, in ONE query", async () => {
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
    await readiness.GET();
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("app_schema_migrations");
    expect(params).toEqual([REQUIRED_CORE_MIGRATIONS]);
    // The gate is only as good as the list: 0004 (the migration production
    // ran ahead of) MUST be in it.
    expect(REQUIRED_CORE_MIGRATIONS).toContain("0004-oauth-client-secret-rotated-at.sql");
  });

  it("returns 503 + schema_behind when a required core migration is missing, naming it only in the log", async () => {
    const missing = "0004-oauth-client-secret-rotated-at.sql";
    query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS.filter((id) => id !== missing)));
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable", reason: "schema_behind" });
    // Non-enumerating: the response never lists migration ids...
    expect(JSON.stringify(body)).not.toContain("0004");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // ...but the operator sees exactly which ones are missing in the log.
    expect(logServerError).toHaveBeenCalledTimes(1);
    const [, fields] = logServerError.mock.calls[0] as [string, { missing: string[] }];
    expect(fields.missing).toEqual([missing]);
  });

  it("treats an empty ledger (never-migrated database) as schema_behind, not ready", async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ status: "unavailable", reason: "schema_behind" });
    const [, fields] = logServerError.mock.calls[0] as [string, { missing: string[] }];
    expect(fields.missing).toEqual([...REQUIRED_CORE_MIGRATIONS]);
  });

  it("returns 503 + database_unreachable when the pool query throws, without leaking the error", async () => {
    query.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432"));
    const res = await readiness.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable", reason: "database_unreachable" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(logServerError).not.toHaveBeenCalled();
    // A down database never reaches Better Auth's check.
    expect(checkSchema).not.toHaveBeenCalled();
  });

  describe("F-26: the server environment", () => {
    it("returns 503 + config_invalid for an env that fails the schema, logging key NAMES only", async () => {
      // A 20-char secret: the scenario the review named. The route is
      // re-imported after resetModules, so the env module's cache is empty
      // and the real schema sees this value.
      const shortSecret = "twenty-chars-secret!";
      vi.stubEnv("BETTER_AUTH_SECRET", shortSecret);
      vi.resetModules();
      readiness = await import("@/app/api/health/ready/route");
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));

      const res = await readiness.GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "unavailable", reason: "config_invalid" });
      expect(res.headers.get("cache-control")).toBe("no-store");
      // Non-enumerating: no variable name in the body.
      expect(JSON.stringify(body)).not.toContain("BETTER_AUTH_SECRET");
      // The operator gets the key name and nothing else: no value, no rule.
      expect(loggedKinds()).toEqual(["config-invalid"]);
      const [, fields] = logServerError.mock.calls[0] as [string, { keys: string[] }];
      expect(fields.keys).toEqual(["BETTER_AUTH_SECRET"]);
      expect(JSON.stringify(logServerError.mock.calls)).not.toContain(shortSecret);
      // Nothing else was attempted on a config it cannot trust.
      expect(query).not.toHaveBeenCalled();
      expect(checkSchema).not.toHaveBeenCalled();
    });

    it("names every invalid key once, sorted, for a multi-key fault", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "short");
      vi.stubEnv("SSO_HANDOFF_ISSUER", "httsp://issuer.example.com");
      vi.resetModules();
      readiness = await import("@/app/api/health/ready/route");

      const res = await readiness.GET();
      await expect(res.json()).resolves.toEqual({
        status: "unavailable",
        reason: "config_invalid",
      });
      const [, fields] = logServerError.mock.calls[0] as [string, { keys: string[] }];
      expect(fields.keys).toEqual(["BETTER_AUTH_SECRET", "SSO_HANDOFF_ISSUER"]);
      expect(JSON.stringify(logServerError.mock.calls)).not.toContain("httsp");
    });

    it("returns 503 + config_invalid when Better Auth fails to initialise", async () => {
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
      authContext = () => Promise.reject(new Error("Invalid base URL"));
      const res = await readiness.GET();
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        status: "unavailable",
        reason: "config_invalid",
      });
      expect(loggedKinds()).toEqual(["config-invalid"]);
    });
  });

  describe("F-26: the Better Auth schema", () => {
    it("returns 503 + schema_behind when Better Auth finds a table missing, naming it only in the log", async () => {
      // The #199 case: the ledger is complete, but `rateLimit` was never
      // created because nobody ran `pnpm db:auth:migrate`.
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
      checkSchema.mockReturnValue(
        Promise.reject(schemaMismatch([{ kind: "missing-table", table: "rateLimit" }])),
      );
      const res = await readiness.GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "unavailable", reason: "schema_behind" });
      expect(JSON.stringify(body)).not.toContain("rateLimit");
      expect(loggedKinds()).toEqual(["auth-schema-behind"]);
      const [message, fields] = logServerError.mock.calls[0] as [string, { findings: unknown }];
      expect(message).toContain("pnpm db:auth:migrate");
      expect(fields.findings).toEqual([{ kind: "missing-table", table: "rateLimit" }]);
    });

    it("reports a missing column the same way (a plugin column, not just a table)", async () => {
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
      checkSchema.mockReturnValue(
        Promise.reject(
          schemaMismatch([{ kind: "missing-column", table: "session", column: "impersonatedBy" }]),
        ),
      );
      const res = await readiness.GET();
      await expect(res.json()).resolves.toEqual({
        status: "unavailable",
        reason: "schema_behind",
      });
      const [, fields] = logServerError.mock.calls[0] as [string, { findings: unknown }];
      expect(fields.findings).toEqual([
        { kind: "missing-column", table: "session", column: "impersonatedBy" },
      ]);
    });

    it("logs BOTH gaps when the ledger and the auth schema are behind, answering one 503", async () => {
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS.slice(1)));
      checkSchema.mockReturnValue(
        Promise.reject(schemaMismatch([{ kind: "missing-table", table: "rateLimit" }])),
      );
      const res = await readiness.GET();
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        status: "unavailable",
        reason: "schema_behind",
      });
      expect(loggedKinds()).toEqual(["schema-behind", "auth-schema-behind"]);
    });

    it("returns 503 + database_unreachable when Better Auth's check cannot reach the database, and logs it", async () => {
      query.mockResolvedValue(ledgerRows(REQUIRED_CORE_MIGRATIONS));
      checkSchema.mockReturnValue(Promise.reject(new Error("Connection terminated unexpectedly")));
      const res = await readiness.GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "unavailable", reason: "database_unreachable" });
      expect(JSON.stringify(body)).not.toContain("Connection terminated");
      expect(loggedKinds()).toEqual(["auth-schema-check-failed"]);
    });
  });
});
