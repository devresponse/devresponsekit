import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { createApiKey, revokeApiKey, rotateApiKey } from "@/lib/api-auth/api-keys.server";
import {
  createOauthClient,
  revokeOauthClient,
  rotateOauthClientSecret,
  verifyClientCredentials,
} from "@/lib/api-auth/oauth-clients.server";

/**
 * DB-BACKED test for F-72: a credential rotation or revoke that races another
 * one acts on the row as it is when its own write runs, not as it was read.
 *
 * Each race is staged with two real connections. One holds an uncommitted
 * revoke (or a rotation's retire) on the row, so the row lock is taken and the
 * old version is still the committed one; the call under test then reads the
 * credential as active and blocks on that lock in its write. Once the holder
 * commits, Postgres re-evaluates the write's WHERE against the new version.
 *
 *   - An OAuth secret rotation racing a revoke used to write the new secret
 *     onto the revoked row and return it (`rotateOauthClientSecret` read the
 *     status, then updated by id alone). It now returns null: the route's 409.
 *   - An API-key rotation racing a revoke mints no successor and keeps the
 *     revoker and reason (c41e177 retires first; the eviction variant is in
 *     credential-eviction.db.test.ts, this is the single-key revoke), and two
 *     rotations of one key mint one successor.
 *   - A revoke that waits on a rotation (or on another revoke) reports false,
 *     which the administrator DELETE routes now answer with `alreadyRevoked`
 *     and no audit row.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f72_`
 * and clean up after themselves (keys and clients cascade from the owner).
 */
const PREFIX = "__dbtest_f72_";
let ownerId: string;
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

beforeAll(async () => {
  ownerId = await newUser("owner");
  adminId = await newUser("admin");
});

afterAll(async () => {
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

async function newKey() {
  return createApiKey({
    ownerAppUserId: ownerId,
    organizationId: null,
    name: `${PREFIX}key`,
    scopes: ["account.read"],
    expiresAt: null,
    createdByAppUserId: ownerId,
  });
}

async function newClient() {
  return createOauthClient({
    name: `${PREFIX}client`,
    scopes: ["account.read"],
    organizationId: null,
    serviceAppUserId: ownerId,
    createdByAppUserId: adminId,
  });
}

/** A promise the test resolves by hand, to hold a transaction open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * "pending" if `promise` has not settled after `ms`. A lock wait cannot settle
 * while the lock is held, so "pending" is deterministic, not a timing guess.
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

/**
 * Runs `write` in a transaction on its own connection and keeps it open, with
 * its row locks held, until `commit()` is called.
 */
async function holdUncommitted(write: (trx: typeof db) => Promise<unknown>) {
  const held = gate();
  const locked = gate();
  const done = db.transaction().execute(async (trx) => {
    await write(trx);
    locked.open();
    await held.wait;
  });
  await locked.wait;
  return {
    commit: async () => {
      held.open();
      await done;
    },
  };
}

async function liveKeysOfOwner() {
  return db
    .selectFrom("app_api_keys")
    .select("id")
    .where("app_user_id", "=", ownerId)
    .where("status", "=", "active")
    .execute();
}

describe("OAuth client secret rotation (F-72)", () => {
  it("a rotation racing a revoke writes no secret onto the revoked client and returns null", async () => {
    const client = await newClient();
    const before = await db
      .selectFrom("app_oauth_clients")
      .select("client_secret_hash")
      .where("id", "=", client.id)
      .executeTakeFirstOrThrow();
    // An admin revoke, in flight: the row is locked, `active` still committed.
    const revoke = await holdUncommitted((trx) =>
      trx
        .updateTable("app_oauth_clients")
        .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: adminId })
        .where("id", "=", client.id)
        .where("status", "=", "active")
        .execute(),
    );

    const rotating = rotateOauthClientSecret(client.id);
    const whileHeld = await stateAfter(rotating);
    await revoke.commit();

    expect(whileHeld).toBe("pending");
    await expect(rotating).resolves.toBeNull();
    const row = await db
      .selectFrom("app_oauth_clients")
      .select(["status", "revoked_by", "client_secret_hash", "secret_rotated_at"])
      .where("id", "=", client.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "revoked",
      revoked_by: adminId,
      client_secret_hash: before.client_secret_hash,
      secret_rotated_at: null,
    });
  });

  it("CONTROL: an uncontended rotation still returns a secret the token endpoint accepts", async () => {
    const client = await newClient();
    const secret = await rotateOauthClientSecret(client.id);
    expect(secret).toMatch(/^drkcsec_/);
    await expect(verifyClientCredentials(client.client_id, secret!)).resolves.not.toBeNull();
    await expect(
      verifyClientCredentials(client.client_id, client.clientSecret),
    ).resolves.toBeNull();
  });

  it("a revoke waiting on another revoke reports false (the admin route's alreadyRevoked)", async () => {
    const client = await newClient();
    const first = await holdUncommitted((trx) =>
      trx
        .updateTable("app_oauth_clients")
        .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: ownerId })
        .where("id", "=", client.id)
        .where("status", "=", "active")
        .execute(),
    );

    const second = revokeOauthClient(client.id, adminId);
    const whileHeld = await stateAfter(second);
    await first.commit();

    expect(whileHeld).toBe("pending");
    await expect(second).resolves.toBe(false);
  });
});

