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

  it("carries the source credential as `cid` and reads it back (review #43)", async () => {
    const { mintAccessToken, verifyAccessToken, __resetJwtKeyCacheForTests } =
      await import("@/lib/api-auth/jwt.server");
    __resetJwtKeyCacheForTests();
    const minted = await mintAccessToken({
      subject: "ba-user-1",
      scopes: ["account.read"],
      jti: "jti-cid",
      credential: { kind: "oauth_client", id: "client-42" },
    });
    const verified = await verifyAccessToken(minted.token);
    expect(verified.credential).toEqual({ kind: "oauth_client", id: "client-42" });
    expect(verified.issuedAt.getTime()).toBeLessThanOrEqual(Date.now());
    // A token minted without one (legacy / test) reads back as null.
    const legacy = await mintAccessToken({ subject: "x", scopes: [], jti: "jti-legacy" });
    expect((await verifyAccessToken(legacy.token)).credential).toBeNull();
  });

  it("defaults `aud` to API_JWT_AUDIENCE and verifies against it (existing clients unchanged)", async () => {
    const { mintAccessToken, verifyAccessToken, __resetJwtKeyCacheForTests } =
      await import("@/lib/api-auth/jwt.server");
    __resetJwtKeyCacheForTests();
    const minted = await mintAccessToken({ subject: "x", scopes: [], jti: "jti-aud" });
    expect(minted.audience).toBe("devresponse-api");
    expect((await verifyAccessToken(minted.token)).audience).toEqual(["devresponse-api"]);
  });

  it("mints a per-resource audience and refuses it where another audience is expected (review #50/#53)", async () => {
    const { mintAccessToken, verifyAccessToken, AccessTokenAudienceError } =
      await import("@/lib/api-auth/jwt.server");
    const MCP = "https://test.devresponse.local/api/mcp";
    const minted = await mintAccessToken({
      subject: "x",
      scopes: ["account.read"],
      jti: "jti-mcp",
      audience: MCP,
    });
    expect(minted.audience).toBe(MCP);
    // Accepted where the MCP audience is expected (alone, or in a grace list)…
    expect((await verifyAccessToken(minted.token, { expectedAudience: MCP })).audience).toEqual([
      MCP,
    ]);
    await expect(
      verifyAccessToken(minted.token, { expectedAudience: [MCP, "devresponse-api"] }),
    ).resolves.toMatchObject({ jti: "jti-mcp" });
    // …refused with the TYPED error where only the v1 audience is expected
    // (the default), so the resource server can say which resource to request.
    const failure = await verifyAccessToken(minted.token).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AccessTokenAudienceError);
    expect(failure).toMatchObject({ expected: ["devresponse-api"], actual: [MCP] });
    // And the reverse: a v1 token is not accepted by an MCP-only verifier.
    const v1 = await mintAccessToken({ subject: "x", scopes: [], jti: "jti-v1" });
    await expect(verifyAccessToken(v1.token, { expectedAudience: MCP })).rejects.toBeInstanceOf(
      AccessTokenAudienceError,
    );
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
