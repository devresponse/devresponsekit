import { describe, expect, it, beforeAll } from "vitest";
import { signSsoHandoff, verifySsoHandoff } from "@/lib/jwt-handoff.server";

describe("jwt handoff", () => {
  beforeAll(() => {
    process.env.SSO_HANDOFF_JWT_SECRET = "unit-test-secret-unit-test-secret";
    process.env.SSO_HANDOFF_ISSUER = "https://issuer.test";
  });

  const baseClaims = {
    email: "user@example.com",
    organizationId: "org-1",
    appUserId: "app-user-1",
    targetApplicationId: "devresponse-portal",
    locale: "en",
    roles: ["member"],
  };

  it("round-trips a token with matching audience", async () => {
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-user-1",
      audience: "devresponse-app:portal",
      jti: "11111111-1111-1111-1111-111111111111",
      ttlSeconds: 30,
      claims: baseClaims,
    });

    const verified = await verifySsoHandoff({
      token,
      expectedAudience: "devresponse-app:portal",
    });

    expect(verified.payload.email).toBe(baseClaims.email);
    expect(verified.payload.targetApplicationId).toBe(baseClaims.targetApplicationId);
    expect(verified.payload.jti).toBe("11111111-1111-1111-1111-111111111111");
    expect(verified.payload.sub).toBe("ba-user-1");
  });

  it("rejects an audience mismatch", async () => {
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-user-1",
      audience: "devresponse-app:portal",
      jti: "22222222-2222-2222-2222-222222222222",
      ttlSeconds: 30,
      claims: baseClaims,
    });

    await expect(
      verifySsoHandoff({ token, expectedAudience: "devresponse-app:other" }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-user-1",
      audience: "devresponse-app:portal",
      jti: "33333333-3333-3333-3333-333333333333",
      ttlSeconds: 1,
      claims: baseClaims,
    });

    // Wait past the TTL.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await expect(
      verifySsoHandoff({ token, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow();
  });

  it("clamps the TTL at 60 seconds", async () => {
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-user-1",
      audience: "devresponse-app:portal",
      jti: "44444444-4444-4444-4444-444444444444",
      ttlSeconds: 6_000, // requested huge value
      claims: baseClaims,
    });

    const verified = await verifySsoHandoff({
      token,
      expectedAudience: "devresponse-app:portal",
    });

    const ttl = verified.payload.exp - verified.payload.iat;
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
