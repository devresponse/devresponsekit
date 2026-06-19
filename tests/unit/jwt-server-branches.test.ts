import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import type * as JwtModule from "@/lib/api-auth/jwt.server";

/**
 * Branch coverage for jwt.server — the error and fallback paths the
 * round-trip test in api-jwt.test.ts does not reach: a missing / malformed
 * signing key, the `API_JWT_KID` and issuer fallbacks, a TTL override, an
 * absent org, and verify-side rejection of a token missing required claims
 * or carrying a non-string scope. `getServerEnv` is mocked so each branch
 * gets an exact env; the crypto is real (a per-suite Ed25519 keypair).
 */
const envState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => envState.value }));

let privateJwk: JWK;
let jwkJson: string;
const ISSUER = "https://issuer.test.local";
const AUDIENCE = "devresponse-api";

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    API_JWT_PRIVATE_KEY: jwkJson,
    // Pin the kid so the published JWK's kid matches signRaw's `kid: "k"`
    // header (verifyAccessToken now selects the key by kid via a local JWK
    // Set for rotation support, P3-7).
    API_JWT_KID: "k",
    API_JWT_ISSUER: ISSUER,
    API_JWT_AUDIENCE: AUDIENCE,
    API_JWT_ACCESS_TTL_SECONDS: 900,
    BETTER_AUTH_URL: "https://app.test.local",
    ...overrides,
  };
}

/** Sign a token with the SAME private key + matching header so it passes
 * signature/issuer/audience verification — letting us exercise the
 * payload-shape branches of verifyAccessToken. */
async function signRaw(
  claims: Record<string, unknown>,
  opts: { setSub?: boolean; setJti?: boolean; setExp?: boolean; issuer?: string } = {},
): Promise<string> {
  const key = (await importJWK({ ...privateJwk, alg: "EdDSA" }, "EdDSA")) as CryptoKey;
  let s = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "k", typ: "JWT" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt();
  if (opts.setSub !== false) s = s.setSubject("ba-1");
  if (opts.setJti !== false) s = s.setJti("jti-1");
  if (opts.setExp !== false) s = s.setExpirationTime("900s");
  return s.sign(key);
}

let M: typeof JwtModule;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  privateJwk = await exportJWK(privateKey);
  jwkJson = JSON.stringify(privateJwk);
});

beforeEach(async () => {
  envState.value = baseEnv();
  M = await import("@/lib/api-auth/jwt.server");
  M.__resetJwtKeyCacheForTests();
});
afterEach(() => {
  vi.resetModules();
});

describe("getKeyMaterial — key configuration errors", () => {
  it("throws when API_JWT_PRIVATE_KEY is not configured", async () => {
    envState.value = baseEnv({ API_JWT_PRIVATE_KEY: "" });
    await expect(M.getJwks()).rejects.toThrow(/not configured/);
  });

  it("throws when API_JWT_PRIVATE_KEY is not valid JSON", async () => {
    envState.value = baseEnv({ API_JWT_PRIVATE_KEY: "{not json" });
    await expect(M.getJwks()).rejects.toThrow(/JSON-encoded Ed25519 JWK/);
  });

  it("uses an explicit API_JWT_KID when provided (instead of the thumbprint)", async () => {
    envState.value = baseEnv({ API_JWT_KID: "rotation-key-7" });
    const jwks = await M.getJwks();
    expect(jwks.keys[0]?.kid).toBe("rotation-key-7");
  });
});