describe("API key rotation (F-72, retire-first since c41e177)", () => {
  it("a rotation racing a single-key revoke mints no successor and keeps the revoker and reason", async () => {
    const key = await newKey();
    const revoke = await holdUncommitted((trx) =>
      trx
        .updateTable("app_api_keys")
        .set({
          status: "revoked",
          revoked_at: sql`now()`,
          revoked_by: adminId,
          revoked_reason: "admin_revoked",
        })
        .where("id", "=", key.id)
        .where("status", "=", "active")
        .execute(),
    );

    // It reads the key as active (the revoke is not committed yet).
    const rotating = rotateApiKey(key.id, ownerId);
    const whileHeld = await stateAfter(rotating);
    await revoke.commit();

    expect(whileHeld).toBe("pending");
    await expect(rotating).resolves.toBeNull();
    const row = await db
      .selectFrom("app_api_keys")
      .select(["status", "revoked_by", "revoked_reason"])
      .where("id", "=", key.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "revoked",
      revoked_by: adminId,
      revoked_reason: "admin_revoked",
    });
    expect(await liveKeysOfOwner()).toEqual([]);
  });

  it("two rotations of one key at once mint exactly one successor", async () => {
    const key = await newKey();
    const results = await Promise.all([
      rotateApiKey(key.id, ownerId),
      rotateApiKey(key.id, ownerId),
    ]);

    const minted = results.filter((r) => r !== null);
    expect(minted).toHaveLength(1);
    expect((await liveKeysOfOwner()).map((r) => r.id)).toEqual([minted[0]!.id]);
  });

  it("a revoke waiting on a rotation's retire reports false and leaves the rotation's reason", async () => {
    const key = await newKey();
    const rotation = await holdUncommitted((trx) =>
      trx
        .updateTable("app_api_keys")
        .set({
          status: "revoked",
          revoked_at: sql`now()`,
          revoked_by: ownerId,
          revoked_reason: "rotated",
        })
        .where("id", "=", key.id)
        .where("status", "=", "active")
        .execute(),
    );

    const revoking = revokeApiKey(key.id, adminId, "leaked");
    const whileHeld = await stateAfter(revoking);
    await rotation.commit();

    expect(whileHeld).toBe("pending");
    await expect(revoking).resolves.toBe(false);
    const row = await db
      .selectFrom("app_api_keys")
      .select(["revoked_by", "revoked_reason"])
      .where("id", "=", key.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ revoked_by: ownerId, revoked_reason: "rotated" });
  });
});
