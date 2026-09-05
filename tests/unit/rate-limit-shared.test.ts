import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type * as SharedModule from "@/lib/admin/rate-limit-shared.server";
import type * as InMemoryModule from "@/lib/admin/rate-limit.server";

/**
 * Unit tests for the Postgres-backed pre-auth limiter (review #98) — the
 * parts that need no database: how a statement result is interpreted, the
 * `Retry-After` arithmetic, the prune budget guard, and above all the FAILURE
 * POLICY: a backend error must fall back to the in-process bucket, log one
 * structured warning, count on the metrics scrape, and stop hammering the
 * database for the cool-down. Atomicity under concurrency is proved against
 * live Postgres in tests/db/rate-limit-shared.db.test.ts.
 *
 * The database is a real Kysely instance over a scripted driver, so the SQL
 * the module builds is compiled by the real Postgres compiler and every
 * round trip is observable.
 */
type Row = Record<string, unknown>;
type Script = (compiled: CompiledQuery) => Promise<QueryResult<Row>>;

const script = vi.hoisted(() => ({
  handler: null as null | ((compiled: { sql: string; parameters: readonly unknown[] }) => unknown),
  calls: [] as { sql: string; parameters: readonly unknown[] }[],
}));
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/observability/logger.server", () => ({
  logger: { warn: warnSpy, error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/db/database", () => {
  class ScriptedDriver implements Driver {
    async init() {}
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
          script.calls.push({ sql: compiled.sql, parameters: compiled.parameters });
          if (!script.handler) throw new Error("no script installed");
          return (await (script.handler as Script)(compiled)) as QueryResult<R>;
        },
        async *streamQuery(): AsyncIterableIterator<never> {
          throw new Error("not used");
        },
      };
    }
    async beginTransaction() {}
    async commitTransaction() {}
    async rollbackTransaction() {}
    async releaseConnection() {}
    async destroy() {}
  }
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db };
});

const OPTS = { capacity: 3, refillPerSec: 0.5 };

/** Scripts the consume statement to answer `allowed` / `denied` with the given prior row. */
function answer(
  rows: {
    tokens_after: number | null;
    prior_tokens: number | null;
    prior_updated_at: Date | null;
  }[],
): void {
  script.handler = (compiled) => {
    if (compiled.sql.includes("delete from")) return { rows: [], numAffectedRows: 0n };
    return { rows };
  };
}

function consumeCalls() {
  return script.calls.filter((c) => c.sql.includes("insert into"));
}

let mod: typeof SharedModule;
let inMemory: typeof InMemoryModule;

beforeEach(async () => {
  script.handler = null;
  script.calls = [];
  warnSpy.mockReset();
  vi.resetModules();
  mod = await import("@/lib/admin/rate-limit-shared.server");
  inMemory = await import("@/lib/admin/rate-limit.server");
  inMemory.__resetRateLimitForTests();
  mod.__resetSharedRateLimitForTests();
  (await import("@/lib/observability/metrics.server")).__resetMetricsForTests();
});
afterEach(() => vi.resetModules());

