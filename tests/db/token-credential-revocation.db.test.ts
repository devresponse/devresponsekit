import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { createApiKey, revokeApiKey, rotateApiKey } from "@/lib/api-auth/api-keys.server";
import {
  createOauthClient,
  revokeOauthClient,
  rotateOauthClientSecret,
} from "@/lib/api-auth/oauth-clients.server";
import { isSourceCredentialActive } from "@/lib/api-auth/revocation.server";

/**
 * DB-BACKED test for outstanding-token revocation (review #43).
 *
 * A JWT carries a `cid` claim naming the key / client it was minted from,
 * and the resolver asks {@link isSourceCredentialActive} on every request.
 * This suite runs the REAL lifecycle writes (`revokeApiKey`, `rotateApiKey`,
 * `revokeOauthClient`, `rotateOauthClientSecret`) against live Postgres and
 * checks the read side flips exactly when it must:
 *
 *   mint (active → true) → revoke → next request refused (false)
 *   mint from key A → rotate → token from A refused, token from B honoured
 *   mint from client → rotate secret → pre-rotation `iat` refused, post kept
 *
 * `issuedAt` stands in for the token's `iat`. Driven by `pnpm test:db`
 * (vitest.db.config.ts). Fixtures use `__dbtest_` and self-clean.
 */
const PREFIX = "__dbtest_tokrev_";
let ownerId: string;
let actorId: string;

beforeAll(async () => {
  const owner = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_owner`,
      primary_email: `${PREFIX}owner@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  ownerId = owner.id;
  const actor = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_actor`,
      primary_email: `${PREFIX}actor@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  actorId = actor.id;
});

afterAll(async () => {
  // Keys/clients cascade from the owner row.
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await pgPool.end();
});

async function newKey(expiresAt: Date | null = null) {
  return createApiKey({
    ownerAppUserId: ownerId,
    organizationId: null,
    name: `${PREFIX}key`,
    scopes: ["account.read"],
    expiresAt,
    createdByAppUserId: actorId,
  });
}

async function newClient() {
  return createOauthClient({
    name: `${PREFIX}client`,
    scopes: ["account.read"],
    organizationId: null,
    serviceAppUserId: ownerId,
    createdByAppUserId: actorId,
  });
}

describe("API key as the token's source credential", () => {
  it("is honoured while active and refused from the request after revocation", async () => {
    const key = await newKey();
    const ref = { kind: "api_key" as const, id: key.id };
    const issuedAt = new Date();
    expect(await isSourceCredentialActive(ref, issuedAt)).toBe(true);

    expect(await revokeApiKey(key.id, actorId, "compromised")).toBe(true);
    // The SAME token (same cid, same iat) is now dead — no waiting for exp.
    expect(await isSourceCredentialActive(ref, issuedAt)).toBe(false);
  });

  it("rotation retires tokens minted from the OLD key and honours the new one", async () => {
    const oldKey = await newKey();
    const tokenFromOld = { kind: "api_key" as const, id: oldKey.id };
    const issuedAt = new Date();
    expect(await isSourceCredentialActive(tokenFromOld, issuedAt)).toBe(true);

    const newKeyRow = await rotateApiKey(oldKey.id, actorId);
    expect(newKeyRow).not.toBeNull();
    // Token minted before the rotation, with the old key → refused.
    expect(await isSourceCredentialActive(tokenFromOld, issuedAt)).toBe(false);
    // Token minted from the replacement key → honoured.
    expect(await isSourceCredentialActive({ kind: "api_key", id: newKeyRow!.id }, new Date())).toBe(
      true,
    );
  });

  it("refuses a token once its key's expires_at has passed, and an unknown key id", async () => {
    const soon = await newKey(new Date(Date.now() + 60_000));
    expect(await isSourceCredentialActive({ kind: "api_key", id: soon.id }, new Date())).toBe(true);
    // Move the expiry into the past (the operator shortening a key's life
    // after tokens were minted from it).
    await db
      .updateTable("app_api_keys")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("id", "=", soon.id)
      .execute();
    expect(await isSourceCredentialActive({ kind: "api_key", id: soon.id }, new Date())).toBe(
      false,
    );
    expect(
      await isSourceCredentialActive(
        { kind: "api_key", id: "00000000-0000-4000-8000-000000000000" },
        new Date(),
      ),
    ).toBe(false);
  });
});

describe("OAuth client as the token's source credential", () => {
  it("is honoured while active and refused after the client is revoked", async () => {
    const client = await newClient();
    const ref = { kind: "oauth_client" as const, id: client.id };
    const issuedAt = new Date();
    expect(await isSourceCredentialActive(ref, issuedAt)).toBe(true);
    expect(await revokeOauthClient(client.id, actorId)).toBe(true);
    expect(await isSourceCredentialActive(ref, issuedAt)).toBe(false);
  });

  it("secret rotation retires tokens issued with the OLD secret but not those issued after", async () => {
    const client = await newClient();
    const ref = { kind: "oauth_client" as const, id: client.id };
    // Minted with the original secret, a little before the rotation (JWT
    // `iat` has one-second resolution, so back it off a full second).
    const issuedBefore = new Date(Date.now() - 1_000);
    expect(await isSourceCredentialActive(ref, issuedBefore)).toBe(true);

    const newSecret = await rotateOauthClientSecret(client.id);
    expect(newSecret).toMatch(/^drkcsec_/);
    const row = await db
      .selectFrom("app_oauth_clients")
      .select(["status", "secret_rotated_at"])
      .where("id", "=", client.id)
      .executeTakeFirstOrThrow();
    // The row stays active (minting with the NEW secret must keep working)…
    expect(row.status).toBe("active");
    expect(row.secret_rotated_at).not.toBeNull();
    // …yet the pre-rotation token is refused, and a post-rotation one is not.
    expect(await isSourceCredentialActive(ref, issuedBefore)).toBe(false);
    expect(await isSourceCredentialActive(ref, new Date(Date.now() + 1_000))).toBe(true);
  });
});
