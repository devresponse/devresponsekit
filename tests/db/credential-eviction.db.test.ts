import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import {
  createApiKey,
  revokeActiveApiKeysOf,
  revokeApiKey,
  rotateApiKey,
} from "@/lib/api-auth/api-keys.server";
import { revokeBearerCredentialsOf } from "@/lib/api-auth/credential-eviction.server";
import {
  IssuingCredentialRevokedError,
  enterIssuanceFence,
  inIssuanceTransaction,
  isCallerSourceLive,
  lockOwnerForEviction,
} from "@/lib/api-auth/issuance-fence.server";
import { createOauthClient } from "@/lib/api-auth/oauth-clients.server";
import { isSourceCredentialActive } from "@/lib/api-auth/revocation.server";

/**
 * DB-BACKED test for the F-10 credential cut-off.
 *
 * A completed password reset or an admin set-password calls
 * `revokeBearerCredentialsOf`. It must retire every API key the account owns
 * and every OAuth client acting as it, together with the JWTs minted from them
 * (the `cid` check), and it must leave three kinds of row alone:
 *
 *   - another principal's credentials;
 *   - credentials the account MINTED for another principal (`created_by` =
 *     the account), which authenticate as someone whose password did not
 *     change;
 *   - rows already revoked, which keep their original `revoked_by` / reason.
 *
 * It also writes one audit row per credential it revoked. And no credential
 * may be BORN while it runs: the issuance fence's row locks serialize an
 * eviction against every fenced issuance, proven below with two real
 * connections holding and waiting on the locks. Driven by `pnpm test:db`
 * (vitest.db.config.ts). Fixtures use `__dbtest_` and clean up after
 * themselves.
 */
const PREFIX = "__dbtest_f10evict_";
let ownerId: string;
let otherId: string;
let adminId: string;

