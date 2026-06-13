import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair } from "jose";

/**
 * Round-trip coverage for the JWT access-token issuer + JWKS publisher.
 * Generates an ephemeral Ed25519 keypair and wires it through env so the
 * module under test signs and verifies with a real key.
 */
describe("api jwt issuer", () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(privateKey);
    process.env.API_JWT_ENABLED = "1";
    process.env.API_JWT_PRIVATE_KEY = JSON.stringify(jwk);
    process.env.API_JWT_ISSUER = "https://test.devresponse.local";
    process.env.API_JWT_AUDIENCE = "devresponse-api";
  });

  it("mints and verifies an access token round-trip", async () => {
    const { mintAccessToken, verifyAccessToken, __resetJwtKeyCacheForTests } =
      await import("@/lib/api-auth/jwt.server");
    __resetJwtKeyCacheForTests();

    const minted = await mintAccessToken({
      subject: "ba-user-1",
      scopes: ["admin.users.read", "account.read"],
      organizationId: "org-1",
      jti: "jti-1",
    });
    expect(minted.expiresInSeconds).toBeGreaterThan(0);

    const verified = await verifyAccessToken(minted.token);
    expect(verified.subject).toBe("ba-user-1");
    expect(verified.scopes).toContain("admin.users.read");
    expect(verified.organizationId).toBe("org-1");
    expect(verified.jti).toBe("jti-1");
    expect(verified.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("publishes a public JWKS without private material", async () => {
    const { getJwks, __resetJwtKeyCacheForTests } = await import("@/lib/api-auth/jwt.server");
    __resetJwtKeyCacheForTests();
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key?.kid).toBeTruthy();
    expect(key?.use).toBe("sig");
    // The secret scalar `d` must never appear in the published key.
    expect((key as Record<string, unknown>).d).toBeUndefined();
  });

  it("rejects a tampered token", async () => {
    const { mintAccessToken, verifyAccessToken, __resetJwtKeyCacheForTests } =
      await import("@/lib/api-auth/jwt.server");
    __resetJwtKeyCacheForTests();
    const { token } = await mintAccessToken({ subject: "x", scopes: [], jti: "j2" });
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    await expect(verifyAccessToken(tampered)).rejects.toBeDefined();
  });
});
