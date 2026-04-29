import { describe, expect, it } from "vitest";
import { resolveProviderOrganization } from "@/lib/provider-organization-resolver";

/**
 * Extra coverage for branches not exercised by
 * `provider-organization-resolver.test.ts` — falls through to default,
 * Microsoft account-level tenant claims, and trimming behaviour.
 */
describe("resolveProviderOrganization (extended)", () => {
  it("uses the Microsoft account.tenantId fallback when profile.tid is absent", () => {
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
      account: { tenantId: "abc-tenant" },
    });
    expect(result.providerOrganizationKey).toBe("abc-tenant");
    expect(result.confidence).toBe("high");
  });

  it("uses the Microsoft account.tid fallback when neither profile.tid nor account.tenantId is present", () => {
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
      account: { tid: "tid-from-account" },
    });
    expect(result.providerOrganizationKey).toBe("tid-from-account");
  });

  it("falls back to default when Microsoft has no tenant claim", () => {
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("default");
    expect(result.confidence).toBe("fallback");
  });

  it("trims and lowercases the Google hosted domain", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: true,
      profile: { hd: "  Example.COM  " },
    });
    expect(result.providerOrganizationKey).toBe("example.com");
  });

  it("falls back to default when Google profile has an empty hd string", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: true,
      profile: { hd: "   " },
    });
    expect(result.providerOrganizationKey).toBe("default");
  });

  it("uses 'unknown' for emails without an @ when falling back", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "no-at-sign",
      emailVerified: true,
    });
    // emailDomain falls through to 'unknown' when the @ split fails.
    expect(result.providerOrganizationKey).toBe("unknown");
  });
});
