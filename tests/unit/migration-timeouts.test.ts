import { readFileSync } from "node:fs";
import path from "node:path";
import { type ClientBase, Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SchemaConfig from "@/db/schema-config";
import {
  applyMigrationInTransaction,
  createMigrationPool,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  migrationTimeoutStatements,
  resolveMigrationTimeouts,
  RUNNER_SESSION_STATEMENTS,
} from "@/db/migrations/apply-migration";

/**
 * F-94: both migrators run every statement under a `lock_timeout` and an
 * explicit `statement_timeout`, so DDL that waits on a lock fails instead of
 * queueing every query on its table behind the ACCESS EXCLUSIVE request.
 *
 * Pinned here: the environment knobs and their defaults, the exact SET
 * statements the application runner issues inside each file's transaction
 * (after `begin`, before the file, `set local` so they end with it), the
 * application runner clearing any inherited ceiling on its own session before
 * it waits for the advisory lock, and the Better Auth runner handing its
 * migrator a pool that sets them on every connection instead of the runtime
 * pool. The DB half (a real lock wait
 * failing with 55P03, the settings as Postgres reports them) is
 * tests/db/migration-transaction.db.test.ts.
 */

// The Better Auth runner's collaborators. `createAppPool` stays real (a pool
// opens no connection until used); `ensureSchema` never reaches a database.
const getMigrations = vi.hoisted(() => vi.fn());
vi.mock("dotenv/config", () => ({}));
vi.mock("better-auth/db/migration", () => ({ getMigrations }));
// As in src/lib/auth.ts, the options name the RUNTIME pool as their database.
vi.mock("@/lib/auth", async () => {
  const { pgPool } = await import("@/db/database");
  return { auth: { options: { appName: "migration-timeouts-test", database: pgPool } } };
});
// `createAppPool` stays real unless a test hands it a fake pool to return.
const appPool = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("@/db/schema-config", async (importOriginal) => {
  const actual = await importOriginal<typeof SchemaConfig>();
  return {
    ...actual,
    ensureSchema: vi.fn(async () => undefined),
    createAppPool: (...args: Parameters<typeof actual.createAppPool>) =>
      (appPool.fake as Pool | undefined) ?? actual.createAppPool(...args),
  };
});

/** A client that records each statement and refuses the first one matching `failOn`. */
function recordingClient(failOn?: RegExp) {
  const statements: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      statements.push(text);
      if (failOn?.test(text)) throw new Error(`refused: ${text}`);
      // DEP2's session check (`assertMigrationSession`), answered as a
      // session in DB_SCHEMA with no ledger yet.
      if (text.includes("current_schema()")) {
        return { rows: [{ schema_name: params?.[0], login: "owner", ledger_owner: null }] };
      }
      return { rows: [] };
    },
  };
  return { client: client as unknown as PoolClient & ClientBase, statements };
}

const MIGRATION = {
  id: "9100-example.sql",
  sql: "alter table t add column c int;",
  checksum: "c1",
};
const LEDGER_INSERT = "insert into app_schema_migrations (id, checksum) values ($1, $2)";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  appPool.fake = undefined;
});

describe("resolveMigrationTimeouts (F-94)", () => {
  it("defaults to a 5 s lock wait and a 10 min statement ceiling", () => {
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS).toBe(600_000);
    expect(resolveMigrationTimeouts({})).toEqual({
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 600_000,
    });
    expect(
      resolveMigrationTimeouts({
        DB_MIGRATE_LOCK_TIMEOUT_MS: "  ",
        DB_MIGRATE_STATEMENT_TIMEOUT_MS: "",
      }),
    ).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 600_000 });
  });

  it("takes whole milliseconds from the environment, 0 included (disabled)", () => {
    expect(
      resolveMigrationTimeouts({
        DB_MIGRATE_LOCK_TIMEOUT_MS: " 2500 ",
        DB_MIGRATE_STATEMENT_TIMEOUT_MS: "0",
      }),
    ).toEqual({ lockTimeoutMs: 2_500, statementTimeoutMs: 0 });
  });

  it.each(["5s", "-1", "1.5", "1e3", "0x10", "2147483648"])(
    "refuses %j instead of silently running under another ceiling",
    (raw) => {
      expect(() => resolveMigrationTimeouts({ DB_MIGRATE_LOCK_TIMEOUT_MS: raw })).toThrow(
        /DB_MIGRATE_LOCK_TIMEOUT_MS must be a whole number of milliseconds/,
      );
      expect(() => resolveMigrationTimeouts({ DB_MIGRATE_STATEMENT_TIMEOUT_MS: raw })).toThrow(
        /DB_MIGRATE_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds/,
      );
    },
  );
});