async function newUser(tag: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_${tag}`,
      primary_email: `${PREFIX}${tag}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newKey(owner: string, createdBy: string) {
  return createApiKey({
    ownerAppUserId: owner,
    organizationId: null,
    name: `${PREFIX}key`,
    scopes: ["account.read"],
    expiresAt: null,
    createdByAppUserId: createdBy,
  });
}

async function newClient(servicePrincipal: string, createdBy: string) {
  return createOauthClient({
    name: `${PREFIX}client`,
    scopes: ["account.read"],
    organizationId: null,
    serviceAppUserId: servicePrincipal,
    createdByAppUserId: createdBy,
  });
}

/** A promise the test resolves by hand, to hold a transaction open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * "pending" if `promise` has not settled after `ms`. A lock wait cannot
 * settle while the lock is held, so "pending" is deterministic, not a timing
 * guess.
 */
async function stateAfter(promise: Promise<unknown>, ms = 300) {
  return Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

async function keyRow(id: string) {
  return db
    .selectFrom("app_api_keys")
    .select(["status", "revoked_by", "revoked_reason"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function clientRow(id: string) {
  return db
    .selectFrom("app_oauth_clients")
    .select(["status", "revoked_by"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/**
 * Removes every fixture of this suite, including a crashed run's. Audit rows
 * are append-only, so they go through the sanctioned retention path (owner +
 * `app.audit_retention = 'on'`, as the sibling suites do), and first:
 * `app_audit_events.app_user_id` is RI-checked on every `app_users` delete.
 * Keys and clients go next, since they reference the fixtures through
 * `created_by` / `revoked_by` as well as their owner.
 */
async function cleanup(): Promise<void> {
  const fixtureUsers = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("app_user_id", "in", fixtureUsers).execute();
  });
  await db.deleteFrom("app_api_keys").where("app_user_id", "in", fixtureUsers).execute();
  await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", fixtureUsers).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
}

beforeAll(async () => {
  await cleanup();
  ownerId = await newUser("owner");
  otherId = await newUser("other");
  adminId = await newUser("admin");
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("the issuance fence against Postgres (F-10)", () => {
  const evict = () =>
    revokeBearerCredentialsOf({
      betterAuthUserId: `${PREFIX}ba_owner`,
      trigger: "password_reset",
      actorBetterAuthUserId: `${PREFIX}ba_owner`,
    });

  it("an issuance holding the fence first makes the eviction wait, then its new key is revoked too", async () => {
    // The thief's key mints another key: the request passed the fence (its
    // key still live) and has inserted, but not yet committed.
    const callingKey = await newKey(ownerId, ownerId);
    const held = gate();
    const inserted = gate();
    let bornId = "";
    const issuing = inIssuanceTransaction(async (trx) => {
      await enterIssuanceFence(trx, ownerId, { kind: "api_key", id: callingKey.id });
      const row = await trx
        .insertInto("app_api_keys")
        .values({
          app_user_id: ownerId,
          organization_id: null,
          name: `${PREFIX}born-mid-eviction`,
          key_prefix: "drk_test_born",
          key_hash: `${PREFIX}${randomUUID()}`,
          scopes: ["account.apikeys.manage"],
          status: "active",
          created_by: ownerId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      bornId = row.id;
      inserted.open();
      await held.wait;
    });
    await inserted.wait;

    const evicting = evict();
    // Blocked on the owner's row lock, not racing past the uncommitted key.
    // (Read before the gate opens, asserted after, so a failure cannot leave
    // the transaction holding its lock for the next case.)
    const whileHeld = await stateAfter(evicting);
    held.open();
    await issuing;
    expect(whileHeld).toBe("pending");
    const result = await evicting;

    expect(result.apiKeyIds).toEqual(expect.arrayContaining([callingKey.id, bornId]));
    expect((await keyRow(bornId)).status).toBe("revoked");
  });

  it("an issuance arriving while the eviction holds the lock waits, then is refused and inserts nothing", async () => {
    const callingKey = await newKey(ownerId, ownerId);
    const held = gate();
    const locked = gate();
    // The eviction, paused between its revoke and its commit.
    const evicting = inIssuanceTransaction(async (trx) => {
      await lockOwnerForEviction(trx, ownerId);
      await revokeActiveApiKeysOf(trx, ownerId, ownerId, "password_reset");
      locked.open();
      await held.wait;
    });
    await locked.wait;

    const minting = createApiKey({
      ownerAppUserId: ownerId,
      organizationId: null,
      name: `${PREFIX}refused-mint`,
      scopes: ["account.read"],
      expiresAt: null,
      createdByAppUserId: ownerId,
      issuedVia: { kind: "api_key", id: callingKey.id },
    });
    // Its re-check must not run on a snapshot from before the eviction.
    const whileHeld = await stateAfter(minting);
    held.open();
    await evicting;
    expect(whileHeld).toBe("pending");
    await expect(minting).rejects.toBeInstanceOf(IssuingCredentialRevokedError);
    const minted = await db
      .selectFrom("app_api_keys")
      .select("id")
      .where("name", "=", `${PREFIX}refused-mint`)
      .execute();
    expect(minted).toEqual([]);
  });

  it("a rotation racing the eviction hands out no successor and keeps the eviction's revoker and reason", async () => {
    const rotated = await newKey(ownerId, ownerId);
    const held = gate();
    const locked = gate();
    const evicting = inIssuanceTransaction(async (trx) => {
      await lockOwnerForEviction(trx, ownerId);
      await revokeActiveApiKeysOf(trx, ownerId, adminId, "password_set");
      locked.open();
      await held.wait;
    });
    await locked.wait;

    // It read the key as active (the revoke is not committed yet), so only the
    // fence and the retire-first can stop it.
    const rotating = rotateApiKey(rotated.id, ownerId);
    const whileHeld = await stateAfter(rotating);
    held.open();
    await evicting;
    expect(whileHeld).toBe("pending");
    await expect(rotating).resolves.toBeNull();
    expect(await keyRow(rotated.id)).toEqual({
      status: "revoked",
      revoked_by: adminId,
      revoked_reason: "password_set",
    });
    const live = await db
      .selectFrom("app_api_keys")
      .select("id")
      .where("app_user_id", "=", ownerId)
      .where("status", "=", "active")
      .execute();
    expect(live).toEqual([]);
  });

  it("an issuance that is not racing anything is admitted", async () => {
    const callingKey = await newKey(ownerId, ownerId);

    const created = await createApiKey({
      ownerAppUserId: ownerId,
      organizationId: null,
      name: `${PREFIX}ordinary-mint`,
      scopes: ["account.read"],
      expiresAt: null,
      createdByAppUserId: ownerId,
      issuedVia: { kind: "api_key", id: callingKey.id },
    });

    expect((await keyRow(created.id)).status).toBe("active");
    await evict();
  });

  it("the session re-check runs against Better Auth's real session table", async () => {
    await expect(
      isCallerSourceLive({ kind: "session", sessionId: `${PREFIX}no-such-session` }),
    ).resolves.toBe(false);
  });
});

describe("revokeBearerCredentialsOf against Postgres (F-10)", () => {
  it("retires the account's keys and clients, their JWTs, and nothing that is not the account's", async () => {
    const ownKey = await newKey(ownerId, ownerId);
    const keyAdminMintedForOwner = await newKey(ownerId, adminId);
    const ownClient = await newClient(ownerId, adminId);
    // Controls.
    const othersKey = await newKey(otherId, otherId);
    const keyOwnerMintedForOther = await newKey(otherId, ownerId);
    const clientOwnerMintedForOther = await newClient(otherId, ownerId);
    const alreadyRevoked = await newKey(ownerId, ownerId);
    expect(await revokeApiKey(alreadyRevoked.id, otherId, "self_revoked")).toBe(true);

    const issuedAt = new Date();
    const result = await revokeBearerCredentialsOf({
      betterAuthUserId: `${PREFIX}ba_owner`,
      trigger: "password_set",
      actorBetterAuthUserId: `${PREFIX}ba_admin`,
      revokedByAppUserId: adminId,
      requestId: `${PREFIX}req`,
    });

    expect([...result.apiKeyIds].sort()).toEqual([ownKey.id, keyAdminMintedForOwner.id].sort());
    expect(result.oauthClientIds).toEqual([ownClient.id]);

    for (const key of [ownKey, keyAdminMintedForOwner]) {
      expect(await keyRow(key.id)).toEqual({
        status: "revoked",
        revoked_by: adminId,
        revoked_reason: "password_set",
      });
      // A JWT minted from it dies on its next request.
      expect(await isSourceCredentialActive({ kind: "api_key", id: key.id }, issuedAt)).toBe(false);
    }
    expect(await clientRow(ownClient.id)).toEqual({ status: "revoked", revoked_by: adminId });
    expect(
      await isSourceCredentialActive({ kind: "oauth_client", id: ownClient.id }, issuedAt),
    ).toBe(false);

    // Untouched: another principal's credentials, including the ones the
    // account itself minted for them…
    for (const key of [othersKey, keyOwnerMintedForOther]) {
      expect((await keyRow(key.id)).status).toBe("active");
    }
    expect((await clientRow(clientOwnerMintedForOther.id)).status).toBe("active");
    // …and a row already revoked keeps its original revoker and reason.
    expect(await keyRow(alreadyRevoked.id)).toEqual({
      status: "revoked",
      revoked_by: otherId,
      revoked_reason: "self_revoked",
    });

    const audits = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "outcome", "actor_better_auth_user_id", "request_id", "metadata"])
      .where("app_user_id", "=", ownerId)
      .where("request_id", "=", `${PREFIX}req`)
      .execute();
    expect(audits).toHaveLength(3);
    for (const row of audits) {
      expect(row.outcome).toBe("success");
      expect(row.actor_better_auth_user_id).toBe(`${PREFIX}ba_admin`);
      expect(row.metadata).toEqual(expect.objectContaining({ reason: "password_set" }));
    }
    expect(audits.map((row) => row.event_type).sort()).toEqual([
      "api_key.revoked",
      "api_key.revoked",
      "oauth_client.revoked",
    ]);
  });

  it("is idempotent: a second run revokes and audits nothing", async () => {
    await newKey(ownerId, ownerId);
    await revokeBearerCredentialsOf({
      betterAuthUserId: `${PREFIX}ba_owner`,
      trigger: "password_reset",
      actorBetterAuthUserId: `${PREFIX}ba_owner`,
    });

    await expect(
      revokeBearerCredentialsOf({
        betterAuthUserId: `${PREFIX}ba_owner`,
        trigger: "password_reset",
        actorBetterAuthUserId: `${PREFIX}ba_owner`,
        requestId: `${PREFIX}req-again`,
      }),
    ).resolves.toEqual({ apiKeyIds: [], oauthClientIds: [] });
    const audits = await db
      .selectFrom("app_audit_events")
      .select("id")
      .where("request_id", "=", `${PREFIX}req-again`)
      .execute();
    expect(audits).toEqual([]);
  });

  it("a reset records the account itself as the revoker", async () => {
    const key = await newKey(ownerId, ownerId);

    await revokeBearerCredentialsOf({
      betterAuthUserId: `${PREFIX}ba_owner`,
      trigger: "password_reset",
      actorBetterAuthUserId: `${PREFIX}ba_owner`,
    });

    expect(await keyRow(key.id)).toEqual({
      status: "revoked",
      revoked_by: ownerId,
      revoked_reason: "password_reset",
    });
  });

  it("does nothing for a Better Auth id with no app user (e.g. never provisioned)", async () => {
    await expect(
      revokeBearerCredentialsOf({
        betterAuthUserId: `${PREFIX}ba_nobody`,
        trigger: "password_reset",
        actorBetterAuthUserId: `${PREFIX}ba_nobody`,
      }),
    ).resolves.toEqual({ apiKeyIds: [], oauthClientIds: [] });
  });
});
