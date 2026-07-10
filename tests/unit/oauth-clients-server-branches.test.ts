import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientsModule from "@/lib/api-auth/oauth-clients.server";
import { hashSecret } from "@/lib/api-auth/api-key";

/**
 * Branch-coverage companion to `api-oauth-clients-server.test.ts` for
 * `src/lib/api-auth/oauth-clients.server.ts`. Targets the branches the
 * existing unit test misses so the module's security-critical guards are
 * mutation-tested:
 *   - listOauthClients: no-filter, status-only, org-only, both filters, and
 *     the `Number(totalRow?.total ?? 0)` present/absent count coalescing.
 *   - getOauthClientById: found vs. undefined + the `id` where clause.
 *   - updateOauthClient: name-only, scopes-only, the `numUpdatedRows ?? 0`
 *     undefined path, the 0-rows-false path, and the "active only" guard.
 *   - revokeOauthClient: the recorded set (status/revoked_by) + active guard
 *     + the `numUpdatedRows ?? 0` undefined path.
 *   - rotateOauthClientSecret: the "present-but-not-active" null branch (the
 *     second operand of `!existing || existing.status !== "active"`).
 *   - verifyClientCredentials: the `timingSafeHexEqual` length-mismatch
 *     branch, plus full org/scopes projection passthrough + client_id filter.
 *
 * DB is mocked with a proxy that additionally records where/limit/offset
 * args (the existing test's proxy drops them); real hashing runs.
 */
const state = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
  takeFirstOrThrow: undefined as unknown,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  wheres: [] as unknown[][],
  limits: [] as unknown[],
  offsets: [] as unknown[],
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
      if (prop === "where")
        return (...args: unknown[]) => {
          state.wheres.push(args);
          return chain();
        };
      if (prop === "limit")
        return (n: unknown) => {
          state.limits.push(n);
          return chain();
        };
      if (prop === "offset")
        return (n: unknown) => {
          state.offsets.push(n);
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
  pgPool: {},
}));

let mod: typeof ClientsModule;

beforeEach(async () => {
  state.execute = [];
  state.takeFirst = undefined;
  state.takeFirstOrThrow = undefined;
  state.inserts = [];
  state.updates = [];
  state.wheres = [];
  state.limits = [];
  state.offsets = [];
  mod = await import("@/lib/api-auth/oauth-clients.server");
});
afterEach(() => vi.resetModules());

describe("listOauthClients — filter/pagination branches", () => {
  it("applies no filter when status and organizationId are absent", async () => {
    state.execute = [{ id: "c1", client_id: "drkc_x", status: "active" }];
    state.takeFirst = { total: "5" };
    const r = await mod.listOauthClients({ limit: 10, offset: 0 });
    expect(r.items).toEqual([{ id: "c1", client_id: "drkc_x", status: "active" }]);
    expect(r.total).toBe(5);
    expect(state.wheres).toHaveLength(0);
    expect(state.limits).toContain(10);
    expect(state.offsets).toContain(0);
  });

  it("filters on status only when just status is given", async () => {
    state.execute = [];
    state.takeFirst = { total: "0" };
    const r = await mod.listOauthClients({ limit: 5, offset: 2, status: "revoked" });
    expect(state.wheres).toContainEqual(["status", "=", "revoked"]);
    expect(state.wheres).not.toContainEqual(["organization_id", "=", expect.anything()]);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(state.limits).toContain(5);
    expect(state.offsets).toContain(2);
  });

  it("filters on organization_id only when just organizationId is given", async () => {
    state.takeFirst = { total: "3" };
    const r = await mod.listOauthClients({ limit: 5, offset: 0, organizationId: "org1" });
    expect(state.wheres).toContainEqual(["organization_id", "=", "org1"]);
    expect(state.wheres).not.toContainEqual(["status", "=", expect.anything()]);
    expect(r.total).toBe(3);
  });

  it("applies both filters when status and organizationId are given", async () => {
    state.takeFirst = { total: "1" };
    await mod.listOauthClients({
      limit: 20,
      offset: 40,
      status: "active",
      organizationId: "org9",
    });
    expect(state.wheres).toContainEqual(["status", "=", "active"]);
    expect(state.wheres).toContainEqual(["organization_id", "=", "org9"]);
    expect(state.limits).toContain(20);
    expect(state.offsets).toContain(40);
  });

  it("coalesces the count to 0 when the total row is absent", async () => {
    state.execute = [];
    state.takeFirst = undefined;
    const r = await mod.listOauthClients({ limit: 5, offset: 0 });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("coalesces the count to 0 when the total column is null", async () => {
    state.takeFirst = { total: null };
    const r = await mod.listOauthClients({ limit: 5, offset: 0 });
    expect(r.total).toBe(0);
  });
});

describe("getOauthClientById", () => {
  it("returns the row and filters on id when found", async () => {
    state.takeFirst = { id: "c1", client_id: "drkc_x", status: "active" };
    const row = await mod.getOauthClientById("c1");
    expect(row).toEqual({ id: "c1", client_id: "drkc_x", status: "active" });
    expect(state.wheres).toContainEqual(["id", "=", "c1"]);
  });

  it("returns undefined when no row matches", async () => {
    state.takeFirst = undefined;
    expect(await mod.getOauthClientById("nope")).toBeUndefined();
  });
});

describe("updateOauthClient — set-composition + guard branches", () => {
  it("sets only name when scopes is omitted", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.updateOauthClient("c1", { name: "renamed" })).toBe(true);
    expect(state.updates[0]).toEqual({ name: "renamed" });
    expect(state.wheres).toContainEqual(["id", "=", "c1"]);
    expect(state.wheres).toContainEqual(["status", "=", "active"]);
  });

  it("sets only scopes when name is omitted", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.updateOauthClient("c1", { scopes: ["admin.users.read"] })).toBe(true);
    expect(state.updates[0]).toEqual({ scopes: ["admin.users.read"] });
  });

  it("returns false when the update matched no active row", async () => {
    state.takeFirst = { numUpdatedRows: 0n };
    expect(await mod.updateOauthClient("c1", { name: "x" })).toBe(false);
  });

  it("returns false when numUpdatedRows is absent (undefined coalesces to 0)", async () => {
    state.takeFirst = {};
    expect(await mod.updateOauthClient("c1", { name: "x" })).toBe(false);
  });
});

