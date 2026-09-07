import type { PoolClient } from "pg";

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
 */
export async function applyMigrationInTransaction(
  client: PoolClient,
  migration: { id: string; sql: string; checksum: string },
): Promise<void> {
  await client.query("begin");
  try {
    await client.query(migration.sql);
    await client.query(`insert into app_schema_migrations (id, checksum) values ($1, $2)`, [
      migration.id,
      migration.checksum,
    ]);
    await client.query("commit");
  } catch (error) {
    // Never let a failing rollback mask the error that caused it — and always
    // leave the session usable (an un-rolled-back failed transaction would
    // reject every later statement with 25P02).
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}