describe("migrationTimeoutStatements (F-94)", () => {
  const timeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 600_000 };

  it("scopes to the transaction with `local`", () => {
    expect(migrationTimeoutStatements(timeouts, "local")).toEqual([
      "set local lock_timeout = '5000ms'",
      "set local statement_timeout = '600000ms'",
    ]);
  });

  it("scopes to the connection with `session`", () => {
    expect(migrationTimeoutStatements(timeouts, "session")).toEqual([
      "set lock_timeout = '5000ms'",
      "set statement_timeout = '600000ms'",
    ]);
  });
});

describe("applyMigrationInTransaction sets the ceilings for each file (F-94)", () => {
  it("issues set local lock_timeout / statement_timeout after begin and before the file", async () => {
    vi.stubEnv("DB_MIGRATE_LOCK_TIMEOUT_MS", "");
    vi.stubEnv("DB_MIGRATE_STATEMENT_TIMEOUT_MS", "");
    const { client, statements } = recordingClient();

    await applyMigrationInTransaction(client, MIGRATION);

    expect(statements).toEqual([
      "begin",
      "set local lock_timeout = '5000ms'",
      "set local statement_timeout = '600000ms'",
      MIGRATION.sql,
      LEDGER_INSERT,
      "commit",
    ]);
  });

  it("reads the environment when the caller passes no ceilings", async () => {
    vi.stubEnv("DB_MIGRATE_LOCK_TIMEOUT_MS", "1234");
    vi.stubEnv("DB_MIGRATE_STATEMENT_TIMEOUT_MS", "0");
    const { client, statements } = recordingClient();

    await applyMigrationInTransaction(client, MIGRATION);

    expect(statements.slice(1, 3)).toEqual([
      "set local lock_timeout = '1234ms'",
      "set local statement_timeout = '0ms'",
    ]);
  });

  it("uses the ceilings the runner resolved", async () => {
    const { client, statements } = recordingClient();

    await applyMigrationInTransaction(client, MIGRATION, {
      lockTimeoutMs: 250,
      statementTimeoutMs: 90_000,
    });

    expect(statements.slice(0, 4)).toEqual([
      "begin",
      "set local lock_timeout = '250ms'",
      "set local statement_timeout = '90000ms'",
      MIGRATION.sql,
    ]);
  });

  it("never runs the file when a setting is refused, and rolls back", async () => {
    const { client, statements } = recordingClient(/lock_timeout/);

    await expect(
      applyMigrationInTransaction(client, MIGRATION, {
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 600_000,
      }),
    ).rejects.toThrow(/refused/);

    expect(statements).toEqual(["begin", "set local lock_timeout = '5000ms'", "rollback"]);
  });
});