describe("consumeSharedToken — statement result interpretation", () => {
  it("allows when the statement returned a post-consume balance", async () => {
    answer([{ tokens_after: 2, prior_tokens: 3, prior_updated_at: new Date(0) }]);
    expect(await mod.consumeSharedToken("scope:k", OPTS, 1_000)).toEqual({ ok: true });
    expect(consumeCalls()).toHaveLength(1);
    // The bucket parameters travel with the call: key, capacity, now, refill.
    const params = consumeCalls()[0]!.parameters;
    expect(params).toContain("scope:k");
    expect(params).toContain(OPTS.capacity);
    expect(params).toContain(OPTS.refillPerSec);
    expect(params).toContain(1_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("denies with a Retry-After derived from the prior row (mirrors the in-memory arithmetic)", async () => {
    // 0.5 tokens, 1 s ago at 0.5/s → refilled 1.0 would allow, so the row
    // must be older: 0.2 tokens, 0.4 s ago → 0.4 refilled → 0.6 short → 2 s.
    answer([{ tokens_after: null, prior_tokens: 0.2, prior_updated_at: new Date(9_600) }]);
    expect(await mod.consumeSharedToken("scope:k", OPTS, 10_000)).toEqual({
      ok: false,
      retryAfterSeconds: 2,
    });
    // Empty bucket at a slow refill → the full one-token wait.
    answer([{ tokens_after: null, prior_tokens: 0, prior_updated_at: new Date(10_000) }]);
    expect(
      await mod.consumeSharedToken("scope:k", { capacity: 3, refillPerSec: 0.05 }, 10_000),
    ).toEqual({ ok: false, retryAfterSeconds: 20 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("denies with the one-token wait when the row vanished under a concurrent prune", async () => {
    answer([{ tokens_after: null, prior_tokens: null, prior_updated_at: null }]);
    expect(await mod.consumeSharedToken("scope:k", OPTS, 10_000)).toEqual({
      ok: false,
      retryAfterSeconds: 2,
    });
  });

  it("refuses a budget the prune window cannot cover, and degenerate budgets", async () => {
    answer([{ tokens_after: 1, prior_tokens: null, prior_updated_at: null }]);
    // 7200 tokens at 1/s takes 2 h to refill — longer than the 1 h stale window.
    await expect(
      mod.consumeSharedToken("scope:k", { capacity: 7_200, refillPerSec: 1 }),
    ).rejects.toThrow(/fully refill within 3600s/);
    await expect(
      mod.consumeSharedToken("scope:k", { capacity: 0, refillPerSec: 1 }),
    ).rejects.toThrow(/capacity must be >= 1/);
    await expect(
      mod.consumeSharedToken("scope:k", { capacity: 5, refillPerSec: 0 }),
    ).rejects.toThrow(/refillPerSec > 0/);
    // A refused budget never reaches the database.
    expect(consumeCalls()).toHaveLength(0);
  });
});

describe("consumeSharedToken — failure policy (fallback, warning, cool-down)", () => {
  it("falls back to the in-process bucket for the SAME key, warns once, counts, and skips the DB during the cool-down", async () => {
    script.handler = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const t0 = 100_000;
    // Capacity 3 in memory: three allows, then a deny — real bucket
    // arithmetic, not a fail-open `{ ok: true }`.
    expect(await mod.consumeSharedToken("csp.report:__global__", OPTS, t0)).toEqual({ ok: true });
    expect(await mod.consumeSharedToken("csp.report:__global__", OPTS, t0)).toEqual({ ok: true });
    expect(await mod.consumeSharedToken("csp.report:__global__", OPTS, t0)).toEqual({ ok: true });
    expect((await mod.consumeSharedToken("csp.report:__global__", OPTS, t0)).ok).toBe(false);

    // ONE round trip failed; the next three never touched the database.
    expect(consumeCalls()).toHaveLength(1);
    // ONE structured warning naming the scope (never the actor half of the
    // key, which may be an IP) and the error.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/shared rate-limit backend unavailable/);
    expect(fields).toMatchObject({
      scope: "csp.report",
      cooldownMs: mod.SHARED_FALLBACK_COOLDOWN_MS,
      err: { name: "Error", message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(JSON.stringify(fields)).not.toContain("__global__");
    // Visible on the metrics scrape, by scope.
    const { rateLimitSharedFallbacksTotal } = await import("@/lib/observability/metrics.server");
    const sample = (await rateLimitSharedFallbacksTotal.get()).values.find(
      (v) => v.labels.scope === "csp.report",
    );
    expect(sample?.value).toBe(1);

    // The in-memory bucket the fallback used is the real module-level one, so
    // the deny above is the SAME bucket a direct consumeToken sees.
    expect(inMemory.consumeToken("csp.report:__global__", OPTS, t0).ok).toBe(false);
  });

  it("retries the database once the cool-down has elapsed", async () => {
    script.handler = () => {
      throw new Error("boom");
    };
    const t0 = 100_000;
    await mod.consumeSharedToken("scope:k", OPTS, t0);
    expect(consumeCalls()).toHaveLength(1);

    // Still inside the cool-down: no round trip.
    await mod.consumeSharedToken("scope:k", OPTS, t0 + mod.SHARED_FALLBACK_COOLDOWN_MS - 1);
    expect(consumeCalls()).toHaveLength(1);

    // Backend recovered and the cool-down is over: shared again, no new warning.
    answer([{ tokens_after: 2, prior_tokens: 3, prior_updated_at: new Date(t0) }]);
    expect(
      await mod.consumeSharedToken("scope:k", OPTS, t0 + mod.SHARED_FALLBACK_COOLDOWN_MS),
    ).toEqual({ ok: true });
    expect(consumeCalls()).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("opportunistic prune", () => {
  it("runs at most once per interval, deleting rows older than the stale window, and never blocks the consume", async () => {
    const deletes: { sql: string; parameters: readonly unknown[] }[] = [];
    script.handler = (compiled) => {
      if (compiled.sql.includes("delete from")) {
        deletes.push({ sql: compiled.sql, parameters: compiled.parameters });
        return { rows: [], numAffectedRows: 2n };
      }
      return { rows: [{ tokens_after: 1, prior_tokens: null, prior_updated_at: null }] };
    };
    const t0 = 10 * 60 * 60 * 1000; // 10 h, so cutoff = 9 h
    await mod.consumeSharedToken("scope:k", OPTS, t0);
    await mod.consumeSharedToken("scope:k", OPTS, t0 + 1_000);
    await mod.consumeSharedToken("scope:k", OPTS, t0 + mod.SHARED_PRUNE_INTERVAL_MS - 1);
    await vi.waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]!.sql).toMatch(/delete from "app_rate_limits" where "updated_at" < \$1/);
    expect(deletes[0]!.parameters[0]).toEqual(new Date(t0 - mod.SHARED_STALE_AFTER_MS));

    await mod.consumeSharedToken("scope:k", OPTS, t0 + mod.SHARED_PRUNE_INTERVAL_MS);
    await vi.waitFor(() => expect(deletes).toHaveLength(2));
  });

  it("a failing prune is logged and does not fail the consume", async () => {
    script.handler = (compiled) => {
      if (compiled.sql.includes("delete from")) throw new Error("prune boom");
      return { rows: [{ tokens_after: 1, prior_tokens: null, prior_updated_at: null }] };
    };
    expect(await mod.consumeSharedToken("scope:k", OPTS, 5_000_000)).toEqual({ ok: true });
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    expect(warnSpy.mock.calls[0]?.[1]).toMatch(/prune failed/);
  });
});

describe("enforceSharedRateLimit", () => {
  it("returns null on allow and the standard 429 envelope with Retry-After on deny", async () => {
    answer([{ tokens_after: 0, prior_tokens: 1, prior_updated_at: new Date(0) }]);
    expect(await mod.enforceSharedRateLimit("invitations.accept", "ba-1", OPTS)).toBeNull();

    answer([{ tokens_after: null, prior_tokens: 0, prior_updated_at: new Date(1_000) }]);
    const denied = await mod.enforceSharedRateLimit(
      "invitations.accept",
      "ba-1",
      OPTS,
      undefined,
      undefined,
      1_000,
    );
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBe("2");
    expect(await denied!.json()).toMatchObject({ error: "rate_limited", retryAfter: 2 });
    // The key the shared bucket saw is the composed scope:actor key.
    expect(consumeCalls()[0]!.parameters).toContain("invitations.accept:ba-1");
  });
});
