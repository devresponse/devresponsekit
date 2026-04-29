import { describe, expect, it, beforeAll } from "vitest";
import { signSsoHandoff, verifySsoHandoff } from "@/lib/jwt-handoff.server";

/**
 * §29.7.5 — one-time `jti` contract. The signer embeds whatever `jti` the
 * caller supplies, and the verifier must surface it so the receiving
 * application can atomically check-and-consume it. These tests pin both
 * halves of the contract.
 *
 * Note: nonce *persistence* is the responsibility of `sso.server.ts`
 * which calls into the database; that integration is exercised by the
 * route-integration tests. Here we only assert the JWT-layer contract.
 */
describe("SSO handoff JWT one-time jti contract", () => {
  beforeAll(() => {
    process.env.SSO_HANDOFF_JWT_SECRET = "unit-test-secret-unit-test-secret";
    process.env.SSO_HANDOFF_ISSUER = "https://issuer.test";
  });

  const claims = {
    email: "user@example.com",
    organizationId: "org-1",
    appUserId: "app-user-1",
    targetApplicationId: "portal",
    locale: "en",
    roles: ["member"],
  };

  it("round-trips the supplied jti so the consumer can mark it consumed", async () => {
    const jti = "11111111-1111-1111-1111-111111111111";
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-1",
      audience: "devresponse-app:portal",
      jti,
      ttlSeconds: 30,
      claims,
    });
    const verified = await verifySsoHandoff({
      token,
      expectedAudience: "devresponse-app:portal",
    });
    expect(verified.payload.jti).toBe(jti);
  });

  it("issues distinct jtis for distinct tokens (precondition for one-time use)", async () => {
    const a = await signSsoHandoff({
      betterAuthUserId: "ba-1",
      audience: "devresponse-app:portal",
      jti: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ttlSeconds: 30,
      claims,
    });
    const b = await signSsoHandoff({
      betterAuthUserId: "ba-1",
      audience: "devresponse-app:portal",
      jti: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ttlSeconds: 30,
      claims,
    });
    const va = await verifySsoHandoff({ token: a, expectedAudience: "devresponse-app:portal" });
    const vb = await verifySsoHandoff({ token: b, expectedAudience: "devresponse-app:portal" });
    expect(va.payload.jti).not.toBe(vb.payload.jti);
  });

  it("verifies that the token honours the spec's 60s upper bound (defence in depth)", async () => {
    const token = await signSsoHandoff({
      betterAuthUserId: "ba-1",
      audience: "devresponse-app:portal",
      jti: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      ttlSeconds: 60,
      claims,
    });
    const verified = await verifySsoHandoff({
      token,
      expectedAudience: "devresponse-app:portal",
    });
    expect(verified.payload.exp - verified.payload.iat).toBeLessThanOrEqual(60);
  });
});
