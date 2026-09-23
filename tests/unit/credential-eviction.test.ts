import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/api-auth/credential-eviction.server";

/**
 * F-10 — `revokeBearerCredentialsOf`, the cut-off a completed password reset
 * and an admin set-password apply to every bearer credential that
 * authenticates AS the account.
 *
 * The owner lookup is a recording builder. The fence (`inIssuanceTransaction`,
 * `lockOwnerForEviction`) and the two set-based revokes are spies that append
 * to one event log, so the cases pin the protocol: each pass is ONE
 * transaction that takes the owner's eviction lock before it revokes keys and
 * clients, passes repeat until one revokes nothing, and the audit rows are
 * written only after the pass committed. The SQL runs against Postgres in
 * tests/db/credential-eviction.db.test.ts, and the revokes' WHERE clauses are
 * pinned in the api-keys / oauth-clients unit suites.
 */
type Where = [string, string, unknown];
type Row = { id: string; organization_id: string | null };
const state = vi.hoisted(() => ({
  owner: undefined as { id: string } | undefined,
  lookups: [] as { table: string; where: Where[] }[],
  events: [] as string[],
  /** One entry per pass: what that pass's UPDATE … RETURNING yields. */
  passes: [] as { keys: Row[]; clients: Row[] }[],
}));

function select(table: string) {
  const query = { table, where: [] as Where[] };
  state.lookups.push(query);
  const builder = {
    select: () => builder,
    where: (column: string, op: string, value: unknown) => {
      query.where.push([column, op, value]);
      return builder;
    },
    executeTakeFirst: async () => state.owner,
  };
  return builder;
}

vi.mock("@/db/database", () => ({ db: { selectFrom: (table: string) => select(table) } }));

const TRX = { trx: true };
vi.mock("@/lib/api-auth/issuance-fence.server", () => ({
  inIssuanceTransaction: async (fn: (trx: unknown) => Promise<unknown>) => {
    state.events.push("begin");
    const result = await fn(TRX);
    state.events.push("commit");
    return result;
  },
  lockOwnerForEviction: async (trx: unknown, owner: string) => {
    expect(trx).toBe(TRX);
    state.events.push(`lock ${owner}`);
  },
}));

let pass = 0;
const revokeActiveApiKeysOf = vi.fn();
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  revokeActiveApiKeysOf: (...a: unknown[]) => revokeActiveApiKeysOf(...a),
}));
const revokeActiveOauthClientsOf = vi.fn();
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  revokeActiveOauthClientsOf: (...a: unknown[]) => revokeActiveOauthClientsOf(...a),
}));
const auditEvent = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));

let M: typeof Mod;

beforeEach(async () => {
  state.owner = { id: "app-owner" };
  state.lookups = [];
  state.events = [];
  // Pass 1 revokes what the account holds; pass 2 finds nothing.
  state.passes = [
    {
      keys: [
        { id: "k1", organization_id: "org-a" },
        { id: "k2", organization_id: null },
      ],
      clients: [{ id: "c1", organization_id: "org-a" }],
    },
  ];
  pass = 0;
  revokeActiveApiKeysOf.mockReset().mockImplementation(async (trx: unknown, owner: string) => {
    expect(trx).toBe(TRX);
    state.events.push(`keys ${owner}`);
    return state.passes[pass]?.keys ?? [];
  });
  revokeActiveOauthClientsOf.mockReset().mockImplementation(async (trx: unknown, owner: string) => {
    expect(trx).toBe(TRX);
    state.events.push(`clients ${owner}`);
    return state.passes[pass++]?.clients ?? [];
  });
  auditEvent.mockReset().mockImplementation(async (arg: { metadata: Record<string, string> }) => {
    state.events.push(`audit ${arg.metadata.apiKeyId ?? arg.metadata.clientRowId}`);
  });
  M = await import("@/lib/api-auth/credential-eviction.server");
});

const request = { headers: new Headers({ "x-test": "1" }) };
const reset = {
  betterAuthUserId: "ba-owner",
  trigger: "password_reset" as const,
  actorBetterAuthUserId: "ba-owner",
};

