import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgPool } from "@/db/database";
import { applyMigrationInTransaction } from "@/db/migrations/apply-migration";

/**
 * DB-BACKED proof that a FAILING migration rolls back completely (source
 * review 2026-09-04, #84).
 *
 * The runner applies each file with `applyMigrationInTransaction` on ONE
 * checked-out `PoolClient`. This suite drives that exact function against a
 * live Postgres in a scratch schema and asserts the three properties the
 * runner's correctness rests on:
 *
 *   1. a file that fails halfway leaves NONE of its earlier statements behind
 *      (the `create table` before the error is gone),
 *   2. it leaves NO `app_schema_migrations` row (so the next run retries it
 *      rather than skipping a half-applied file forever),
 *   3. a failure of the LEDGER INSERT rolls the file's DDL back with it,
 *   4. the session is left usable — the transaction is really rolled back,
 *      not left aborted (a later statement would fail with 25P02).
 *
 * (3) is the case that actually discriminates: a migration file is sent as ONE
 * multi-statement query, which Postgres already wraps in an implicit
 * transaction, so (1) holds even without our `begin`. The ledger insert is a
 * separate statement — without the explicit transaction it can fail while the
 * file's DDL stays committed, leaving a migrated database with a blind ledger.
 * Delete the `begin`/`commit` from `apply-migration.ts` and (3) fails.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const SCHEMA = "__dbtest_migration_tx";

let client: PoolClient;

const ledgerIds = async (): Promise<string[]> => {
  const { rows } = await client.query<{ id: string }>(
    `select id from app_schema_migrations order by id`,
  );
  return rows.map((r) => r.id);
};

const tableExists = async (name: string): Promise<boolean> => {
  const { rows } = await client.query<{ ok: boolean }>(
    `select exists (
       select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'
     ) as ok`,
    [SCHEMA, name],
  );
  return rows[0]!.ok;
};

beforeAll(async () => {
  client = await pgPool.connect();
  await client.query(`drop schema if exists "${SCHEMA}" cascade`);
  await client.query(`create schema "${SCHEMA}"`);
  await client.query(`set search_path to "${SCHEMA}", public`);
  // The ledger the runner bootstraps before any file is considered.
  await client.query(`
    create table app_schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now(),
      checksum text
    );
  `);
});

afterAll(async () => {
  try {
    await client.query(`drop schema if exists "${SCHEMA}" cascade`);
  } finally {
    client.release();
    await pgPool.end();
  }
});

describe("applyMigrationInTransaction (scratch schema)", () => {
  it("commits the file and its ledger row together when the SQL succeeds", async () => {
    await applyMigrationInTransaction(client, {
      id: "9001-ok.sql",
      sql: `create table tx_ok (id int primary key);`,
      checksum: "checksum-ok",
    });

    expect(await tableExists("tx_ok")).toBe(true);
    expect(await ledgerIds()).toContain("9001-ok.sql");
    const { rows } = await client.query<{ checksum: string | null }>(
      `select checksum from app_schema_migrations where id = $1`,
      ["9001-ok.sql"],
    );
    expect(rows[0]!.checksum).toBe("checksum-ok");
  });

  it("rolls back every statement of a file that fails partway through", async () => {
    const before = await ledgerIds();

    await expect(
      applyMigrationInTransaction(client, {
        id: "9002-broken.sql",
        sql: `create table tx_broken (id int primary key);
              insert into tx_broken (id) values (1), (1);`, // duplicate key -> aborts
        checksum: "checksum-broken",
      }),
    ).rejects.toThrow(/duplicate key/i);

    // (1) the DDL that ran before the error is gone …
    expect(await tableExists("tx_broken")).toBe(false);
    // (2) … and nothing was ledgered, so the next run retries the file.
    expect(await ledgerIds()).toEqual(before);
  });

  it("rolls the FILE back when the ledger insert is what fails", async () => {
    // The discriminating case. A migration file is sent as ONE multi-statement
    // query, which Postgres already wraps in an implicit transaction — so a
    // file that fails inside itself unwinds even without our `begin`. The
    // ledger insert is a SEPARATE statement: without the explicit transaction
    // the file's DDL would be committed while the ledger row was refused,
    // leaving the database migrated but the ledger blind to it (the file would
    // then be re-applied on the next run). Delete the `begin`/`commit` from
    // apply-migration.ts and this test fails.
    await client.query(`insert into app_schema_migrations (id, checksum) values ($1, $2)`, [
      "9004-clash.sql",
      "checksum-preexisting",
    ]);

    await expect(
      applyMigrationInTransaction(client, {
        id: "9004-clash.sql", // already ledgered -> primary-key violation
        sql: `create table tx_ledger_clash (id int primary key);`,
        checksum: "checksum-clash",
      }),
    ).rejects.toThrow(/duplicate key/i);

    expect(await tableExists("tx_ledger_clash")).toBe(false);
    const { rows } = await client.query<{ checksum: string | null }>(
      `select checksum from app_schema_migrations where id = $1`,
      ["9004-clash.sql"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.checksum).toBe("checksum-preexisting");
  });

  it("leaves the session usable after a failure (transaction not left aborted)", async () => {
    const { rows } = await client.query<{ one: number }>(`select 1 as one`);
    expect(rows[0]!.one).toBe(1);

    // And a later, healthy migration still applies on the same client.
    await applyMigrationInTransaction(client, {
      id: "9003-after-failure.sql",
      sql: `create table tx_after (id int primary key);`,
      checksum: "checksum-after",
    });
    expect(await tableExists("tx_after")).toBe(true);
    expect(await ledgerIds()).toContain("9003-after-failure.sql");
  });
});
