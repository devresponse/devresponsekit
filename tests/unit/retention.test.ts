import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RetentionModule from "@/lib/retention.server";

/**
 * Unit tests for the data-retention pruner (review D3). The DB layer is
 * stubbed; these pin the per-table behavior and the safety rules:
 *   - 0-day windows disable a table's prune (nothing issued)
 *   - the audit prune goes through `app_audit_events_prune()` — the
 *     SECURITY DEFINER function that is the trigger's only sanctioned DELETE
 *     path (review #83) — and never issues a DELETE or sets a GUC itself
 *   - the outbox prune never touches `pending` rows
 *   - every loop is batched and stops at the caller's deadline (F-96)
 */
const state = vi.hoisted(() => ({
  auditDeleted: 0 as number,
  // When set, each audit prune call shifts one value off this queue — so a
  // multi-batch backlog can be simulated. Falls back to `auditDeleted`.
  auditBatches: null as number[] | null,
  outboxDeleted: 0n as bigint,
  outboxUpdated: 0n as bigint,
  // Per-statement queues for the batched outbox loops (F-96), like
  // `auditBatches`; each falls back to the scalar above when null.
  outboxDeleteBatches: null as bigint[] | null,
  outboxUpdateBatches: null as bigint[] | null,
  revoked: 0,
  outboxWhere: [] as unknown[][],
  outboxSetWhere: [] as unknown[][],
  /** The `id in (select … limit N)` subquery each batched outbox statement builds. */
  subqueryFrom: [] as string[],
  subqueryWhere: [] as unknown[][],
  subqueryLimits: [] as number[],
  /** Runs after every stubbed statement, so a test can move the clock. */
  onStatement: null as (() => void) | null,
  /** Every raw statement sent through `db.executeQuery` (the audit prune calls). */
  rawQueries: [] as string[],
  /** The bound parameters of each raw statement, in order. */
  rawParams: [] as unknown[][],
  /** Every table a DELETE was built against. */
  deletedFrom: [] as string[],
}));

function deleteChain(table: string) {
  state.deletedFrom.push(table);
  const chain = {
    where: (...args: unknown[]) => {
      if (table === "app_outbox") state.outboxWhere.push(args);
      return chain;
    },
    executeTakeFirst: async () => {
      state.onStatement?.();
      const n = state.outboxDeleteBatches
        ? (state.outboxDeleteBatches.shift() ?? 0n)
        : state.outboxDeleted;
      return { numDeletedRows: n };
    },
  };
  return chain;
}

function updateChain() {
  const chain = {
    set: () => chain,
    where: (...args: unknown[]) => {
      state.outboxSetWhere.push(args);
      return chain;
    },
    executeTakeFirst: async () => {
      state.onStatement?.();
      const n = state.outboxUpdateBatches
        ? (state.outboxUpdateBatches.shift() ?? 0n)
        : state.outboxUpdated;
      return { numUpdatedRows: n };
    },
  };
  return chain;
}

function subqueryChain(table: string) {
  state.subqueryFrom.push(table);
  const chain = {
    select: () => chain,
    where: (...args: unknown[]) => {
      state.subqueryWhere.push(args);
      return chain;
    },
    limit: (n: number) => {
      state.subqueryLimits.push(n);
      return chain;
    },
  };
  return chain;
}

/**
 * Minimal Kysely-shaped executor: the audit prune sends a
 * `CompiledQuery.raw(...)` through `db.executeQuery`; nothing else does.
 */
const dbStub = {
  executeQuery: async (q: { sql: string; parameters: readonly unknown[] }) => {
    state.rawQueries.push(q.sql);
    state.rawParams.push([...q.parameters]);
    state.onStatement?.();
    const n = state.auditBatches ? (state.auditBatches.shift() ?? 0) : state.auditDeleted;
    return { rows: [{ n }] };
  },
  deleteFrom: (t: string) => deleteChain(t),
  updateTable: () => updateChain(),
  selectFrom: (t: string) => subqueryChain(t),
};

vi.mock("@/db/database", () => ({ db: dbStub }));

vi.mock("@/lib/api-auth/revocation.server", () => ({
  pruneExpiredRevocations: async () => state.revoked,
}));

let mod: typeof RetentionModule;

