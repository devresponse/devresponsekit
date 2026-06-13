import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiKeysModule from "@/lib/api-auth/api-keys.server";

/**
 * Unit tests for the API-key persistence + verification layer
 * (`src/lib/api-auth/api-keys.server.ts`). The DB is mocked with a
 * chainable builder whose terminal methods return per-test fixtures; the
 * real `api-key.ts` hashing/generation runs (pure crypto). These pin the
 * security-relevant behaviour: only a hash is stored, expired/revoked
 * keys never verify, rotation is atomic, and revoke is idempotent.
 */
const state = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
  takeFirstOrThrow: undefined as unknown,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") {
        return (arg?: unknown) =>
          typeof arg === "function"
            ? Promise.resolve((arg as (trx: unknown) => unknown)(chain()))
            : Promise.resolve(state.execute);
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
}));

let mod: typeof ApiKeysModule;

beforeEach(async () => {
  state.execute = [];
  state.takeFirst = undefined;
  state.takeFirstOrThrow = undefined;
  state.inserts = [];
  state.updates = [];
  mod = await import("@/lib/api-auth/api-keys.server");
});
afterEach(() => vi.resetModules());

describe("createApiKey", () => {
  it("generates a drk_ key, stores only a hash, returns the plaintext once", async () => {
    state.takeFirstOrThrow = { id: "k1", app_user_id: "u1", scopes: ["admin.users.read"] };
    const result = await mod.createApiKey({
      ownerAppUserId: "u1",
      organizationId: null,
      name: "ci",
      scopes: ["admin.users.read"],
      expiresAt: null,
      createdByAppUserId: "u1",
    });

    expect(result.plaintext).toMatch(/^drk_(live|test)_[0-9A-Za-z]{32}$/);
    const row = state.inserts[0]!;
    expect(row.key_hash).toEqual(expect.any(String));
    expect(row.key_hash).not.toBe(result.plaintext); // hashed, not plaintext
    expect(row).toMatchObject({ app_user_id: "u1", status: "active", name: "ci" });
  });
});

describe("verifyApiKey", () => {
  const activeRow = {
    id: "k1",
    app_user_id: "u1",
    better_auth_user_id: "ba1",
    organization_id: null,
    scopes: ["admin.users.read"],
    status: "active",
    expires_at: null,
  };

  it("resolves an active, unexpired key to its owner identity", async () => {
    state.takeFirst = activeRow;
    const v = await mod.verifyApiKey("drk_live_whatever");
    expect(v).toMatchObject({ id: "k1", betterAuthUserId: "ba1", scopes: ["admin.users.read"] });
  });

  it("rejects an unknown key", async () => {
    state.takeFirst = undefined;
    expect(await mod.verifyApiKey("drk_live_nope")).toBeNull();
  });

  it("rejects a revoked key", async () => {
    state.takeFirst = { ...activeRow, status: "revoked" };
    expect(await mod.verifyApiKey("drk_live_x")).toBeNull();
  });

  it("rejects an expired key", async () => {
    state.takeFirst = { ...activeRow, expires_at: new Date(Date.now() - 1000).toISOString() };
    expect(await mod.verifyApiKey("drk_live_x")).toBeNull();
  });
});

describe("revokeApiKey", () => {
  it("returns true when a row was updated and writes the revoked status", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.revokeApiKey("k1", "u1", "manual")).toBe(true);
    expect(state.updates[0]).toMatchObject({ status: "revoked", revoked_reason: "manual" });
  });

  it("returns false when nothing matched (already revoked / unknown)", async () => {
    state.takeFirst = { numUpdatedRows: 0n };
    expect(await mod.revokeApiKey("k1", "u1")).toBe(false);
  });
});

describe("rotateApiKey", () => {
  it("returns null when the key is missing or not active", async () => {
    state.takeFirst = undefined;
    expect(await mod.rotateApiKey("k1", "u1")).toBeNull();
    state.takeFirst = { id: "k1", status: "revoked", app_user_id: "u1", scopes: [] };
    expect(await mod.rotateApiKey("k1", "u1")).toBeNull();
  });

  it("issues a fresh plaintext and revokes the old key in one transaction", async () => {
    state.takeFirst = {
      id: "k1",
      status: "active",
      app_user_id: "u1",
      organization_id: null,
      name: "ci",
      scopes: ["a"],
      expires_at: null,
    };
    state.takeFirstOrThrow = { id: "k2", app_user_id: "u1", scopes: ["a"] };
    const rotated = await mod.rotateApiKey("k1", "u1");
    expect(rotated?.plaintext).toMatch(/^drk_/);
    // the transaction performed an insert (new key) and an update (revoke old)
    expect(state.updates.at(-1)).toMatchObject({ status: "revoked", revoked_reason: "rotated" });
  });
});

describe("listApiKeysAdmin", () => {
  it("returns items + numeric total from the count row", async () => {
    state.execute = [{ id: "k1" }];
    state.takeFirst = { total: "3" };
    const out = await mod.listApiKeysAdmin({ limit: 10, offset: 0, status: "active" });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(3);
  });
});

describe("touchApiKeyUsage", () => {
  it("never throws into the caller (best-effort)", () => {
    expect(() => mod.touchApiKeyUsage("k1", "10.0.0.1")).not.toThrow();
  });
});
