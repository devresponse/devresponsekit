import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiKeysModule from "@/lib/api-auth/api-keys.server";

/**
 * Branch-coverage companion to `api-keys-server.test.ts`. Self-contained:
 * it re-creates the same chainable DB-proxy mock (so the two files never
 * share module state) and then drives the branches the base file leaves
 * uncovered — the two never-called functions (`listApiKeysForUser`,
 * `getApiKeyById`), every `listApiKeysAdmin` filter permutation and its
 * empty-count fallback, `revokeApiKey`'s undefined-`numUpdatedRows` path,
 * the not-yet-expired ternary in `verifyApiKey`, the row-copy inside
 * `rotateApiKey`'s transaction, and `touchApiKeyUsage`'s write payload.
 *
 * Every assertion pins a concrete outcome (a returned value/shape, a
 * captured WHERE clause, a captured write payload) so the file survives
 * mutation testing rather than merely executing the lines.
 */
const state = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
  takeFirstOrThrow: undefined as unknown,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  wheres: [] as unknown[][],
  // When set, the next terminal `.execute()` rejects — used to drive the
  // fire-and-forget `.catch()` branch in `touchApiKeyUsage`.
  rejectExecute: false,
}));

function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") {
        return (arg?: unknown) => {
          if (state.rejectExecute) return Promise.reject(new Error("db down"));
          return typeof arg === "function"
            ? Promise.resolve((arg as (trx: unknown) => unknown)(chain()))
            : Promise.resolve(state.execute);
        };
      }
      if (prop === "executeTakeFirst") return () => Promise.resolve(state.takeFirst);
      if (prop === "executeTakeFirstOrThrow") return () => Promise.resolve(state.takeFirstOrThrow);
      if (prop === "values")
        return (v: Record<string, unknown>) => {
          state.inserts.push(v);
          return chain();
        };
      if (prop === "set")
        return (v: Record<string, unknown>) => {
          state.updates.push(v);
          return chain();
        };
      if (prop === "where")
        return (...args: unknown[]) => {
          state.wheres.push(args);
          return chain();
        };
      return () => chain();
    },
    apply() {
      return chain();
    },
  });
}

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => chain(),
    insertInto: () => chain(),
    updateTable: () => chain(),
    transaction: () => ({
      execute: (cb: (trx: unknown) => unknown) => Promise.resolve(cb(chain())),
    }),
  },
  // The module under test only imports `db`, but the harness contract asks
  // for both exports; providing `pgPool` keeps the mock a faithful stand-in
  // for `@/db/database` and future-proofs it against a new import.
  pgPool: { query: () => Promise.resolve({ rows: [] }), end: () => Promise.resolve() },
}));

let mod: typeof ApiKeysModule;

beforeEach(async () => {
  state.execute = [];
  state.takeFirst = undefined;
  state.takeFirstOrThrow = undefined;
  state.inserts = [];
  state.updates = [];
  state.wheres = [];
  state.rejectExecute = false;
  mod = await import("@/lib/api-auth/api-keys.server");
});
afterEach(() => vi.resetModules());

/** Flattens the captured WHERE tuples into "col op val" strings for asserting. */
function whereClauses(): string[] {
  return state.wheres.map((w) => w.map((part) => String(part)).join(" "));
}

describe("createApiKey — non-null organization + expiry are persisted", () => {
  it("stores the caller's organizationId and expiresAt on the row", async () => {
    const expiresAt = new Date("2999-01-01T00:00:00.000Z");
    state.takeFirstOrThrow = {
      id: "k9",
      app_user_id: "owner",
      organization_id: "org-7",
      scopes: ["admin.users.read"],
      status: "active",
      expires_at: expiresAt,
    };

    const result = await mod.createApiKey({
      ownerAppUserId: "owner",
      organizationId: "org-7",
      name: "scoped",
      scopes: ["admin.users.read"],
      expiresAt,
      createdByAppUserId: "creator",
    });

    expect(result).toMatchObject({ id: "k9", organization_id: "org-7" });
    expect(result.plaintext).toMatch(/^drk_(live|test)_[0-9A-Za-z]{32}$/);
    const row = state.inserts[0]!;
    expect(row).toMatchObject({
      organization_id: "org-7",
      expires_at: expiresAt,
      created_by: "creator",
      status: "active",
      name: "scoped",
    });
  });
});