beforeEach(async () => {
  state.auditDeleted = 0;
  state.auditBatches = null;
  state.outboxDeleted = 0n;
  state.outboxUpdated = 0n;
  state.outboxDeleteBatches = null;
  state.outboxUpdateBatches = null;
  state.revoked = 0;
  state.outboxWhere = [];
  state.outboxSetWhere = [];
  state.subqueryFrom = [];
  state.subqueryWhere = [];
  state.subqueryLimits = [];
  state.onStatement = null;
  state.rawQueries = [];
  state.rawParams = [];
  state.deletedFrom = [];
  mod = await import("@/lib/retention.server");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.AUDIT_RETENTION_DAYS;
  delete process.env.OUTBOX_RETENTION_DAYS;
  delete process.env.OUTBOX_MAX_PENDING_DAYS;
});

describe("retentionDays", () => {
  it("falls back when unset, empty, non-numeric, or negative", () => {
    expect(mod.retentionDays(undefined, 90)).toBe(90);
    expect(mod.retentionDays("  ", 90)).toBe(90);
    expect(mod.retentionDays("nope", 90)).toBe(90);
    expect(mod.retentionDays("-5", 90)).toBe(90);
  });
  it("parses and floors a valid value", () => {
    expect(mod.retentionDays("30", 90)).toBe(30);
    expect(mod.retentionDays("45.9", 90)).toBe(45);
    expect(mod.retentionDays("0", 90)).toBe(0);
  });
});