describe("mintAccessToken — claim/fallback branches", () => {
  it("honors a TTL override", async () => {
    const minted = await M.mintAccessToken({
      subject: "ba-1",
      scopes: [],
      jti: "j",
      ttlSeconds: 42,
    });
    expect(minted.expiresInSeconds).toBe(42);
  });

  it("omits the org claim when no organizationId is given (verifies back to null)", async () => {
    const minted = await M.mintAccessToken({ subject: "ba-1", scopes: ["account.read"], jti: "j" });
    const verified = await M.verifyAccessToken(minted.token);
    expect(verified.organizationId).toBeNull();
  });

  it("falls back to BETTER_AUTH_URL as issuer when API_JWT_ISSUER is unset", async () => {
    envState.value = baseEnv({ API_JWT_ISSUER: undefined });
    M.__resetJwtKeyCacheForTests();
    const minted = await M.mintAccessToken({ subject: "ba-1", scopes: [], jti: "j" });
    // Verify (also issuer-unset) must accept it via the BETTER_AUTH_URL issuer.
    const verified = await M.verifyAccessToken(minted.token);
    expect(verified.subject).toBe("ba-1");
  });
});

describe("verifyAccessToken — payload-shape branches", () => {
  it("rejects a token missing the `sub` claim", async () => {
    const token = await signRaw({ scope: "account.read" }, { setSub: false });
    await expect(M.verifyAccessToken(token)).rejects.toThrow(/missing required claims/);
  });

  it("rejects a token missing the `jti` claim", async () => {
    const token = await signRaw({ scope: "account.read" }, { setJti: false });
    await expect(M.verifyAccessToken(token)).rejects.toThrow(/missing required claims/);
  });

  it("treats a non-string scope claim as no scopes", async () => {
    const token = await signRaw({ scope: 12345 });
    const verified = await M.verifyAccessToken(token);
    expect(verified.scopes).toEqual([]);
  });

  it("treats a non-string org claim as null", async () => {
    const token = await signRaw({ scope: "account.read", org: { not: "a string" } });
    const verified = await M.verifyAccessToken(token);
    expect(verified.organizationId).toBeNull();
  });
});

describe("verifyAccessToken — key rotation overlap (P3-7)", () => {
  it("verifies a pre-rotation token via the previous key, publishes both, then drops it", async () => {
    const a = JSON.stringify(
      await exportJWK((await generateKeyPair("EdDSA", { extractable: true })).privateKey),
    );
    const b = JSON.stringify(
      await exportJWK((await generateKeyPair("EdDSA", { extractable: true })).privateKey),
    );

    // Phase 1: A is the current signing key (thumbprint kid), no previous.
    envState.value = baseEnv({ API_JWT_PRIVATE_KEY: a, API_JWT_KID: undefined });
    M.__resetJwtKeyCacheForTests();
    const oldToken = (await M.mintAccessToken({ subject: "ba-rot", scopes: [], jti: "rot-1" }))
      .token;

    // Phase 2: rotate — B becomes current, A retained as the overlap key.
    envState.value = baseEnv({
      API_JWT_PRIVATE_KEY: b,
      API_JWT_KID: undefined,
      API_JWT_PREVIOUS_PRIVATE_KEY: a,
    });
    M.__resetJwtKeyCacheForTests();

    // The pre-rotation token (signed by A) still verifies during the overlap…
    expect((await M.verifyAccessToken(oldToken)).subject).toBe("ba-rot");
    // …and a freshly minted token (signed by B) verifies too.
    const newToken = (await M.mintAccessToken({ subject: "ba-rot", scopes: [], jti: "rot-2" }))
      .token;
    expect((await M.verifyAccessToken(newToken)).jti).toBe("rot-2");

    // JWKS publishes BOTH keys, with distinct kids and no private material.
    const jwks = await M.getJwks();
    expect(jwks.keys).toHaveLength(2);
    expect(new Set(jwks.keys.map((k) => k.kid)).size).toBe(2);
    expect(jwks.keys.every((k) => (k as Record<string, unknown>).d === undefined)).toBe(true);

    // Phase 3: overlap ends — previous removed, the old token no longer verifies.
    envState.value = baseEnv({ API_JWT_PRIVATE_KEY: b, API_JWT_KID: undefined });
    M.__resetJwtKeyCacheForTests();
    await expect(M.verifyAccessToken(oldToken)).rejects.toBeDefined();
  });
});
