import { describe, expect, it } from "vitest";
import { clampSsoHandoffTtl, signSsoHandoff, verifySsoHandoff } from "@/lib/jwt-handoff.server";

/**
 * Branch coverage for `jwt-handoff.server.ts` (§29.4.5) — exercises the
 * "missing env" guard branches that the happy-path tests in
 * `tests/security/jwt-handoff.test.ts` and `jwt-handoff-jti.test.ts`
 * intentionally do not hit.
 */
describe("jwt-handoff.server env guards", () => {
  const baseInput = {
    betterAuthUserId: "ba-1",
    audience: "devresponse-app:portal",
    jti: "11111111-1111-1111-1111-111111111111",
    ttlSeconds: 30,
    claims: {
      email: "u@x.com",
      organizationId: "o-1",
      appUserId: "u-1",
      targetApplicationId: "portal",
      locale: "en",
      roles: [],
    },
  };

  it("throws on sign when SSO_HANDOFF_JWT_SECRET is missing", async () => {
    const original = process.env.SSO_HANDOFF_JWT_SECRET;
    delete process.env.SSO_HANDOFF_JWT_SECRET;
    try {
      await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_JWT_SECRET/);
    } finally {
      process.env.SSO_HANDOFF_JWT_SECRET = original;
    }
  });

  it("throws on sign when SSO_HANDOFF_ISSUER is missing", async () => {
    const original = process.env.SSO_HANDOFF_ISSUER;
    delete process.env.SSO_HANDOFF_ISSUER;
    try {
      await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_ISSUER/);
    } finally {
      process.env.SSO_HANDOFF_ISSUER = original;
    }
  });

  it("throws on verify when SSO_HANDOFF_JWT_SECRET is missing", async () => {
    const original = process.env.SSO_HANDOFF_JWT_SECRET;
    delete process.env.SSO_HANDOFF_JWT_SECRET;
    try {
      await expect(verifySsoHandoff({ token: "x", expectedAudience: "y" })).rejects.toThrow(
        /SSO_HANDOFF_JWT_SECRET/,
      );
    } finally {
      process.env.SSO_HANDOFF_JWT_SECRET = original;
    }
  });

  it("throws on verify when SSO_HANDOFF_ISSUER is missing", async () => {
    const original = process.env.SSO_HANDOFF_ISSUER;
    delete process.env.SSO_HANDOFF_ISSUER;
    try {
      await expect(verifySsoHandoff({ token: "x", expectedAudience: "y" })).rejects.toThrow(
        /SSO_HANDOFF_ISSUER/,
      );
    } finally {
      process.env.SSO_HANDOFF_ISSUER = original;
    }
  });

  it("rejects tokens missing jti/sub claims", async () => {
    // Sign a token without using setJti to simulate a malformed input.
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ foo: "bar" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
      .setAudience("devresponse-app:portal")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(new TextEncoder().encode(process.env.SSO_HANDOFF_JWT_SECRET!));

    await expect(
      verifySsoHandoff({ token, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow(/missing required jti\/sub/);
  });

  it("re-exports the clamp helper used by SSO callers", () => {
    expect(clampSsoHandoffTtl(120)).toBe(60);
  });
});
