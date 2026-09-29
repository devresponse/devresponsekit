import { describe, expect, it } from "vitest";
import { resolveProviderOrganization } from "@/lib/provider-organization-resolver";

/**
 * Extra coverage for the shapes of address the GitHub branch used to key an
 * organization by (F-52: it keys none now). (The Microsoft/Google
 * tenant-claim branches this file used to cover were removed as dead code —
 * review #38; their replacement assertions live in the sibling file.)
 */
describe("resolveProviderOrganization (extended)", () => {
  it.each(["User@Example.COM", "no-at-sign"])(
    "keys no organization by a verified GitHub address's domain (%s)",
    (email) => {
      const result = resolveProviderOrganization({
        provider: "github",
        email,
        emailVerified: true,
      });
      // Not `example.com` (a slug provisioning used to create), not `unknown`.
      expect(result.providerOrganizationKey).toBe("default");
    },
  );

  it("keeps the fallback label and provider echo on the default path", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: false,
    });
    expect(result).toEqual({
      provider: "google",
      providerOrganizationKey: "default",
      confidence: "fallback",
      routesByEmailDomain: false,
    });
  });
});
