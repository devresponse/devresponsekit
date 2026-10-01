import { describe, expect, it } from "vitest";
import {
  MAX_MIGRATION_LOCK_WAIT_MS,
  MIGRATION_LOCK_POLL_MS,
  resolveMigrationLockWait,
} from "@/db/migration-lock";
import { acquireMigrationLock, type LockClock } from "@/db/migrations/apply-migration";

/**
 * DEP2: `DB_MIGRATE_LOCK_WAIT_MS` bounds how long a migration runner waits for
 * the advisory lock both runners share. Unset is today's unbounded wait; a
 * whole number of milliseconds from 1 to an hour polls `pg_try_advisory_lock`
 * every second until then; anything else stops the runner before it connects.
 * The parse matrix is here, with the polling against a fake session and
 * clock; the real lock held by another session is
 * tests/db/migration-runner-guards.db.test.ts.
 */

const LOCK = "select pg_advisory_lock(hashtext('app_schema_migrations'))";
const TRY_LOCK = "select pg_try_advisory_lock(hashtext('app_schema_migrations')) as locked";

describe("resolveMigrationLockWait (DEP2)", () => {
  it.each([[undefined], [""], ["   "]])("is unbounded when unset (%j)", (raw) => {
    expect(resolveMigrationLockWait({ DB_MIGRATE_LOCK_WAIT_MS: raw })).toBeUndefined();
    expect(resolveMigrationLockWait({})).toBeUndefined();
  });

  it.each([
    ["1", 1],
    ["1000", 1000],
    ["1500", 1500],
    ["300000", 300_000],
    [String(MAX_MIGRATION_LOCK_WAIT_MS), MAX_MIGRATION_LOCK_WAIT_MS],
    [" 1500 ", 1500],
    ["0100", 100],
  ])("bounds the wait at %j ms", (raw, ms) => {
    expect(resolveMigrationLockWait({ DB_MIGRATE_LOCK_WAIT_MS: raw })).toBe(ms);
  });

  it.each([
    "0",
    String(MAX_MIGRATION_LOCK_WAIT_MS + 1),
    "-1",
    "1.5",
    "1e3",
    "5m",
    "300s",
    "abc",
    "1_000",
    "+5",
    "0x10",
    "Infinity",
    "NaN",
    "99999999999999999999",
  ])("refuses %j, naming it and the range", (raw) => {
    expect(() => resolveMigrationLockWait({ DB_MIGRATE_LOCK_WAIT_MS: raw })).toThrow(
      `DB_MIGRATE_LOCK_WAIT_MS must be a whole number of milliseconds from 1 to ${MAX_MIGRATION_LOCK_WAIT_MS}, or unset for an unbounded wait, got "${raw.trim()}".`,
    );
  });

  it("reads process.env by default", () => {
    const saved = process.env.DB_MIGRATE_LOCK_WAIT_MS;
    try {
      process.env.DB_MIGRATE_LOCK_WAIT_MS = "2500";
      expect(resolveMigrationLockWait()).toBe(2500);
    } finally {
      if (saved === undefined) delete process.env.DB_MIGRATE_LOCK_WAIT_MS;
      else process.env.DB_MIGRATE_LOCK_WAIT_MS = saved;
    }
  });
});

/** A session whose try-lock fails until `freeAfter` attempts, and a clock that sleeps instantly. */
function harness(freeAfter: number) {
  let now = 0;
  const statements: string[] = [];
  const sleeps: number[] = [];
  const client = {
    query: async (text: string) => {
      statements.push(text);
      const attempts = statements.filter((s) => s === TRY_LOCK).length;
      return { rows: text === TRY_LOCK ? [{ locked: attempts > freeAfter }] : [] };
    },
  };
  const clock: LockClock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { client: client as never, clock, statements, sleeps };
}

describe("acquireMigrationLock (DEP2)", () => {
  it("unbounded: one blocking pg_advisory_lock, as the runners always took", async () => {
    const { client, clock, statements, sleeps } = harness(Number.POSITIVE_INFINITY);
    await acquireMigrationLock(client, undefined, clock);
    expect(statements).toEqual([LOCK]);
    expect(sleeps).toEqual([]);
  });

  it("bounded: takes a free lock at once", async () => {
    const { client, clock, statements, sleeps } = harness(0);
    await acquireMigrationLock(client, 1500, clock);
    expect(statements).toEqual([TRY_LOCK]);
    expect(sleeps).toEqual([]);
  });

  it("bounded: retries every second and takes the lock once it is released", async () => {
    const { client, clock, statements, sleeps } = harness(2);
    await acquireMigrationLock(client, 5000, clock);
    expect(statements).toEqual([TRY_LOCK, TRY_LOCK, TRY_LOCK]);
    expect(sleeps).toEqual([MIGRATION_LOCK_POLL_MS, MIGRATION_LOCK_POLL_MS]);
  });

  it("bounded: tries once more at the deadline, then gives up naming the wait", async () => {
    const { client, clock, statements, sleeps } = harness(Number.POSITIVE_INFINITY);
    const attempt = acquireMigrationLock(client, 1500, clock);
    await expect(attempt).rejects.toThrow(
      "another session holds the migration lock: gave up after DB_MIGRATE_LOCK_WAIT_MS=1500ms and applied nothing.",
    );
    // At 0 ms, 1000 ms and 1500 ms: never a blocking pg_advisory_lock.
    expect(statements).toEqual([TRY_LOCK, TRY_LOCK, TRY_LOCK]);
    expect(sleeps).toEqual([1000, 500]);
  });

  it("bounded: the time a try takes counts against the wait", async () => {
    let now = 0;
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        now += 800; // a slow round trip
        return { rows: [{ locked: false }] };
      },
    };
    const clock: LockClock = { now: () => now, sleep: async (ms) => void (now += ms) };
    await expect(acquireMigrationLock(client as never, 2000, clock)).rejects.toThrow(
      "another session holds the migration lock",
    );
    // 0→800 (try), sleep 1000 → 1800, 1800→2600 (try): past the deadline.
    expect(statements).toHaveLength(2);
  });
});