describe("revokeOauthClient — set contents + guard branches", () => {
  it("records status=revoked with the actor and enforces the active guard", async () => {
    state.takeFirst = { numUpdatedRows: 1n };
    expect(await mod.revokeOauthClient("c1", "admin-1")).toBe(true);
    expect(state.updates[0]).toMatchObject({ status: "revoked", revoked_by: "admin-1" });
    expect(state.updates[0]).toHaveProperty("revoked_at");
    expect(state.wheres).toContainEqual(["id", "=", "c1"]);
    expect(state.wheres).toContainEqual(["status", "=", "active"]);
  });

  it("returns false when numUpdatedRows is absent (undefined coalesces to 0)", async () => {
    state.takeFirst = {};
    expect(await mod.revokeOauthClient("c1", "admin-1")).toBe(false);
  });
});

describe("rotateOauthClientSecret — active guard branches", () => {
  it("returns null and writes nothing when the client exists but is not active", async () => {
    state.takeFirst = { id: "c1", status: "revoked" };
    expect(await mod.rotateOauthClientSecret("c1")).toBeNull();
    expect(state.updates).toHaveLength(0);
  });

  it("writes a fresh hash for an active client and returns a distinct new secret", async () => {
    state.takeFirst = { id: "c1", status: "active" };
    const secret = await mod.rotateOauthClientSecret("c1");
    expect(secret).toMatch(/^drkcsec_[0-9A-Za-z]{40}$/);
    const written = state.updates[0]!.client_secret_hash as string;
    expect(written).toEqual(expect.any(String));
    expect(written).toBe(await hashSecret(secret!));
    expect(written).not.toBe(secret);
  });
});

describe("verifyClientCredentials — comparison + projection branches", () => {
  it("rejects when the stored hash length differs from the presented hash", async () => {
    state.takeFirst = {
      id: "c1",
      status: "active",
      client_secret_hash: "short-not-64-hex-chars",
      scopes: [],
      organization_id: null,
      better_auth_user_id: "ba1",
    };
    expect(await mod.verifyClientCredentials("drkc_x", "any-secret")).toBeNull();
  });

  it("projects org, scopes and the service user through on a hash match", async () => {
    const secret = "drkcsec_specificsecret";
    state.takeFirst = {
      id: "c1",
      status: "active",
      client_secret_hash: await hashSecret(secret),
      scopes: ["admin.users.read", "admin.groups.read"],
      organization_id: "org9",
      better_auth_user_id: "ba1",
    };
    const v = await mod.verifyClientCredentials("drkc_x", secret);
    expect(v).toEqual({
      clientRowId: "c1",
      betterAuthUserId: "ba1",
      organizationId: "org9",
      scopes: ["admin.users.read", "admin.groups.read"],
    });
    expect(state.wheres).toContainEqual(["c.client_id", "=", "drkc_x"]);
  });

  it("rejects a revoked client even when the presented secret is correct", async () => {
    // The status guard must be LOAD-BEARING: a revoked client presenting its
    // real secret still fails. Without a matching hash the guard is masked by
    // the hash-mismatch reject (so this is the case that pins `status !==
    // "active"` on its own — a revoked principal can never re-authenticate).
    const secret = "drkcsec_thecorrectsecretvalue";
    state.takeFirst = {
      id: "c1",
      status: "revoked",
      client_secret_hash: await hashSecret(secret), // the CORRECT hash
      scopes: ["admin.users.read"],
      organization_id: "org9",
      better_auth_user_id: "ba1",
    };
    expect(await mod.verifyClientCredentials("drkc_x", secret)).toBeNull();
  });
});
