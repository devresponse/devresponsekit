import { describe, expect, it } from "vitest";
import { resolveProviderOrganization } from "@/lib/provider-organization-resolver";

/**
 * Extra coverage for branches not exercised by
 * `provider-organization-resolver.test.ts` — the email-domain fallbacks the
 * GitHub branch depends on. (The Microsoft/Google tenant-claim branches this
 * file used to cover were removed as dead code — review #38; their
 * replacement assertions live in the sibling file.)
 */
describe("resolveProviderOrganization (extended)", () => {
  it("lowercases the GitHub email domain", () => {
    const result = resolveProviderOrganization({
      provider: "github",
      email: "User@Example.COM",
      emailVerified: true,
    });
    expect(result.providerOrganizationKey).toBe("example.com");
    expect(result.displayName).toBe("example.com");
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

  it("keeps the fallback display name and provider echo on the default path", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: false,
    });
    expect(result).toEqual({
      provider: "google",
      providerOrganizationKey: "default",
      displayName: "Default Organization",
      confidence: "fallback",
    });
  });
});
