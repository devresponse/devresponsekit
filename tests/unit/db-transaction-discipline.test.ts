import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source invariant: every multi-statement transaction in the db tooling runs
 * on a CHECKED-OUT connection (source review 2026-09-04, #84).
 *
 * `pool.query("begin")` is the bug this pins shut. A `pg` Pool may serve each
 * statement from a different backend, so a `begin` issued that way can open a
 * transaction on one connection while the writes — and the `commit` — land on
 * others: the "transaction" is then atomic only by accident of pg-pool reuse
 * internals, and the `rollback` unwinds nothing. Every one of these scripts
 * must therefore `pool.connect()` once and issue `begin` / `commit` /
 * `rollback` on that client (releasing it in `finally`).
 *
 * The behavioural half of this proof — a failing migration really rolling
 * back — is `tests/db/migration-transaction.db.test.ts`; this half is what
 * catches a revert, since a quiet pool would hand a reverted script the same
 * connection every time and the behaviour test would still pass.
 */
const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Every script that opens a transaction against the app database. */
const TRANSACTIONAL_SCRIPTS = [
  "src/db/migrations/apply-migration.ts",
  "src/db/seeds/seed-local.ts",
  "src/db/reset-database.ts",
];

/** Scripts that must hold ONE connection for the whole run. */
const CONNECT_HOLDERS = [
  "src/db/migrations/run-migrations.ts",
  "src/db/seeds/seed-local.ts",
  "src/db/reset-database.ts",
];

describe("db tooling transaction discipline (#84)", () => {
  it.each(TRANSACTIONAL_SCRIPTS)("%s issues begin/commit/rollback on a client", (rel) => {
    const source = read(rel);
    for (const verb of ["begin", "commit", "rollback"]) {
      expect(source, `${rel} should issue "${verb}" on the checked-out client`).toContain(
        `client.query("${verb}")`,
      );
    }
  });

  it.each([...TRANSACTIONAL_SCRIPTS, "src/db/migrations/run-migrations.ts"])(
    "%s never issues a transaction verb through the pool",
    (rel) => {
      const source = read(rel);
      // `pool.query("begin")` and friends — the exact defect of #84.
      expect(source).not.toMatch(/\bpool\.query\(\s*["'`](?:begin|commit|rollback)\b/i);
    },
  );

  it.each(CONNECT_HOLDERS)("%s checks out a connection and releases it", (rel) => {
    const source = read(rel);
    expect(source).toMatch(/await\s+pool\.connect\(\)/);
    expect(source).toMatch(/client\.release\(\)/);
  });

  it("the migration runner applies files through the transactional helper only", () => {
    const runner = read("src/db/migrations/run-migrations.ts");
    expect(runner).toContain("applyMigrationInTransaction(client,");
    // The ledger insert must live INSIDE that helper's transaction, never as a
    // free-standing statement in the runner loop.
    expect(runner).not.toMatch(/insert into app_schema_migrations \(id, checksum\)/);
    expect(read("src/db/migrations/apply-migration.ts")).toMatch(
      /insert into app_schema_migrations \(id, checksum\)/,
    );
  });
});
