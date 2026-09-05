import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { consumeSsoHandoffNonce } from "@/lib/sso.server";

/**
 * DB-BACKED tests for the one-time SSO handoff nonce burn (review #66).
 *
 * `consumeSsoHandoffNonce` is the replay defence: the confirm POST burns the
 * `jti` atomically BEFORE establishing a session, so two confirmations of the
 * same token — even CONCURRENT ones — must yield exactly one session. The
 * unit suite proves the predicates against a mock; only live Postgres proves
 * the atomicity (a single conditional UPDATE … RETURNING under row locking),
 * so this runs two burns in parallel on one pool and counts the winners.
 *
 * Fixtures use the `__dbtest_` prefix and are created/torn down here.
 */
const PREFIX = "__dbtest_ssononce_";
const APP_ID = `${PREFIX}portal`;
const OTHER_APP_ID = `${PREFIX}other`;

async function cleanup(): Promise<void> {
  await db.deleteFrom("app_sso_handoff_nonces").where("jti", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

const ids = { org: "", user: "" };

async function newNonce(jti: string, opts: { app?: string; expiresInMs?: number } = {}) {
  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti,
      app_user_id: ids.user,
      target_application_id: opts.app ?? APP_ID,
      expires_at: new Date(Date.now() + (opts.expiresInMs ?? 60_000)),
      consumed_at: null,
    })
    .execute();
}

async function consumedAt(jti: string): Promise<Date | null> {
  const row = await db
    .selectFrom("app_sso_handoff_nonces")
    .select("consumed_at")
    .where("jti", "=", jti)
    .executeTakeFirstOrThrow();
  return row.consumed_at as Date | null;
}

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "DBTest SSO Org" })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.org = org.id;
  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_user`,
      primary_email: `${PREFIX}user@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.user = user.id;
  for (const id of [APP_ID, OTHER_APP_ID]) {
    await db
      .insertInto("app_enterprise_applications")
      .values({
        id,
        organization_id: ids.org,
        label: `DBTest ${id}`,
        origin: `https://${id.replace(/_/g, "-")}.example.com`,
        subdomain: id.replace(/_/g, "-"),
        sso_audience: `devresponse-app:${id}`,
      })
      .execute();
  }
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("consumeSsoHandoffNonce (live SQL)", () => {
  it("two CONCURRENT burns of one jti: exactly one wins, the row is consumed once", async () => {
    const jti = `${PREFIX}race`;
    await newNonce(jti);
    // Both UPDATEs are issued before either resolves; the pool hands them to
    // separate connections (max 10), so they contend on the same row.
    const results = await Promise.all([
      consumeSsoHandoffNonce(jti, APP_ID),
      consumeSsoHandoffNonce(jti, APP_ID),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumedAt(jti)).toBeInstanceOf(Date);
    // A later replay is refused too.
    await expect(consumeSsoHandoffNonce(jti, APP_ID)).resolves.toBe(false);
  });

  it("a larger concurrent burst still yields exactly one winner", async () => {
    const jti = `${PREFIX}burst`;
    await newNonce(jti);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeSsoHandoffNonce(jti, APP_ID)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a nonce minted for ANOTHER application and leaves it unconsumed (review #15)", async () => {
    const jti = `${PREFIX}foreign`;
    await newNonce(jti, { app: OTHER_APP_ID });
    await expect(consumeSsoHandoffNonce(jti, APP_ID)).resolves.toBe(false);
    expect(await consumedAt(jti)).toBeNull();
    // The app it WAS minted for can still spend it — once.
    await expect(consumeSsoHandoffNonce(jti, OTHER_APP_ID)).resolves.toBe(true);
    await expect(consumeSsoHandoffNonce(jti, OTHER_APP_ID)).resolves.toBe(false);
  });

  it("refuses an expired nonce and an unknown jti", async () => {
    const jti = `${PREFIX}expired`;
    await newNonce(jti, { expiresInMs: -1_000 });
    await expect(consumeSsoHandoffNonce(jti, APP_ID)).resolves.toBe(false);
    expect(await consumedAt(jti)).toBeNull();
    await expect(consumeSsoHandoffNonce(`${PREFIX}never_minted`, APP_ID)).resolves.toBe(false);
  });
});