describe("createMigrationPool (F-94)", () => {
  it("sets both ceilings for the session on every new connection", async () => {
    const pool = createMigrationPool({ lockTimeoutMs: 700, statementTimeoutMs: 8_000 });
    try {
      const { client, statements } = recordingClient();
      await pool.options.onConnect?.(client);
      expect(statements).toEqual([
        "set lock_timeout = '700ms'",
        "set statement_timeout = '8000ms'",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("propagates a refused setting, so pg-pool rejects the checkout", async () => {
    const pool = createMigrationPool({ lockTimeoutMs: 700, statementTimeoutMs: 8_000 });
    try {
      const { client } = recordingClient(/statement_timeout/);
      await expect(Promise.resolve(pool.options.onConnect?.(client))).rejects.toThrow(/refused/);
    } finally {
      await pool.end();
    }
  });
});

describe("the runners (F-94)", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("db:app:migrate resolves the ceilings before connecting and hands them to every file", () => {
    const runner = read("src/db/migrations/run-migrations.ts");
    const resolved = runner.indexOf("const timeouts = resolveMigrationTimeouts();");
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(runner.indexOf("await pool.connect()"));
    expect(runner).toContain(
      "applyMigrationInTransaction(client, { id: migration.id, sql, checksum }, timeouts)",
    );
  });

  it("db:app:migrate clears the session's ceilings before the advisory lock, and each file sets its own", async () => {
    // A role default (deployment.md §5's `statement_timeout = '30s'`) would
    // otherwise cancel a second runner's wait for the advisory lock.
    vi.stubEnv("DATABASE_URL", "postgres://unused@localhost:5432/unused");
    vi.stubEnv("DB_MIGRATE_LOCK_TIMEOUT_MS", "321");
    vi.stubEnv("DB_MIGRATE_STATEMENT_TIMEOUT_MS", "");
    const { client, statements } = recordingClient();
    const session = Object.assign(client, { on: () => client, release: () => undefined });
    const end = vi.fn(async () => undefined);
    appPool.fake = { connect: async () => session, end };
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // The module runs main() on import; the fake ledger is empty, so it
    // applies every real file to the recording session.
    await import("@/db/migrations/run-migrations");
    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));

    expect(errors).not.toHaveBeenCalled();
    expect(RUNNER_SESSION_STATEMENTS).toEqual([
      "set lock_timeout = 0",
      "set statement_timeout = 0",
    ]);
    expect(statements.slice(0, 3)).toEqual([
      ...RUNNER_SESSION_STATEMENTS,
      "select pg_advisory_lock(hashtext('app_schema_migrations'))",
    ]);
    const begins = statements.flatMap((text, index) => (text === "begin" ? [index] : []));
    expect(begins.length).toBeGreaterThan(0);
    for (const index of begins) {
      expect(statements.slice(index + 1, index + 3)).toEqual([
        "set local lock_timeout = '321ms'",
        "set local statement_timeout = '600000ms'",
      ]);
    }
    expect(statements.at(-1)).toBe("select pg_advisory_unlock(hashtext('app_schema_migrations'))");
  });

  it("db:auth:migrate runs Better Auth's migrator on a migration pool, not the runtime pool", async () => {
    vi.stubEnv("DB_MIGRATE_LOCK_TIMEOUT_MS", "4321");
    vi.stubEnv("DB_MIGRATE_STATEMENT_TIMEOUT_MS", "");
    const runMigrations = vi.fn(async () => undefined);
    // DEP2: the runner holds one connection of the migration pool for the
    // run, for the advisory lock and the session check. What that session
    // had been sent when Better Auth was asked for its plan is kept.
    const { client: lockSession, statements: sessionStatements } = recordingClient();
    const release = vi.fn();
    vi.spyOn(Pool.prototype, "connect").mockImplementation((async () =>
      Object.assign(lockSession, { release })) as never);
    let sentBeforePlan: string[] = [];
    getMigrations.mockImplementation(async () => {
      sentBeforePlan = [...sessionStatements];
      return { runMigrations };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // The module runs main() on import.
    await import("@/db/migrations/run-better-auth-migrate");
    await vi.waitFor(() => expect(runMigrations).toHaveBeenCalledTimes(1));

    expect(errors).not.toHaveBeenCalled();
    expect(getMigrations).toHaveBeenCalledTimes(1);
    const config = getMigrations.mock.calls[0]![0] as { appName: string; database: Pool };
    // Better Auth's own options are kept; only the database is swapped.
    expect(config.appName).toBe("migration-timeouts-test");
    const { pgPool } = await import("@/db/database");
    expect(config.database).not.toBe(pgPool);

    const { client, statements } = recordingClient();
    await config.database.options.onConnect?.(client);
    expect(statements).toEqual([
      "set lock_timeout = '4321ms'",
      "set statement_timeout = '600000ms'",
    ]);
    // …and the runner ends that pool once the migrator is done.
    await vi.waitFor(() => expect(config.database.ended).toBe(true));

    // DEP2: before the plan, the held session cleared its ceilings, took the
    // application runner's lock and passed the session check; it unlocked
    // after the migrator and went back to the pool.
    expect(sentBeforePlan).toEqual([
      ...RUNNER_SESSION_STATEMENTS,
      "select pg_advisory_lock(hashtext('app_schema_migrations'))",
      expect.stringContaining("current_schema()"),
    ]);
    expect(sessionStatements.slice(sentBeforePlan.length)).toEqual([
      "select pg_advisory_unlock(hashtext('app_schema_migrations'))",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
