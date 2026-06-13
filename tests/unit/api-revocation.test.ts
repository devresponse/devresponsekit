import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RevocationModule from "@/lib/api-auth/revocation.server";

/**
 * Unit tests for the JWT `jti` revocation list
 * (`src/lib/api-auth/revocation.server.ts`).
 */
const state = vi.hoisted(() => ({
  takeFirst: undefined as unknown,
  inserts: [] as Record<string, unknown>[],
}));

function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") return () => Promise.resolve(undefined);
      if (prop === "executeTakeFirst") return () => Promise.resolve(state.takeFirst);
      if (prop === "values")
        return (v: Record<string, unknown>) => {
          state.inserts.push(v);
          return chain();
        };
      if (prop === "onConflict") return () => chain();
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
    deleteFrom: () => chain(),
  },
}));

let mod: typeof RevocationModule;

beforeEach(async () => {
  state.takeFirst = undefined;
  state.inserts = [];
  mod = await import("@/lib/api-auth/revocation.server");
});
afterEach(() => vi.resetModules());

describe("isJtiRevoked", () => {
  it("is true when a row exists, false otherwise", async () => {
    state.takeFirst = { jti: "j1" };
    expect(await mod.isJtiRevoked("j1")).toBe(true);
    state.takeFirst = undefined;
    expect(await mod.isJtiRevoked("j2")).toBe(false);
  });
});

describe("revokeJti", () => {
  it("inserts the jti + expiry (idempotent on conflict)", async () => {
    const exp = new Date(Date.now() + 60_000);
    await mod.revokeJti("j1", exp, "compromised");
    expect(state.inserts[0]).toMatchObject({ jti: "j1", reason: "compromised" });
  });

  it("defaults reason to null", async () => {
    await mod.revokeJti("j2", new Date());
    expect(state.inserts[0]).toMatchObject({ jti: "j2", reason: null });
  });
});

describe("pruneExpiredRevocations", () => {
  it("returns the number of deleted rows", async () => {
    state.takeFirst = { numDeletedRows: 5n };
    expect(await mod.pruneExpiredRevocations()).toBe(5);
  });
});
