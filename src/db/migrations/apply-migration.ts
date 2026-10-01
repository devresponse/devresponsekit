import type { ClientBase, Pool, PoolClient } from "pg";
import { createAppPool } from "../schema-config";

/**
 * Lock and statement ceilings for every migration statement (F-94).
 *
 * `lock_timeout` is the one that protects live traffic. DDL such as
 * `alter table … add constraint` or `drop trigger` asks for ACCESS EXCLUSIVE,
 * and while that request WAITS (behind a long export's ACCESS SHARE, say)
 * Postgres queues every later reader and writer of the table behind it, so a
 * migrate-first deploy against a live database stalls every request that
 * touches the table for as long as the blocker runs. With a ceiling the
 * waiting statement fails instead, the file rolls back whole, and the
 * operator re-runs it once the blocker is gone (docs/troubleshooting.md).
 *
 * `statement_timeout` is set explicitly so a migration never inherits the
 * RUNTIME ceiling: the role default docs/deployment.md §5 tells a pooled
 * deployment to set (`statement_timeout = '30s'`) belongs to request queries,
 * and under it an index build or a VALIDATE on a large table could never
 * finish. The migration default is generous but finite, so one runaway
 * statement cannot hold its locks indefinitely.
 *
 * Both are milliseconds and `0` disables one (Postgres' own meaning), from
 * `DB_MIGRATE_LOCK_TIMEOUT_MS` / `DB_MIGRATE_STATEMENT_TIMEOUT_MS`.
 */
export interface MigrationTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;

/** Postgres stores both settings as an int of milliseconds. */
const MAX_TIMEOUT_MS = 2_147_483_647;

type Env = Readonly<Record<string, string | undefined>>;

function timeoutFromEnv(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  // Refuse rather than fall back: `30s` or `-1` is an operator asking for
  // something, and silently running under a different ceiling would hide it.
  // Nothing has connected yet when the runners resolve this.
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} must be a whole number of milliseconds from 0 (disabled) to ${MAX_TIMEOUT_MS}, got "${raw}".`,
    );
  }
  return Number(raw);
}

/** Reads the migration ceilings from the environment (F-94). Throws on a malformed value. */
export function resolveMigrationTimeouts(env: Env = process.env): MigrationTimeouts {
  return {
    lockTimeoutMs: timeoutFromEnv(
      env,
      "DB_MIGRATE_LOCK_TIMEOUT_MS",
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    ),
    statementTimeoutMs: timeoutFromEnv(
      env,
      "DB_MIGRATE_STATEMENT_TIMEOUT_MS",
      DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
    ),
  };
}

/**
 * The SET statements for {@link MigrationTimeouts}. `local` scopes them to the
 * current transaction, `session` to the connection. SET takes no bind
 * parameters, so the values are interpolated; both are numbers.
 */
export function migrationTimeoutStatements(
  timeouts: MigrationTimeouts,
  scope: "local" | "session",
): string[] {
  const set = scope === "local" ? "set local" : "set";
  return [
    `${set} lock_timeout = '${timeouts.lockTimeoutMs}ms'`,
    `${set} statement_timeout = '${timeouts.statementTimeoutMs}ms'`,
  ];
}

/**
 * Issued once on the application runner's dedicated session, right after
 * checkout and before `pg_advisory_lock` (F-94). A role default applies to
 * every session of that role: docs/deployment.md §5 has a pooled deployment
 * give its role `statement_timeout = '30s'`, and by default migrations connect
 * as that same role. Under it a second runner's wait for the advisory lock was
 * cancelled after 30 s instead of queueing behind the first. Clearing both
 * settings for the session makes that wait (and the ledger bootstrap and
 * reads around it) unbounded, as intended; each file's `set local` ceilings
 * still apply inside its own transaction.
 */
export const RUNNER_SESSION_STATEMENTS: readonly string[] = [
  "set lock_timeout = 0",
  "set statement_timeout = 0",
];

/**
 * A pool whose every connection runs under the migration ceilings for its
 * whole session (F-94). For Better Auth's migrator, which issues each of its
 * statements as its own auto-committed query through whatever pool it is
 * given: handed the runtime pool it ran with no `lock_timeout` and the
 * runtime's statement ceiling (30 s by default). `onConnect` is awaited
 * before pg-pool hands the connection out, and a failure rejects the
 * checkout, so no statement can run without the settings.
 */
export function createMigrationPool(timeouts: MigrationTimeouts): Pool {
  return createAppPool({
    onConnect: async (client: ClientBase) => {
      for (const statement of migrationTimeoutStatements(timeouts, "session")) {
        await client.query(statement);
      }
    },
  });
}

/** The one statement that writes a ledger row, inside the two helpers below only (#84). */
const LEDGER_INSERT_SQL = "insert into app_schema_migrations (id, checksum) values ($1, $2)";

/**
 * Applies ONE migration file atomically on a DEDICATED, checked-out
 * connection (review #84).
 *
 * Why this is its own module: `begin` / `commit` / `rollback` issued through
 * `pool.query` are only atomic by accident of connection reuse — a `pg` Pool
 * is free to serve each statement from a different backend, in which case the
 * `begin` opens a transaction on one connection while the DDL auto-commits on
 * another and the `rollback` unwinds nothing. Every statement of one migration
 * must therefore ride the SAME `PoolClient`, which is what this helper
 * requires by its signature.
 *
 * It also lets the rollback path be proven for real
 * (tests/db/migration-transaction.db.test.ts): a failing migration must leave
 * NEITHER its partial DDL NOR a ledger row behind.
 *
 * The ledger insert is deliberately inside the same transaction as the SQL:
 * either the file's effects and its `app_schema_migrations` row both land, or
 * neither does. A half-applied file with no ledger row would be re-applied on
 * the next run; a ledger row with no effects would be skipped forever.
 *
 * The file runs under {@link MigrationTimeouts} set with `set local` (F-94),
 * so they end with its transaction. The runner's session-level advisory lock
 * is taken outside any file and is an unbounded wait on purpose (the runner
 * clears both settings for its session first, {@link RUNNER_SESSION_STATEMENTS}):
 * a second runner should queue behind the first, and that wait blocks no
 * application query. Every lock a file takes is held until its commit, because the file
 * is one transaction; docs/deployment.md §5 has what that means for writing
 * one that is safe on a live database.
 */
export async function applyMigrationInTransaction(
  client: PoolClient,
  migration: { id: string; sql: string; checksum: string },
  timeouts: MigrationTimeouts = resolveMigrationTimeouts(),
): Promise<void> {
  await client.query("begin");
  try {
    for (const statement of migrationTimeoutStatements(timeouts, "local")) {
      await client.query(statement);
    }
    await client.query(migration.sql);
    await client.query(LEDGER_INSERT_SQL, [migration.id, migration.checksum]);
    await client.query("commit");
  } catch (error) {
    // Never let a failing rollback mask the error that caused it — and always
    // leave the session usable (an un-rolled-back failed transaction would
    // reject every later statement with 25P02).
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Ledgers a consolidated migration WITHOUT running it (MIG): the database
 * already holds its schema under the ids it folds
 * (`planConsolidatedMigrations` → `record`), so only the row is written, in
 * its own transaction on the runner's dedicated client like every other
 * ledger write. It touches only the ledger, which no application query
 * writes, so it runs without the per-file ceilings (F-94).
 */
export async function recordMigrationInTransaction(
  client: PoolClient,
  migration: { id: string; checksum: string },
): Promise<void> {
  await client.query("begin");
  try {
    await client.query(LEDGER_INSERT_SQL, [migration.id, migration.checksum]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}
