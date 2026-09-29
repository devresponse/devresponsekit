import { describe, expect, it } from "vitest";
import { resolveProviderOrganization } from "@/lib/provider-organization-resolver";

describe("resolveProviderOrganization", () => {
  it("falls back to default for GitHub when email is unverified", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "user@example.com",
      emailVerified: false,
    });
    expect(result.providerOrganizationKey).toBe("default");
    expect(result.confidence).toBe("fallback");
  });

  it("F-52: a verified GitHub address names no organization either", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "user@example.com",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("default");
    expect(result.confidence).toBe("fallback");
  });

  it("falls back to default for email/password sign-ups", () => {
    const result = resolveProviderOrganization({
      provider: "email",
      email: "user@example.com",
      emailVerified: false,
    });
    expect(result.providerOrganizationKey).toBe("default");
  });
});

/**
 * F-52: provider metadata never names an organization. A verified GitHub
 * address used to be keyed by its email domain, which provisioning looked up
 * as an org slug and created when missing. Now the only thing the provider
 * decides is whether the superadmin-curated email-domain binding may place
 * the sign-up; everything else lands in the default org (by `is_default`,
 * F-40 — the `default` key is a label, not a slug).
 */
describe("resolveProviderOrganization — only the curated email-domain binding may place a sign-up (F-52)", () => {
  it.each([
    ["email", false, true],
    ["email", true, true],
    ["github", true, true],
    ["github", false, false],
    ["google", true, false],
    ["microsoft", true, false],
  ] as const)(
    "a %s sign-up (verified: %s) meets the email-domain binding: %s",
    (provider, verified, routesByEmailDomain) => {
      const result = resolveProviderOrganization({
        provider,
        email: "user@example.com",
        emailVerified: verified,
      });
      expect(result).toEqual({
        provider,
        providerOrganizationKey: "default",
        confidence: "fallback",
        routesByEmailDomain,
      });
    },
  );
});

/**
 * Review #38 — the Microsoft `tid` / Google `hd` tenant-routing branches were
 * DEAD (no call site ever passed `profile` or `account`) and were removed
 * rather than switched on, because switching them on would have repointed
 * every existing Google/Entra sign-up out of `default` and let an opaque
 * tenant id create an organization. These tests pin the behaviour that has
 * always actually shipped, so a future "let's wire it up" is a deliberate,
 * documented decision instead of a silent one.
 */
describe("resolveProviderOrganization — no provider-tenant routing (review #38)", () => {
  it("routes a Microsoft sign-in to default", () => {
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("default");
    expect(result.confidence).toBe("fallback");
  });

  it("routes a Google sign-in to default", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("default");
    expect(result.confidence).toBe("fallback");
  });

  it("ignores any extra provider metadata handed in at runtime", () => {
    // The input type no longer declares `profile`/`account`; a caller that
    // smuggles them past the type system must still land in `default`.
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
      profile: { tid: "11111111-1111-1111-1111-111111111111" },
      account: { tenantId: "11111111-1111-1111-1111-111111111111" },
    } as unknown as Parameters<typeof resolveProviderOrganization>[0]);
    expect(result.providerOrganizationKey).toBe("default");
  });
});