describe("revokeBearerCredentialsOf", () => {
  it("revokes every active API key the account owns and every OAuth client acting as it", async () => {
    await expect(M.revokeBearerCredentialsOf(reset)).resolves.toEqual({
      apiKeyIds: ["k1", "k2"],
      oauthClientIds: ["c1"],
    });

    // A reset revokes in the account's own name, with the trigger as reason.
    expect(revokeActiveApiKeysOf).toHaveBeenCalledWith(
      TRX,
      "app-owner",
      "app-owner",
      "password_reset",
    );
    expect(revokeActiveOauthClientsOf).toHaveBeenCalledWith(TRX, "app-owner", "app-owner");
  });

  it("looks the owner up by Better Auth id", async () => {
    await M.revokeBearerCredentialsOf(reset);

    expect(state.lookups).toEqual([
      { table: "app_users", where: [["better_auth_user_id", "=", "ba-owner"]] },
    ]);
  });

  it("revokes under the owner's eviction lock, keys and clients in ONE transaction, and audits after it commits", async () => {
    await M.revokeBearerCredentialsOf(reset);

    expect(state.events).toEqual([
      // Pass 1: the lock first, so a fenced issuance either committed before
      // it (and is revoked here) or waits and is refused.
      "begin",
      "lock app-owner",
      "keys app-owner",
      "clients app-owner",
      "commit",
      "audit k1",
      "audit k2",
      "audit c1",
      // Pass 2 finds nothing, which ends the sweep.
      "begin",
      "lock app-owner",
      "keys app-owner",
      "clients app-owner",
      "commit",
    ]);
  });

  it("repeats until a pass revokes nothing, so a credential committed mid-sweep is caught", async () => {
    state.passes.push({ keys: [{ id: "k3", organization_id: null }], clients: [] });
    state.passes.push({ keys: [], clients: [{ id: "c2", organization_id: null }] });

    await expect(M.revokeBearerCredentialsOf(reset)).resolves.toEqual({
      apiKeyIds: ["k1", "k2", "k3"],
      oauthClientIds: ["c1", "c2"],
    });
    expect(revokeActiveApiKeysOf).toHaveBeenCalledTimes(4);
    expect(auditEvent).toHaveBeenCalledTimes(5);
  });

  it("throws once 5 passes still revoked something, after auditing what they revoked", async () => {
    expect(M.MAX_EVICTION_PASSES).toBe(5);
    revokeActiveApiKeysOf.mockImplementation(async () => [
      { id: `k-${pass}`, organization_id: null },
    ]);
    revokeActiveOauthClientsOf.mockImplementation(async () => {
      pass++;
      return [];
    });

    await expect(M.revokeBearerCredentialsOf(reset)).rejects.toThrow(
      "still being created after 5 eviction passes",
    );
    expect(revokeActiveApiKeysOf).toHaveBeenCalledTimes(5);
    expect(auditEvent).toHaveBeenCalledTimes(5);
  });

  it("audits each revoked credential against the account, its org and the request", async () => {
    await M.revokeBearerCredentialsOf({ ...reset, request, requestId: "req-1" });

    expect(auditEvent.mock.calls.map(([arg]) => arg)).toEqual([
      {
        eventType: "api_key.revoked",
        outcome: "success",
        actorBetterAuthUserId: "ba-owner",
        appUserId: "app-owner",
        organizationId: "org-a",
        request,
        requestId: "req-1",
        metadata: { apiKeyId: "k1", reason: "password_reset" },
      },
      expect.objectContaining({
        eventType: "api_key.revoked",
        organizationId: null,
        metadata: { apiKeyId: "k2", reason: "password_reset" },
      }),
      {
        eventType: "oauth_client.revoked",
        outcome: "success",
        actorBetterAuthUserId: "ba-owner",
        appUserId: "app-owner",
        organizationId: "org-a",
        request,
        requestId: "req-1",
        metadata: { clientRowId: "c1", reason: "password_reset" },
      },
    ]);
  });

  it("records an admin set-password in the ADMIN's name", async () => {
    await M.revokeBearerCredentialsOf({
      betterAuthUserId: "ba-owner",
      trigger: "password_set",
      actorBetterAuthUserId: "ba-admin",
      revokedByAppUserId: "app-admin",
    });

    expect(revokeActiveApiKeysOf).toHaveBeenCalledWith(
      TRX,
      "app-owner",
      "app-admin",
      "password_set",
    );
    expect(revokeActiveOauthClientsOf).toHaveBeenCalledWith(TRX, "app-owner", "app-admin");
    for (const [arg] of auditEvent.mock.calls) {
      expect(arg).toEqual(
        expect.objectContaining({
          actorBetterAuthUserId: "ba-admin",
          appUserId: "app-owner",
          requestId: null,
          request: undefined,
          metadata: expect.objectContaining({ reason: "password_set" }),
        }),
      );
    }
  });

  it("falls back to the account as revoker when the admin has no app user row", async () => {
    await M.revokeBearerCredentialsOf({
      betterAuthUserId: "ba-owner",
      trigger: "password_set",
      actorBetterAuthUserId: "ba-admin",
      revokedByAppUserId: null,
    });

    expect(revokeActiveApiKeysOf).toHaveBeenCalledWith(
      TRX,
      "app-owner",
      "app-owner",
      "password_set",
    );
    expect(revokeActiveOauthClientsOf).toHaveBeenCalledWith(TRX, "app-owner", "app-owner");
  });

  it("audits only what its own UPDATE returned (a row another revoke got to first is not reported)", async () => {
    // A concurrent revoke's rows are simply absent from RETURNING; that
    // revoke wrote its own audit row.
    state.passes = [{ keys: [{ id: "k2", organization_id: null }], clients: [] }];

    await expect(M.revokeBearerCredentialsOf(reset)).resolves.toEqual({
      apiKeyIds: ["k2"],
      oauthClientIds: [],
    });
    expect(auditEvent).toHaveBeenCalledTimes(1);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { apiKeyId: "k2", reason: "password_reset" } }),
    );
  });

  it("is a no-op for an account that was never provisioned (no app_users row)", async () => {
    state.owner = undefined;

    await expect(M.revokeBearerCredentialsOf(reset)).resolves.toEqual({
      apiKeyIds: [],
      oauthClientIds: [],
    });
    expect(state.lookups.map((q) => q.table)).toEqual(["app_users"]);
    expect(state.events).toEqual([]);
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("never queries for an empty id", async () => {
    await expect(M.revokeBearerCredentialsOf({ ...reset, betterAuthUserId: "" })).resolves.toEqual({
      apiKeyIds: [],
      oauthClientIds: [],
    });
    expect(state.lookups).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("propagates a failed revoke (callers decide whether it fails their action)", async () => {
    revokeActiveApiKeysOf.mockRejectedValue(new Error("db down"));

    await expect(M.revokeBearerCredentialsOf(reset)).rejects.toThrow("db down");
    expect(auditEvent).not.toHaveBeenCalled();
  });
});
