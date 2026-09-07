import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type * as ApiKeysModule from "@/lib/api-auth/api-keys.server";

/**
 * Review #201 — compiles the throttled usage UPDATE through a REAL Kysely
 * query compiler (a dummy driver, so nothing is executed) and asserts the
 * generated SQL.
 *
 * Why a whole file for one string: Kysely splices a raw `where` fragment in
 * VERBATIM and joins `.where()` calls with `AND`, and `AND` binds tighter
 * than `OR`. An unparenthesised `last_used_at is null or last_used_at < …`
 * therefore compiles to `where id = $1 and last_used_at is null or
 * last_used_at < …` — which matches EVERY stale key in the table, not the one
 * being touched, and would stamp the whole table's `last_used_ip` with one
 * caller's address. The mocked-builder tests in
 * `api-keys-server-branches.test.ts` cannot see that: they never compile.
 */
const captured: string[] = [];

vi.mock("@/db/database", () => {
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === "query") captured.push(event.query.sql);
    },
  });
  return { db, pgPool: { query: async () => ({ rows: [] }), end: async () => {} } };
});

let mod: typeof ApiKeysModule;

beforeEach(async () => {
  captured.length = 0;
  mod = await import("@/lib/api-auth/api-keys.server");
});
afterEach(() => vi.resetModules());

describe("touchApiKeyUsage — compiled SQL", () => {
  it("scopes the interval guard to the targeted row with explicit parentheses", async () => {
    mod.touchApiKeyUsage("11111111-1111-1111-1111-111111111111", "203.0.113.5");
    // The write is fire-and-forget; let the promise settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toHaveLength(1);
    const sql = captured[0]!;
    expect(sql).toContain('where "id" = $2 and (last_used_at is null or last_used_at <');
    expect(sql).toContain("make_interval(secs => 60)");
    // The `or` must never escape the parentheses — that is the whole bug.
    expect(sql).not.toMatch(/and last_used_at is null or/);
  });
});
