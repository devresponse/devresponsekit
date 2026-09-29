import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { microsoft } from "better-auth/social-providers";
import { discardProviderTokens, MICROSOFT_IDENTITY_ONLY } from "@/lib/auth-provider-tokens";

/**
 * F-150 — social sign-in stores no provider token.
 *
 * BEHAVIOURAL, against Better Auth itself:
 *
 *   1. A real `sign-in/social` → `callback/github` round trip through
 *      `auth.handler` (only GitHub's token endpoint and profile are stubbed),
 *      with `discardProviderTokens` as the account hooks: the first sign-in
 *      creates the account row with no access, refresh or ID token, and a
 *      later sign-in (Better Auth's token refresh, `updateAccountOnSignIn`)
 *      stores none either and clears a token an older build left behind.
 *   2. The Microsoft options: the authorization URL asks for
 *      `openid profile email` only (Better Auth's default adds
 *      `offline_access`, which yields a refresh token, and `User.Read`), and
 *      the provider no longer calls Microsoft Graph for a profile photo.
 *   3. Source pins that `src/lib/auth.ts` wires both into the real instance.
 *      tests/db/provider-tokens.db.test.ts drives the real instance's account
 *      writes against Postgres.
 */

const BASE = "http://localhost:3000";

type StoredAccount = Record<string, unknown>;

function makeAuth(store: { account: StoredAccount[] } & Record<string, unknown[]>) {
  return betterAuth({
    database: memoryAdapter(store),
    secret: "provider-token-storage-test-secret-00000",
    baseURL: BASE,
    socialProviders: {
      github: {
        clientId: "client-id",
        clientSecret: "client-secret",
        getUserInfo: async () => ({
          user: { name: "Octo", email: "octo@example.com", emailVerified: true },
          data: { id: 42, login: "octo" } as never,
        }),
      },
    },
    databaseHooks: { account: discardProviderTokens },
  });
}

/** Runs one GitHub sign-in to completion; returns the callback response. */
async function signInWithGithub(auth: ReturnType<typeof makeAuth>): Promise<Response> {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    }),
  );
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return auth.handler(
    new Request(`${BASE}/api/auth/callback/github?code=test-code&state=${state}`, {
      headers: { cookie },
    }),
  );
}

/** Token fields as stored; `undefined` and `null` both mean "not stored". */
function tokensOf(row: StoredAccount) {
  return {
    accessToken: row.accessToken ?? null,
    refreshToken: row.refreshToken ?? null,
    idToken: row.idToken ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt ?? null,
  };
}

const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("F-150: a social sign-in stores no provider token", () => {
  it("neither the first sign-in (create) nor a later one (refresh) stores the tokens GitHub issued", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "gho_live_token",
            refresh_token: "ghr_live_refresh",
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
            token_type: "bearer",
            scope: "read:user,user:email",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    });

    const store = { user: [], session: [], account: [] as StoredAccount[], verification: [] };
    const auth = makeAuth(store);

    const first = await signInWithGithub(auth);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).not.toContain("error");
    expect(store.account).toHaveLength(1);
    const account = store.account[0]!;
    expect(account).toMatchObject({ providerId: "github", accountId: "42" });
    expect(tokensOf(account)).toEqual(NO_TOKENS);

    // A row an older build wrote: tokens at rest.
    Object.assign(account, {
      accessToken: "gho_stale",
      refreshToken: "ghr_stale",
      idToken: "stale.id.token",
    });

    const second = await signInWithGithub(auth);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).not.toContain("error");
    expect(store.account).toHaveLength(1);
    expect(tokensOf(store.account[0]!)).toEqual(NO_TOKENS);
  });

  it("an account write that carries no token (a password change) is left untouched", async () => {
    const before = discardProviderTokens.update?.before;
    expect(before).toBeDefined();
    await expect(before!({ password: "new-hash" }, null)).resolves.toBeUndefined();
    await expect(before!({ accessToken: "x" }, null)).resolves.toEqual({ data: NO_TOKENS });
  });
});

describe("F-150: Microsoft asks for identity only", () => {
  const redirectURI = `${BASE}/api/auth/callback/microsoft`;
  const base = { clientId: "client-id", clientSecret: "client-secret", tenantId: "organizations" };

  async function scopesFor(options: Parameters<typeof microsoft>[0]): Promise<string[]> {
    const url = await microsoft(options).createAuthorizationURL({
      state: "state",
      codeVerifier: "v".repeat(43),
      redirectURI,
    });
    return (url.searchParams.get("scope") ?? "").split(" ");
  }

  it("requests openid profile email: no offline_access (refresh token), no User.Read (Graph)", async () => {
    expect(await scopesFor({ ...base, ...MICROSOFT_IDENTITY_ONLY })).toEqual([
      "openid",
      "profile",
      "email",
    ]);
    // What the options switch off: Better Auth's defaults.
    expect(await scopesFor(base)).toEqual(expect.arrayContaining(["offline_access", "User.Read"]));
  });

  it("reads the profile from the ID token without calling Microsoft Graph", async () => {
    const graphCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      graphCalls.push(url);
      return new Response(null, { status: 404 });
    });
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      oid: "00000000-0000-4000-8000-000000000001",
      tid: "11111111-1111-4111-8111-111111111111",
      email: "person@contoso.example",
      email_verified: true,
      name: "Person",
    })}.`;

    const info = await microsoft({ ...base, ...MICROSOFT_IDENTITY_ONLY }).getUserInfo({
      idToken,
      accessToken: "entra-access-token",
    } as never);
    expect(info?.user).toMatchObject({ email: "person@contoso.example", name: "Person" });
    expect(graphCalls).toEqual([]);

    // Without the option the provider spends the access token on Graph.
    await microsoft(base).getUserInfo({ idToken, accessToken: "entra-access-token" } as never);
    expect(graphCalls.some((url) => url.startsWith("https://graph.microsoft.com/"))).toBe(true);
  });
});

describe("F-150: src/lib/auth.ts wires both into the real instance", () => {
  const authSource = readFileSync(path.resolve(__dirname, "../../src/lib/auth.ts"), "utf8");

  it("installs the account hooks", () => {
    expect(authSource).toMatch(/databaseHooks:\s*\{[\s\S]*\baccount:\s*discardProviderTokens\b/);
  });

  it("spreads the identity-only options into the Microsoft provider", () => {
    expect(authSource).toMatch(
      /socialProviders\.microsoft = \{[^}]*\.\.\.MICROSOFT_IDENTITY_ONLY,[^}]*\};/,
    );
  });

  it("does not opt back into storing tokens encrypted or in a cookie", () => {
    expect(authSource).not.toMatch(/encryptOAuthTokens|storeAccountCookie/);
  });
});
