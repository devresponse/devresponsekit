import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-BACKED test for F-150: the REAL `auth` instance (src/lib/auth.ts, its
 * `databaseHooks.account`) writing through Better Auth's Kysely adapter into
 * the real `account` table. Every provider-account write in an OAuth callback
 * (create on a first sign-in or link, update on each later sign-in) is one of
 * the two internal-adapter calls driven here; the round trip itself is
 * covered against the memory adapter in
 * tests/security/provider-token-storage.test.ts.
 *
 *   1. Creating a provider account stores no access, refresh or ID token (nor
 *      their expiries); the rest of the row (provider, account id, scope) is
 *      kept.
 *   2. A token refresh on a row an older build wrote clears every token on it,
 *      including one the refresh did not carry.
 *   3. A credential account keeps its password, and a password change leaves
 *      the token columns alone.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f150_`
 * and self-clean (accounts cascade with their user).
 */
const { pgPool } = await import("@/db/database");
const { auth } = await import("@/lib/auth");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `__dbtest_f150_${RUN}_`;
let userId: string;

type AccountRow = {
  providerId: string;
  accountId: string;
  scope: string | null;
  password: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
};

async function readAccount(id: string): Promise<AccountRow> {
  const { rows } = await pgPool.query<AccountRow>(
    `select "providerId", "accountId", scope, password, "accessToken", "refreshToken",
            "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt"
       from "account" where id = $1`,
    [id],
  );
  return rows[0]!;
}

const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

beforeAll(async () => {
  userId = `${PREFIX}user`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'F-150 fixture', $2, true, now(), now())`,
    [userId, `${PREFIX}user@f150.dbtest`],
  );
});

afterAll(async () => {
  try {
    await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  } finally {
    await pgPool.end();
  }
});

describe("F-150: the real auth instance stores no provider token (DB-backed)", () => {
  it("creating a provider account stores none of its tokens and keeps the rest", async () => {
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createAccount({
      userId,
      providerId: "github",
      accountId: `${PREFIX}gh`,
      accessToken: "gho_live_token",
      refreshToken: "ghr_live_refresh",
      idToken: "header.claims.signature",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: "read:user,user:email",
    });

    expect(await readAccount(created.id)).toEqual({
      providerId: "github",
      accountId: `${PREFIX}gh`,
      scope: "read:user,user:email",
      password: null,
      ...NO_TOKENS,
    });
  });

  it("a token refresh clears every token an older build stored, even one it does not carry", async () => {
    const id = `${PREFIX}legacy`;
    // The row as the pre-F-150 build left it.
    await pgPool.query(
      `insert into "account" (id, "accountId", "providerId", "userId", "accessToken",
         "refreshToken", "idToken", "accessTokenExpiresAt", "createdAt", "updatedAt")
       values ($1, $2, 'microsoft', $3, 'eyJ.old.access', 'old-refresh', 'eyJ.old.id',
         now() + interval '1 hour', now(), now())`,
      [id, `${PREFIX}ms`, userId],
    );

    // What a sign-in without offline_access writes: no refresh token.
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateAccount(id, {
      providerId: "microsoft",
      accessToken: "eyJ.new.access",
      idToken: "eyJ.new.id",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(await readAccount(id)).toMatchObject(NO_TOKENS);
  });

  it("a credential account keeps its password, and a password change leaves the token columns alone", async () => {
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: "hash-1",
    });
    expect(await readAccount(created.id)).toMatchObject({ password: "hash-1", ...NO_TOKENS });

    await ctx.internalAdapter.updateAccount(created.id, { password: "hash-2" });
    expect(await readAccount(created.id)).toMatchObject({ password: "hash-2", ...NO_TOKENS });
  });
});
