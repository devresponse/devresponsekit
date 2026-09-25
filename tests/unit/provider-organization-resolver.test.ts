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

  it("uses GitHub email domain when verified", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "user@example.com",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("example.com");
    expect(result.confidence).toBe("medium");
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
 * F-40: whether a sign-up belongs in THE default org is an explicit flag, so
 * callers resolve that org by `is_default` instead of reading the `default`
 * key as a slug (which broke the moment the default org was renamed).
 */
describe("resolveProviderOrganization — the default-org fallback is a flag, not a slug (F-40)", () => {
  it.each([
    ["email", false],
    ["email", true],
    ["google", true],
    ["microsoft", true],
    ["github", false],
  ] as const)("flags a %s sign-up (verified: %s) for the default org", (provider, verified) => {
    const result = resolveProviderOrganization({
      provider,
      email: "user@example.com",
      emailVerified: verified,
    });
    expect(result.routesToDefaultOrganization).toBe(true);
  });

  it("does not flag a verified GitHub sign-up, which is keyed by its email domain", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "user@example.com",
      emailVerified: true,
    });
    expect(result.routesToDefaultOrganization).toBe(false);
    expect(result.providerOrganizationKey).toBe("example.com");
  });
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
