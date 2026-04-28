import { describe, expect, it } from "vitest";
import { resolveProviderOrganization } from "@/lib/provider-organization-resolver";

describe("resolveProviderOrganization", () => {
  it("uses the Microsoft tid claim when available", () => {
    const result = resolveProviderOrganization({
      provider: "microsoft",
      email: "user@contoso.com",
      emailVerified: true,
      profile: { tid: "11111111-1111-1111-1111-111111111111" },
    });
    expect(result.providerOrganizationKey).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.confidence).toBe("high");
  });

  it("uses the Google hd claim when available", () => {
    const result = resolveProviderOrganization({
      provider: "google",
      email: "user@example.com",
      emailVerified: true,
      profile: { hd: "EXAMPLE.com" },
    });
    expect(result.providerOrganizationKey).toBe("example.com");
    expect(result.confidence).toBe("high");
  });

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
