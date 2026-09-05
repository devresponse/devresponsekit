import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import {
  __resetSsoHandoffKeyCacheForTests,
  getSsoHandoffJwks,
  isSsoHandoffSelfIssuer,
  isSsoHandoffSignerConfigured,
  signSsoHandoff,
  verifySsoHandoff,
} from "@/lib/jwt-handoff.server";

/**
 * The CONSUMER side of review #5 — a satellite that holds NO signing key.
 * It verifies handoffs against the issuer's published JWKS
 * (`${SSO_HANDOFF_ISSUER}/api/sso/jwks.json`, fetched by jose's
 * `createRemoteJWKSet`) and can therefore forge nothing for itself or any
 * sibling. `fetch` is stubbed to play the primary's JWKS endpoint.
 */
const ISSUER = "https://primary.test";
const JWKS_URL = "https://primary.test/api/sso/jwks.json";
const AUD = "devresponse-app:satellite";
const TOUCHED = ["SSO_HANDOFF_PRIVATE_KEY", "SSO_HANDOFF_ISSUER", "BETTER_AUTH_URL"] as const;
const snapshot: Record<string, string | undefined> = {};

let issuerKey: { privateKey: CryptoKey; publicJwk: JWK; kid: string };
let rogueKey: { privateKey: CryptoKey; publicJwk: JWK; kid: string };
let published: JWK[];
const fetchMock = vi.fn();

async function mintKey() {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  const { d: _d, ...pub } = jwk;
  void _d;
  return { privateKey, publicJwk: { ...pub, alg: "EdDSA", use: "sig", kid }, kid };
}

function mintToken(key: CryptoKey, kid: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: "user@example.com",
    targetApplicationId: "satellite",
    locale: "fr",
    iat: now,
    exp: now + 30,
    ...overrides,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject("ba-user-1")
    .setJti("remote-jti")
    .sign(key);
}

beforeAll(async () => {
  for (const k of TOUCHED) snapshot[k] = process.env[k];
  issuerKey = await mintKey();
  rogueKey = await mintKey();
});
beforeEach(() => {
  // A pure consumer: no private key, issuer is a DIFFERENT origin.
  delete process.env.SSO_HANDOFF_PRIVATE_KEY;
  process.env.SSO_HANDOFF_ISSUER = ISSUER;
  process.env.BETTER_AUTH_URL = "https://satellite.test";
  published = [issuerKey.publicJwk];
  fetchMock.mockReset().mockImplementation(async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== JWKS_URL) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ keys: published }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  __resetSsoHandoffKeyCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const k of TOUCHED) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  __resetSsoHandoffKeyCacheForTests();
});

describe("jwt handoff — consumer verifies against the issuer's remote JWKS (review #5)", () => {
  it("holds no signing capability: not configured, not a self-issuer, cannot sign, publishes an empty JWKS", async () => {
    expect(isSsoHandoffSignerConfigured()).toBe(false);
    expect(isSsoHandoffSelfIssuer()).toBe(false);
    await expect(
      signSsoHandoff({
        betterAuthUserId: "ba-1",
        audience: AUD,
        jti: "j",
        ttlSeconds: 30,
        claims: { email: "e", targetApplicationId: "satellite", locale: "en" },
      }),
    ).rejects.toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
    expect(await getSsoHandoffJwks()).toEqual({ keys: [] });
  });

  it("verifies a token the issuer signed, fetching exactly the issuer's /api/sso/jwks.json", async () => {
    const token = await mintToken(issuerKey.privateKey, issuerKey.kid);
    const verified = await verifySsoHandoff({ token, expectedAudience: AUD });
    expect(verified.payload.sub).toBe("ba-user-1");
    expect(verified.payload.locale).toBe("fr");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledWith] = fetchMock.mock.calls[0] as [URL | RequestInfo];
    const calledUrl =
      typeof calledWith === "string"
        ? calledWith
        : calledWith instanceof URL
          ? calledWith.href
          : calledWith.url;
    expect(calledUrl).toBe(JWKS_URL);
  });

  it("caches the key set: a second verification does not refetch", async () => {
    await verifySsoHandoff({
      token: await mintToken(issuerKey.privateKey, issuerKey.kid),
      expectedAudience: AUD,
    });
    await verifySsoHandoff({
      token: await mintToken(issuerKey.privateKey, issuerKey.kid),
      expectedAudience: AUD,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a token signed by a key the issuer never published (a rogue sibling)", async () => {
    const forged = await mintToken(rogueKey.privateKey, rogueKey.kid);
    await expect(verifySsoHandoff({ token: forged, expectedAudience: AUD })).rejects.toThrow();
    // …and one that claims the issuer's kid but carries a rogue signature.
    const spoofed = await mintToken(rogueKey.privateKey, issuerKey.kid);
    await expect(verifySsoHandoff({ token: spoofed, expectedAudience: AUD })).rejects.toThrow(
      /signature/i,
    );
  });

  it("rejects an HS256 token outright — there is no shared secret to verify it with", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      email: "user@example.com",
      targetApplicationId: "satellite",
      locale: "en",
      iat: now,
      exp: now + 30,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject("ba-user-1")
      .setJti("hs")
      .sign(new TextEncoder().encode("whatever-the-old-fleet-secret-was-xxxxx"));
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow();
  });

  it("picks up a rotated key from the refreshed JWKS", async () => {
    // Warm the cache with the old key set…
    await verifySsoHandoff({
      token: await mintToken(issuerKey.privateKey, issuerKey.kid),
      expectedAudience: AUD,
    });
    // …then the primary rotates: publishes new + previous.
    const next = await mintKey();
    published = [next.publicJwk, issuerKey.publicJwk];
    const fresh = await mintToken(next.privateKey, next.kid);
    // An unknown kid makes jose refetch the document — after its 30s refetch
    // cooldown, which a unit test cannot wait out; drop the cached set to
    // stand in for that elapsed window (the primary keeps the PREVIOUS key
    // published for exactly this reason). The refreshed document is then
    // consulted and the new kid verifies.
    __resetSsoHandoffKeyCacheForTests();
    const verified = await verifySsoHandoff({ token: fresh, expectedAudience: AUD });
    expect(verified.payload.jti).toBe("remote-jti");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed with a clear error when the issuer is not a URL (nowhere to fetch keys from)", async () => {
    process.env.SSO_HANDOFF_ISSUER = "devresponse";
    __resetSsoHandoffKeyCacheForTests();
    await expect(verifySsoHandoff({ token: "x.y.z", expectedAudience: AUD })).rejects.toThrow(
      /SSO_HANDOFF_ISSUER must be the issuer's origin URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
