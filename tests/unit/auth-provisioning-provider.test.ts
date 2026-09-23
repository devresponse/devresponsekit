import { describe, expect, it } from "vitest";
import { getProvisioningProvider } from "@/lib/auth-provisioning-provider";

/**
 * The provider sign-up provisioning places and activates by. These use the
 * context shape Better Auth ACTUALLY passes — `path` is the route PATTERN
 * (`/callback/:id`) with the provider in `params.id` — which the behavioural
 * suite (tests/security/oauth-provisioning-provider.test.ts) pins against a
 * real OAuth callback.
 */
describe("getProvisioningProvider", () => {
  it.each(["google", "microsoft", "github"])(
    "an OAuth callback (%s) is read from the route params",
    (provider) => {
      expect(
        getProvisioningProvider({
          path: "/callback/:id",
          params: { id: provider },
          request: { url: `http://localhost:3000/api/auth/callback/${provider}?code=x` },
        }),
      ).toBe(provider);
    },
  );

  it("an OAuth callback is still recognised from the request URL when params are absent", () => {
    expect(
      getProvisioningProvider({
        path: "/callback/:id",
        request: { url: "http://localhost:3000/api/auth/callback/github?code=x&state=y" },
      }),
    ).toBe("github");
  });

  it("an ID-token social sign-in is read from the body provider", () => {
    expect(
      getProvisioningProvider({
        path: "/sign-in/social",
        body: { provider: "google", idToken: { token: "t" } },
      }),
    ).toBe("google");
  });

  it("email/password sign-up and sign-in are email", () => {
    expect(getProvisioningProvider({ path: "/sign-up/email" })).toBe("email");
    expect(getProvisioningProvider({ path: "/sign-in/email" })).toBe("email");
  });

  it("never accepts an unknown or forged provider id", () => {
    expect(getProvisioningProvider({ path: "/callback/:id", params: { id: "okta" } })).toBe(
      "email",
    );
    expect(getProvisioningProvider({ path: "/callback/:id", params: { id: "email" } })).toBe(
      "email",
    );
    expect(
      getProvisioningProvider({ path: "/sign-in/social", body: { provider: "../google" } }),
    ).toBe("email");
  });

  it("reads only the URL PATH, never the query string", () => {
    expect(
      getProvisioningProvider({
        path: "/sign-in/email",
        request: { url: "http://localhost:3000/api/auth/sign-in/email?next=/callback/google" },
      }),
    ).toBe("email");
  });

  it("tolerates a missing context", () => {
    expect(getProvisioningProvider(undefined)).toBe("email");
    expect(getProvisioningProvider(null)).toBe("email");
    expect(getProvisioningProvider({})).toBe("email");
  });
});