describe("listApiKeysForUser", () => {
  it("returns the user's rows and filters by app_user_id", async () => {
    state.execute = [{ id: "k1" }, { id: "k2" }];
    const rows = await mod.listApiKeysForUser("user-1");
    expect(rows).toEqual([{ id: "k1" }, { id: "k2" }]);
    expect(whereClauses()).toContain("app_user_id = user-1");
  });

  it("returns an empty array when the user has no keys", async () => {
    state.execute = [];
    expect(await mod.listApiKeysForUser("nobody")).toEqual([]);
  });
});

describe("getApiKeyById", () => {
  it("returns the summary row when found, keyed by id", async () => {
    state.takeFirst = { id: "k1", name: "ci", status: "active" };
    const row = await mod.getApiKeyById("k1");
    expect(row).toEqual({ id: "k1", name: "ci", status: "active" });
    expect(whereClauses()).toContain("id = k1");
  });

  it("returns undefined for an unknown id", async () => {
    state.takeFirst = undefined;
    expect(await mod.getApiKeyById("missing")).toBeUndefined();
  });
});

describe("listApiKeysAdmin — filter branches + count fallback", () => {
  it("applies no optional WHERE clauses when only limit/offset are given", async () => {
    state.execute = [{ id: "k1" }];
    state.takeFirst = { total: "5" };
    const out = await mod.listApiKeysAdmin({ limit: 25, offset: 0 });
    expect(out).toEqual({ items: [{ id: "k1" }], total: 5 });
    // None of status / app_user_id / organization_id were constrained.
    expect(whereClauses()).not.toContain("status = active");
    expect(state.wheres).toHaveLength(0);
  });

  it("applies every optional filter when all are provided", async () => {
    state.execute = [{ id: "k1" }, { id: "k2" }];
    state.takeFirst = { total: "2" };
    const out = await mod.listApiKeysAdmin({
      limit: 10,
      offset: 20,
      status: "revoked",
      appUserId: "user-9",
      organizationId: "org-3",
    });
    expect(out.items).toHaveLength(2);
    expect(out.total).toBe(2);
    const clauses = whereClauses();
    expect(clauses).toContain("status = revoked");
    expect(clauses).toContain("app_user_id = user-9");
    expect(clauses).toContain("organization_id = org-3");
  });

  it("applies only the appUserId filter when it alone is set", async () => {
    state.execute = [];
    state.takeFirst = { total: "0" };
    await mod.listApiKeysAdmin({ limit: 10, offset: 0, appUserId: "solo" });
    const clauses = whereClauses();
    expect(clauses).toContain("app_user_id = solo");
    expect(clauses.some((c) => c.startsWith("status "))).toBe(false);
    expect(clauses.some((c) => c.startsWith("organization_id "))).toBe(false);
  });

  it("applies only the organizationId filter when it alone is set", async () => {
    state.execute = [];
    state.takeFirst = { total: "0" };
    await mod.listApiKeysAdmin({ limit: 10, offset: 0, organizationId: "org-only" });
    const clauses = whereClauses();
    expect(clauses).toContain("organization_id = org-only");
    expect(clauses.some((c) => c.startsWith("app_user_id "))).toBe(false);
  });

  it("falls back to total 0 when the count row is absent", async () => {
    state.execute = [];
    state.takeFirst = undefined; // count query returns nothing
    const out = await mod.listApiKeysAdmin({ limit: 10, offset: 0 });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });
});

describe("revokeApiKey — undefined numUpdatedRows", () => {
  it("returns false when the driver omits numUpdatedRows", async () => {
    state.takeFirst = {}; // numUpdatedRows === undefined → `?? 0` → 0 → false
    expect(await mod.revokeApiKey("k1", "actor")).toBe(false);
  });

  it("writes revoked_reason null when no reason is supplied", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.revokeApiKey("k1", "actor")).toBe(true);
    expect(state.updates[0]).toMatchObject({
      status: "revoked",
      revoked_by: "actor",
      revoked_reason: null,
    });
    // Guard both predicates of the UPDATE: id match AND active-only.
    const clauses = whereClauses();
    expect(clauses).toContain("id = k1");
    expect(clauses).toContain("status = active");
  });
});

