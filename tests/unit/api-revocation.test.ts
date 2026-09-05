import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RevocationModule from "@/lib/api-auth/revocation.server";

/**
 * Unit tests for outstanding-token revocation
 * (`src/lib/api-auth/revocation.server.ts`, review #43).
 *
 * The `jti` denylist had no writer, so revoking or rotating a key / client
 * left every minted token alive until `exp`. It was replaced by a per-request
 * status check on the token's SOURCE credential (`cid` claim). These tests
 * pin the decision table for both credential kinds against a mocked DB; the
 * live-SQL version is tests/db/token-credential-revocation.db.test.ts.
 */
const state = vi.hoisted(() => ({
  takeFirst: undefined as unknown,
  tables: [] as string[],
  wheres: [] as unknown[][],
}));

function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") return () => Promise.resolve(undefined);
      if (prop === "executeTakeFirst") return () => Promise.resolve(state.takeFirst);
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
    selectFrom: (table: string) => {
      state.tables.push(table);
      return chain();
    },
    deleteFrom: (table: string) => {
      state.tables.push(table);
      return chain();
    },
  },
}));

let mod: typeof RevocationModule;
const NOW = new Date("2026-09-05T12:00:00.000Z");

beforeEach(async () => {
  state.takeFirst = undefined;
  state.tables = [];
  state.wheres = [];
  mod = await import("@/lib/api-auth/revocation.server");
});
afterEach(() => vi.resetModules());

describe("isSourceCredentialActive — api_key", () => {
  const ref = { kind: "api_key" as const, id: "key-1" };

  it("reads app_api_keys by primary key (one indexed read)", async () => {
    state.takeFirst = { status: "active", expires_at: null };
    await mod.isSourceCredentialActive(ref, NOW);
    expect(state.tables).toEqual(["app_api_keys"]);
    expect(state.wheres).toEqual([["id", "=", "key-1"]]);
  });

  it("is true for an active key with no expiry", async () => {
    state.takeFirst = { status: "active", expires_at: null };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(true);
  });

  it("is false once the key is revoked (revoke AND rotate both flip status)", async () => {
    state.takeFirst = { status: "revoked", expires_at: null };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
  });

  it("is false for a deleted / unknown key", async () => {
    state.takeFirst = undefined;
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
  });

  it("is false when the key's expires_at has passed, true while it is in the future", async () => {
    state.takeFirst = { status: "active", expires_at: new Date(Date.now() - 1_000) };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
    state.takeFirst = { status: "active", expires_at: new Date(Date.now() + 60_000) };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(true);
  });
});

describe("isSourceCredentialActive — oauth_client", () => {
  const ref = { kind: "oauth_client" as const, id: "client-1" };

  it("reads app_oauth_clients by primary key", async () => {
    state.takeFirst = { status: "active", secret_rotated_at: null };
    await mod.isSourceCredentialActive(ref, NOW);
    expect(state.tables).toEqual(["app_oauth_clients"]);
    expect(state.wheres).toEqual([["id", "=", "client-1"]]);
  });

  it("is true for an active, never-rotated client", async () => {
    state.takeFirst = { status: "active", secret_rotated_at: null };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(true);
  });

  it("is false once the client is revoked, or unknown", async () => {
    state.takeFirst = { status: "revoked", secret_rotated_at: null };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
    state.takeFirst = undefined;
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
  });

  it("retires a token issued BEFORE the secret was rotated, keeps one issued at/after", async () => {
    const rotatedAt = new Date(NOW.getTime() + 30_000);
    state.takeFirst = { status: "active", secret_rotated_at: rotatedAt };
    // Minted with the old secret (iat precedes the rotation) → dead.
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
    // Minted in the same second as the rotation → kept (the stamp is not later).
    expect(await mod.isSourceCredentialActive(ref, rotatedAt)).toBe(true);
    // Minted with the new secret → kept.
    expect(await mod.isSourceCredentialActive(ref, new Date(rotatedAt.getTime() + 1_000))).toBe(
      true,
    );
  });

  it("accepts the stamp as an ISO string (driver-dependent timestamptz shape)", async () => {
    state.takeFirst = {
      status: "active",
      secret_rotated_at: new Date(NOW.getTime() + 1_000).toISOString(),
    };
    expect(await mod.isSourceCredentialActive(ref, NOW)).toBe(false);
  });
});

describe("pruneExpiredRevocations", () => {
  it("still prunes the vestigial jti table and returns the number of deleted rows", async () => {
    state.takeFirst = { numDeletedRows: 5n };
    expect(await mod.pruneExpiredRevocations()).toBe(5);
    expect(state.tables).toEqual(["app_revoked_tokens"]);
  });

  it("returns 0 when the driver reports nothing", async () => {
    state.takeFirst = undefined;
    expect(await mod.pruneExpiredRevocations()).toBe(0);
  });
});