describe("pruneAuditEvents", () => {
  it("is a no-op for a 0-day window (nothing issued)", async () => {
    expect(await mod.pruneAuditEvents(0)).toBe(0);
    expect(state.rawQueries).toHaveLength(0);
  });
  it("prunes ONLY through app_audit_events_prune() — no client-side DELETE, no GUC (review #83)", async () => {
    state.auditDeleted = 4;
    expect(await mod.pruneAuditEvents(30)).toBe(4);
    expect(state.rawQueries).toHaveLength(1);
    expect(state.rawQueries[0]).toMatch(/select app_audit_events_prune\(\$1, \$2\)/);
    expect(state.rawParams[0]).toEqual([30, 5000]);
    expect(state.rawQueries[0]).not.toMatch(/audit_retention/);
    expect(state.deletedFrom).not.toContain("app_audit_events");
  });
  it("raises a window below the database floor to the floor, and says so (review #83)", async () => {
    // The database clamps regardless (migration 0005, `c_floor_days`); the
    // worker mirrors it so the log matches what actually happens. 0 stays a
    // disable, not a floor.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.auditDeleted = 1;
    expect(mod.AUDIT_RETENTION_FLOOR_DAYS).toBe(30);
    expect(await mod.pruneAuditEvents(1)).toBe(1);
    expect(state.rawParams[0]).toEqual([30, 5000]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/below the database floor of 30 days/));
    warn.mockClear();
    expect(await mod.pruneAuditEvents(31)).toBe(1);
    expect(state.rawParams[1]).toEqual([31, 5000]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("accepts a string count (a driver may hand an integer back as text)", async () => {
    state.auditBatches = ["3" as unknown as number];
    expect(await mod.pruneAuditEvents(30)).toBe(3);
  });
  it("calls the function in batches until a short batch, summing the total (audit #21)", async () => {
    // batchSize 2: two full batches then a short one → loop stops, total = 5.
    state.auditBatches = [2, 2, 1];
    expect(await mod.pruneAuditEvents(30, 2)).toBe(5);
    expect(state.rawQueries).toHaveLength(3);
    expect(state.rawParams).toEqual([
      [30, 2],
      [30, 2],
      [30, 2],
    ]);
  });
});

describe("failStalePendingOutbox (audit #10)", () => {
  it("is a no-op for a 0-day window", async () => {
    expect(await mod.failStalePendingOutbox(0)).toBe(0);
    expect(state.outboxSetWhere).toHaveLength(0);
  });
  it("fails only pending rows and returns the updated count", async () => {
    state.outboxUpdated = 3n;
    expect(await mod.failStalePendingOutbox(7)).toBe(3);
    expect(state.outboxSetWhere).toContainEqual(["status", "=", "pending"]);
  });
  it("updates in batches of 1000 picked by a limited subquery, until a short batch (F-96)", async () => {
    state.outboxUpdateBatches = [1000n, 1000n, 3n];
    expect(await mod.failStalePendingOutbox(7)).toBe(2003);
    // One bounded statement per batch, never one UPDATE over every orphan.
    expect(state.subqueryLimits).toEqual([1000, 1000, 1000]);
    expect(state.subqueryFrom).toEqual(["app_outbox", "app_outbox", "app_outbox"]);
    // `pending` is checked in the subquery AND on the outer statement, so a
    // row the drain sent meanwhile is never marked failed.
    expect(state.subqueryWhere).toContainEqual(["status", "=", "pending"]);
    expect(state.outboxSetWhere.filter((w) => w[0] === "status")).toEqual([
      ["status", "=", "pending"],
      ["status", "=", "pending"],
      ["status", "=", "pending"],
    ]);
  });
});

describe("pruneOutbox", () => {
  it("is a no-op for a 0-day window", async () => {
    expect(await mod.pruneOutbox(0)).toBe(0);
    expect(state.outboxWhere).toHaveLength(0);
  });
  it("never prunes pending rows and returns the deleted count", async () => {
    state.outboxDeleted = 7n;
    expect(await mod.pruneOutbox(30)).toBe(7);
    expect(state.outboxWhere).toContainEqual(["status", "!=", "pending"]);
  });
  it("deletes in batches of 1000 picked by a limited subquery, until a short batch (F-96)", async () => {
    state.outboxDeleteBatches = [1000n, 1000n, 1000n, 0n];
    expect(await mod.pruneOutbox(90)).toBe(3000);
    expect(state.deletedFrom).toEqual(["app_outbox", "app_outbox", "app_outbox", "app_outbox"]);
    expect(state.subqueryLimits).toEqual([1000, 1000, 1000, 1000]);
    expect(state.subqueryWhere).toContainEqual(["status", "!=", "pending"]);
    expect(state.outboxWhere.filter((w) => w[0] === "status")).toHaveLength(4);
    expect(state.outboxWhere).toContainEqual(["status", "!=", "pending"]);
  });
  it("honours an explicit batch size", async () => {
    state.outboxDeleteBatches = [2n, 1n];
    expect(await mod.pruneOutbox(90, 2)).toBe(3);
    expect(state.subqueryLimits).toEqual([2, 2]);
  });
});

describe("the deadline (F-96)", () => {
  it("starts no batch once the deadline has passed, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const past = Date.now() - 1;
    expect(await mod.pruneOutbox(90, 1000, past)).toBe(0);
    expect(await mod.failStalePendingOutbox(7, 1000, past)).toBe(0);
    expect(await mod.pruneAuditEvents(365, 5000, past)).toBe(0);
    expect(state.deletedFrom).toHaveLength(0);
    expect(state.outboxSetWhere).toHaveLength(0);
    expect(state.rawQueries).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stopped at the time budget/));
  });

  it("stops between batches when the clock crosses it, keeping what it deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    // Each statement takes 1s; the deadline at 1.5s admits exactly two.
    state.onStatement = () => vi.setSystemTime(Date.now() + 1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.outboxDeleteBatches = [1000n, 1000n, 1000n, 1000n];
    expect(await mod.pruneOutbox(90, 1000, 1500)).toBe(2000);
    expect(state.deletedFrom).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/outbox: stopped at the time budget after 2000 rows/),
    );
  });

  it("stops the audit loop the same way", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    state.onStatement = () => vi.setSystemTime(Date.now() + 1000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.auditBatches = [2, 2, 2, 2];
    expect(await mod.pruneAuditEvents(30, 2, 2500)).toBe(6);
    expect(state.rawQueries).toHaveLength(3);
  });

  it("runs to completion when no deadline is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    state.onStatement = () => vi.setSystemTime(Date.now() + 60_000);
    state.outboxDeleteBatches = [2n, 2n, 2n, 1n];
    expect(await mod.pruneOutbox(90, 2)).toBe(7);
  });
});

describe("pruneAll", () => {
  it("runs every prune/sweep with the env-configured windows", async () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    process.env.OUTBOX_RETENTION_DAYS = "10";
    process.env.OUTBOX_MAX_PENDING_DAYS = "7";
    state.revoked = 2;
    state.auditDeleted = 4;
    state.outboxDeleted = 7n;
    state.outboxUpdated = 1n;
    expect(await mod.pruneAll()).toEqual({
      revocations: 2,
      auditEvents: 4,
      outbox: 7,
      staleOutboxFailed: 1,
    });
  });

  it("hands its deadline to every batched loop (F-96)", async () => {
    // Past deadline: only the single revocation statement runs; the audit,
    // stale-pending and outbox loops each stop before their first batch.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.revoked = 2;
    state.auditDeleted = 4;
    state.outboxDeleted = 7n;
    state.outboxUpdated = 1n;
    expect(await mod.pruneAll({ deadline: Date.now() - 1 })).toEqual({
      revocations: 2,
      auditEvents: 0,
      outbox: 0,
      staleOutboxFailed: 0,
    });
    expect(state.rawQueries).toHaveLength(0);
    expect(state.deletedFrom).toHaveLength(0);
    expect(state.outboxSetWhere).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
