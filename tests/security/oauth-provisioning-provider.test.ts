import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getProvisioningProvider } from "@/lib/auth-provisioning-provider";

/**
 * BEHAVIOURAL: what the provisioning hooks see during a REAL OAuth callback.
 *
 * Better Auth runs every endpoint — and the database hooks it triggers — with
 * `context.path` set to the endpoint's ROUTE PATTERN (`/callback/:id`), not the
 * request URL. The provider resolver used to match the concrete
 * `/callback/google` against that pattern, so every social sign-in was
 * provisioned as `email` while the unit tests, which fabricated a concrete
 * path, stayed green. This drives an actual `sign-in/social` →
 * `callback/github` round trip through `auth.handler` (only the provider's
 * token endpoint is stubbed) and runs the app's resolver on the context the
 * real session hook receives — so a vendor change to that shape fails here.
 */

const BASE = "http://localhost:3000";

function makeAuth(onSession: (provider: string, ctx: unknown) => void) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    secret: "oauth-provisioning-provider-test-secret-0000",
    baseURL: BASE,
    socialProviders: {
      github: {
        clientId: "client-id",
        clientSecret: "client-secret",
        getUserInfo: async () => ({
          user: { name: "Octo", email: "octo@example.com", emailVerified: true },
          // A partial GitHub profile: the account subject is read from `id`.
          data: { id: 42, login: "octo" } as never,
        }),
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (_session, ctx) => {
            onSession(getProvisioningProvider(ctx), ctx);
          },
        },
      },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("provisioning provider on a real OAuth callback", () => {
  it("resolves github — not email — from the context Better Auth really passes", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(
          JSON.stringify({ access_token: "gho_test", token_type: "bearer", scope: "read:user" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    });

    const seen: Array<{ provider: string; path: unknown }> = [];
    const auth = makeAuth((provider, ctx) =>
      seen.push({ provider, path: (ctx as { path?: unknown } | null)?.path }),
    );

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

    const callback = await auth.handler(
      new Request(`${BASE}/api/auth/callback/github?code=test-code&state=${state}`, {
        headers: { cookie },
      }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).not.toContain("error");
    // The shape that hid the bug: a route PATTERN, not the URL.
    expect(seen).toEqual([{ provider: "github", path: "/callback/:id" }]);
  });
});