describe("rotateApiKey — the new row copies the source key", () => {
  it("carries owner/org/scopes/expiry from the existing key and stamps the actor", async () => {
    const expiresAt = new Date("2999-06-01T00:00:00.000Z");
    state.takeFirst = {
      id: "old",
      status: "active",
      app_user_id: "owner",
      organization_id: "org-x",
      name: "prod",
      scopes: ["admin.users.read", "admin.groups.read"],
      expires_at: expiresAt,
    };
    state.takeFirstOrThrow = { id: "new", app_user_id: "owner", scopes: ["admin.users.read"] };

    const rotated = await mod.rotateApiKey("old", "actor-2");
    expect(rotated).not.toBeNull();
    expect(rotated?.id).toBe("new");
    expect(rotated?.plaintext).toMatch(/^drk_(live|test)_/);

    // First write = the fresh key: it must inherit the source's fields.
    expect(state.inserts[0]).toMatchObject({
      app_user_id: "owner",
      organization_id: "org-x",
      name: "prod",
      scopes: ["admin.users.read", "admin.groups.read"],
      expires_at: expiresAt,
      created_by: "actor-2",
      status: "active",
    });
    // Last write = the revoke of the old key, tagged "rotated".
    expect(state.updates.at(-1)).toMatchObject({
      status: "revoked",
      revoked_by: "actor-2",
      revoked_reason: "rotated",
    });
  });
});

describe("verifyApiKey — not-yet-expired key resolves", () => {
  const base = {
    id: "k1",
    app_user_id: "u1",
    better_auth_user_id: "ba1",
    organization_id: "org-1",
    scopes: ["admin.users.read"],
    status: "active" as const,
  };

  it("resolves a key whose expires_at is in the future (right side of && is false)", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    state.takeFirst = {
      ...base,
      expires_at: expiresAt.toISOString(),
    };
    const v = await mod.verifyApiKey("drk_live_future");
    expect(v).toEqual({
      id: "k1",
      appUserId: "u1",
      betterAuthUserId: "ba1",
      organizationId: "org-1",
      scopes: ["admin.users.read"],
      // Surfaced so the token endpoint can cap a JWT's TTL at it (review #48).
      expiresAt,
    });
  });

  it("resolves a key with a null expires_at (left side of && is falsy)", async () => {
    state.takeFirst = { ...base, expires_at: null };
    const v = await mod.verifyApiKey("drk_live_noexpiry");
    expect(v?.id).toBe("k1");
    expect(v?.organizationId).toBe("org-1");
  });

  it("rejects a key expiring at exactly the current instant (expiry is inclusive)", async () => {
    // Pins the boundary: `getTime() <= Date.now()` is inclusive, so a key
    // whose expiry equals *now* is already expired. Fake timers freeze the
    // clock so `expires_at === Date.now()` holds exactly.
    vi.useFakeTimers();
    try {
      const now = new Date("2030-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      state.takeFirst = { ...base, expires_at: now.toISOString() };
      expect(await mod.verifyApiKey("drk_live_boundary")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("touchApiKeyUsage — write payload", () => {
  it("stamps last_used_ip with the supplied IP and targets the id", async () => {
    mod.touchApiKeyUsage("k1", "203.0.113.5");
    // The write is fire-and-forget; the `.set()` runs synchronously.
    expect(state.updates[0]).toMatchObject({ last_used_ip: "203.0.113.5" });
    expect(state.updates[0]).toHaveProperty("last_used_at");
    expect(whereClauses()).toContain("id = k1");
  });

  it("stamps a null IP when none is available", () => {
    mod.touchApiKeyUsage("k2", null);
    expect(state.updates[0]).toMatchObject({ last_used_ip: null });
  });

  it("swallows a rejecting write (best-effort) without an unhandled rejection", async () => {
    state.rejectExecute = true; // the underlying UPDATE rejects
    // If the `.catch()` were absent this would surface as an unhandled
    // rejection and fail the test run; that it does not is the assertion.
    expect(() => mod.touchApiKeyUsage("k3", "198.51.100.9")).not.toThrow();
    // The write payload was still formed before the driver rejected.
    expect(state.updates[0]).toMatchObject({ last_used_ip: "198.51.100.9" });
    // Let the rejected promise settle so the `.catch` handler runs.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
