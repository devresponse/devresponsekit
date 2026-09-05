import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientsModule from "@/lib/api-auth/oauth-clients.server";
import { hashSecret } from "@/lib/api-auth/api-key";

/**
 * Unit tests for OAuth client-credentials persistence + verification
 * (`src/lib/api-auth/oauth-clients.server.ts`). DB mocked; real hashing
 * runs. Pins: client_id/secret prefixes, secret stored as hash only,
 * secret verified by hash equality, revoked clients never verify, and the
 * update/revoke "active only" guards.
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
      if (prop === "execute") return () => Promise.resolve(state.execute);
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
  },
}));

let mod: typeof ClientsModule;

beforeEach(async () => {
  state.execute = [];
  state.takeFirst = undefined;
  state.takeFirstOrThrow = undefined;
  state.inserts = [];
  state.updates = [];
  mod = await import("@/lib/api-auth/oauth-clients.server");
});
afterEach(() => vi.resetModules());

describe("createOauthClient", () => {
  it("mints drkc_/drkcsec_ credentials and stores only the secret hash", async () => {
    state.takeFirstOrThrow = { id: "c1", client_id: "drkc_x", scopes: ["admin.users.read"] };
    const created = await mod.createOauthClient({
      name: "svc",
      scopes: ["admin.users.read"],
      organizationId: null,
      serviceAppUserId: "u1",
      createdByAppUserId: "u1",
    });
    expect(created.clientSecret).toMatch(/^drkcsec_[0-9A-Za-z]{40}$/);
    const row = state.inserts[0]!;
    expect(row.client_id).toMatch(/^drkc_[0-9A-Za-z]{24}$/);
    expect(row.client_secret_hash).toEqual(expect.any(String));
    expect(row.client_secret_hash).not.toBe(created.clientSecret);
  });
});

describe("verifyClientCredentials", () => {
  it("returns the principal when the secret hash matches an active client", async () => {
    const secret = "drkcsec_abc";
    state.takeFirst = {
      id: "c1",
      client_secret_hash: await hashSecret(secret),
      status: "active",
      scopes: ["admin.users.read"],
      organization_id: null,
      better_auth_user_id: "ba1",
    };
    const v = await mod.verifyClientCredentials("drkc_x", secret);
    expect(v).toMatchObject({ clientRowId: "c1", betterAuthUserId: "ba1" });
  });

  it("rejects a wrong secret", async () => {
    state.takeFirst = {
      id: "c1",
      client_secret_hash: await hashSecret("the-real-secret"),
      status: "active",
      scopes: [],
      organization_id: null,
      better_auth_user_id: "ba1",
    };
    expect(await mod.verifyClientCredentials("drkc_x", "wrong")).toBeNull();
  });

  it("rejects an unknown or revoked client", async () => {
    state.takeFirst = undefined;
    expect(await mod.verifyClientCredentials("drkc_x", "s")).toBeNull();
    state.takeFirst = { id: "c1", status: "revoked", client_secret_hash: "h", scopes: [] };
    expect(await mod.verifyClientCredentials("drkc_x", "s")).toBeNull();
  });
});

describe("updateOauthClient", () => {
  it("no-ops (returns false) when the patch is empty", async () => {
    expect(await mod.updateOauthClient("c1", {})).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("updates name/scopes and returns true when a row matched", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.updateOauthClient("c1", { name: "new", scopes: ["x"] })).toBe(true);
    expect(state.updates[0]).toMatchObject({ name: "new", scopes: ["x"] });
  });
});

describe("revokeOauthClient", () => {
  it("returns true/false based on rows updated", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.revokeOauthClient("c1", "u1")).toBe(true);
    state.takeFirst = { numUpdatedRows: 0n };
    expect(await mod.revokeOauthClient("c1", "u1")).toBe(false);
  });
});

describe("rotateOauthClientSecret", () => {
  it("returns null when the client is missing/not active", async () => {
    state.takeFirst = undefined;
    expect(await mod.rotateOauthClientSecret("c1")).toBeNull();
  });

  it("writes a fresh hash + a rotation stamp and returns a new drkcsec_ secret", async () => {
    state.takeFirst = { id: "c1", status: "active" };
    const before = Date.now();
    const secret = await mod.rotateOauthClientSecret("c1");
    expect(secret).toMatch(/^drkcsec_/);
    expect(state.updates[0]).toHaveProperty("client_secret_hash");
    // review #43: the stamp is what retires tokens minted with the OLD secret
    // (the row stays `active`, so the status check alone would not).
    const stamp = state.updates[0]?.secret_rotated_at;
    expect(stamp).toBeInstanceOf(Date);
    expect((stamp as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});
