import { describe, expect, it } from "vitest";
import {
  makeApplicationsMenuResponse,
  makeEnterpriseApplicationMenuItem,
  makeNavigationMenuItem,
} from "../helpers/test-data-factories";

/**
 * §29.7.7 — navigation API responses must NEVER include tokens. The
 * domain types used by the API/UI boundary intentionally have no token
 * fields; this test pins that contract so a future refactor cannot
 * silently start emitting tokens to the browser.
 */
describe("no tokens in navigation API responses", () => {
  const FORBIDDEN_KEYS = [
    "token",
    "accessToken",
    "refreshToken",
    "idToken",
    "sessionToken",
    "bearer",
    "secret",
    "apiKey",
    "authorization",
  ];

  function assertNoForbiddenKeys(label: string, value: unknown) {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const lower = key.toLowerCase();
        for (const forbidden of FORBIDDEN_KEYS) {
          expect(
            lower.includes(forbidden.toLowerCase()),
            `${label} contained forbidden key "${key}"`,
          ).toBe(false);
        }
      }
    }
  }

  it("EnterpriseApplicationMenuItem only carries SSO launch URL pointers, never tokens", () => {
    const item = makeEnterpriseApplicationMenuItem();
    assertNoForbiddenKeys("EnterpriseApplicationMenuItem", item);
    // ssoLaunchUrl points at /api/sso/launch which performs the JWT
    // signing server-side — the URL itself must not embed a token.
    expect(item.ssoLaunchUrl).not.toMatch(/[?&](token|jwt|access_token|id_token)=/);
  });

  it("NavigationMenuItem has no token-bearing fields", () => {
    const item = makeNavigationMenuItem();
    assertNoForbiddenKeys("NavigationMenuItem", item);
  });

  it("Menu envelopes only carry presentational metadata", () => {
    const envelope = makeApplicationsMenuResponse();
    assertNoForbiddenKeys("envelope", envelope);
    for (const item of envelope.items) {
      assertNoForbiddenKeys("envelope.item", item);
    }
  });
});
