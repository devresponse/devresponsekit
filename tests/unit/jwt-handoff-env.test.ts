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

  it("rejects tokens with an invalid or incomplete claim set (P3-11)", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.SSO_HANDOFF_JWT_SECRET!);
    const base = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
        .setAudience("devresponse-app:portal")
        .setIssuedAt()
        .setExpirationTime("60s");

    // Missing jti/sub (and every custom claim).
    const noJtiSub = await base().sign(secret);
    await expect(
      verifySsoHandoff({ token: noJtiSub, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow(/invalid or incomplete claim set/);

    // Has jti/sub but omits a required custom claim (email) — the full-claim
    // boundary validation rejects it rather than `as`-casting a partial payload
    // into session establishment.
    const missingEmail = await new SignJWT({
      organizationId: "o1",
      appUserId: "u1",
      targetApplicationId: "portal",
      locale: "en",
      roles: [],
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
      .setAudience("devresponse-app:portal")
      .setSubject("ba-1")
      .setJti("j1")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(secret);
    await expect(
      verifySsoHandoff({ token: missingEmail, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow(/invalid or incomplete claim set/);
  });

  it("re-exports the clamp helper used by SSO callers", () => {
    expect(clampSsoHandoffTtl(120)).toBe(60);
  });
});
