import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RetentionModule from "@/lib/retention.server";

/**
 * Unit tests for the data-retention pruner (review D3). The DB layer is
 * stubbed; these pin the per-table behavior and the safety rules:
 *   - 0-day windows disable a table's prune (no DELETE issued)
 *   - the audit prune sets the `app.audit_retention` flag B3's trigger honors
 *   - the outbox prune never touches `pending` rows
 */
const state = vi.hoisted(() => ({
  auditDeleted: 0n as bigint,
  // When set, each audit DELETE batch shifts one value off this queue — so a
  // multi-batch backlog can be simulated. Falls back to `auditDeleted`.
  auditBatches: null as bigint[] | null,
  outboxDeleted: 0n as bigint,
  outboxUpdated: 0n as bigint,
  revoked: 0,
  outboxWhere: [] as unknown[][],
  outboxSetWhere: [] as unknown[][],
  rawQueries: [] as string[],
}));

function deleteChain(table: string) {
  const chain = {
    where: (...args: unknown[]) => {
      if (table === "app_outbox") state.outboxWhere.push(args);
      return chain;
    },
    executeTakeFirst: async () => {
      if (table === "app_audit_events") {
        const n = state.auditBatches ? (state.auditBatches.shift() ?? 0n) : state.auditDeleted;
        return { numDeletedRows: n };
      }
      return { numDeletedRows: state.outboxDeleted };
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
    executeTakeFirst: async () => ({ numUpdatedRows: state.outboxUpdated }),
  };
  return chain;
}

const trx = {
  executeQuery: async (q: { sql: string }) => {
    state.rawQueries.push(q.sql);
    return { rows: [] };
  },
  deleteFrom: (t: string) => deleteChain(t),
};

vi.mock("@/db/database", () => ({
  db: {
    deleteFrom: (t: string) => deleteChain(t),
    updateTable: () => updateChain(),
    transaction: () => ({
      execute: async (cb: (t: typeof trx) => Promise<unknown>) => cb(trx),
    }),
  },
}));

vi.mock("@/lib/api-auth/revocation.server", () => ({
  pruneExpiredRevocations: async () => state.revoked,
}));

let mod: typeof RetentionModule;

beforeEach(async () => {
  state.auditDeleted = 0n;
  state.auditBatches = null;
  state.outboxDeleted = 0n;
  state.outboxUpdated = 0n;
  state.revoked = 0;
  state.outboxWhere = [];
  state.outboxSetWhere = [];
  state.rawQueries = [];
  mod = await import("@/lib/retention.server");
});
afterEach(() => {
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
  it("is a no-op for a 0-day window (no DELETE, no flag)", async () => {
    expect(await mod.pruneAuditEvents(0)).toBe(0);
    expect(state.rawQueries).toHaveLength(0);
  });
  it("sets the append-only bypass flag and returns the deleted count", async () => {
    state.auditDeleted = 4n;
    expect(await mod.pruneAuditEvents(30)).toBe(4);
    expect(state.rawQueries.some((q) => q.includes("app.audit_retention"))).toBe(true);
  });
  it("deletes in batches until a short batch, summing the total (audit #21)", async () => {
    // batchSize 2: two full batches then a short one → loop stops, total = 5.
    state.auditBatches = [2n, 2n, 1n];
    expect(await mod.pruneAuditEvents(30, 2)).toBe(5);
    // Three DELETE batches, each its own tx that set the retention flag.
    expect(state.rawQueries.filter((q) => q.includes("app.audit_retention"))).toHaveLength(3);
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
});

describe("pruneAll", () => {
  it("runs every prune/sweep with the env-configured windows", async () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    process.env.OUTBOX_RETENTION_DAYS = "10";
    process.env.OUTBOX_MAX_PENDING_DAYS = "7";
    state.revoked = 2;
    state.auditDeleted = 4n;
    state.outboxDeleted = 7n;
    state.outboxUpdated = 1n;
    expect(await mod.pruneAll()).toEqual({
      revocations: 2,
      auditEvents: 4,
      outbox: 7,
      staleOutboxFailed: 1,
    });
  });
});
