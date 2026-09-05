import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
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
 * Security contract of the SSO handoff codec after review #5 / #60 / #61:
 * EdDSA-signed by the issuer's private JWK, verified against the published
 * public key set (here the LOCAL set — this suite runs as a self-issuer:
 * `SSO_HANDOFF_ISSUER` equals `BETTER_AUTH_URL`), claims minimised, and the
 * 60-second ceiling enforced on the RECEIVER via `maxTokenAge`.
 */
const ISSUER = "https://issuer.test";
const AUD = "devresponse-app:portal";
const TOUCHED = [
  "SSO_HANDOFF_PRIVATE_KEY",
  "SSO_HANDOFF_KID",
  "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY",
  "SSO_HANDOFF_PREVIOUS_KID",
  "SSO_HANDOFF_ISSUER",
  "BETTER_AUTH_URL",
] as const;
const snapshot: Record<string, string | undefined> = {};

let keyA: { privateKey: CryptoKey; jwk: JWK; json: string; kid: string };
let keyB: { privateKey: CryptoKey; jwk: JWK; json: string; kid: string };

async function mintKey() {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { privateKey, jwk, json: JSON.stringify(jwk), kid: await calculateJwkThumbprint(jwk) };
}

const baseClaims = { email: "user@example.com", targetApplicationId: "portal", locale: "en" };

function sign(jti: string, ttlSeconds = 30, claims = baseClaims) {
  return signSsoHandoff({ betterAuthUserId: "ba-user-1", audience: AUD, jti, ttlSeconds, claims });
}

/** Hand-rolled token so a test can pick the header / registered claims. */
function raw(key: CryptoKey, header: Record<string, unknown>, payload: Record<string, unknown>) {
  return new SignJWT({ ...baseClaims, ...payload })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", ...header } as Parameters<
      SignJWT["setProtectedHeader"]
    >[0])
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject("ba-user-1")
    .setJti("raw-jti")
    .sign(key);
}

beforeAll(async () => {
  for (const k of TOUCHED) snapshot[k] = process.env[k];
  keyA = await mintKey();
  keyB = await mintKey();
});
beforeEach(() => {
  process.env.SSO_HANDOFF_PRIVATE_KEY = keyA.json;
  delete process.env.SSO_HANDOFF_KID;
  delete process.env.SSO_HANDOFF_PREVIOUS_PRIVATE_KEY;
  delete process.env.SSO_HANDOFF_PREVIOUS_KID;
  process.env.SSO_HANDOFF_ISSUER = ISSUER;
  process.env.BETTER_AUTH_URL = ISSUER;
  __resetSsoHandoffKeyCacheForTests();
});
afterAll(() => {
  for (const k of TOUCHED) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  __resetSsoHandoffKeyCacheForTests();
});

describe("jwt handoff — EdDSA signer/verifier (review #5)", () => {
  it("round-trips a token with matching audience and exposes the registered claims", async () => {
    const token = await sign("11111111-1111-1111-1111-111111111111");
    const verified = await verifySsoHandoff({ token, expectedAudience: AUD });
    expect(verified.payload.email).toBe(baseClaims.email);
    expect(verified.payload.targetApplicationId).toBe("portal");
    expect(verified.payload.locale).toBe("en");
    expect(verified.payload.jti).toBe("11111111-1111-1111-1111-111111111111");
    expect(verified.payload.sub).toBe("ba-user-1");
  });

  it("signs with alg EdDSA, typ JWT and kid = the JWK thumbprint", async () => {
    const header = decodeProtectedHeader(await sign("h1"));
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(keyA.kid);
    expect(isSsoHandoffSignerConfigured()).toBe(true);
    expect(isSsoHandoffSelfIssuer()).toBe(true);
  });

  it("honours a pinned SSO_HANDOFF_KID in both the header and the JWKS", async () => {
    process.env.SSO_HANDOFF_KID = "handoff-2026-09";
    __resetSsoHandoffKeyCacheForTests();
    const token = await sign("kid-1");
    expect(decodeProtectedHeader(token).kid).toBe("handoff-2026-09");
    expect((await getSsoHandoffJwks()).keys.map((k) => k.kid)).toEqual(["handoff-2026-09"]);
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).resolves.toBeDefined();
  });

  it("minimises claims: no roles, organizationId or appUserId ride in the URL-borne token (review #60)", async () => {
    const payload = decodeJwt(await sign("min-1"));
    expect(Object.keys(payload).sort()).toEqual(
      ["aud", "email", "exp", "iat", "iss", "jti", "locale", "sub", "targetApplicationId"].sort(),
    );
    expect(payload).not.toHaveProperty("roles");
    expect(payload).not.toHaveProperty("organizationId");
    expect(payload).not.toHaveProperty("appUserId");
  });

  it("publishes only public material in the JWKS (no `d`), with alg/use/kid", async () => {
    const { keys } = await getSsoHandoffJwks();
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      kid: keyA.kid,
    });
    expect(key).not.toHaveProperty("d");
  });

  it("rejects an audience mismatch", async () => {
    const token = await sign("22222222-2222-2222-2222-222222222222");
    await expect(
      verifySsoHandoff({ token, expectedAudience: "devresponse-app:other" }),
    ).rejects.toThrow();
  });

  it("rejects an issuer mismatch", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await raw(keyA.privateKey, { kid: keyA.kid }, { iat: now, exp: now + 30 });
    process.env.SSO_HANDOFF_ISSUER = "https://other-issuer.test";
    process.env.BETTER_AUTH_URL = "https://other-issuer.test";
    __resetSsoHandoffKeyCacheForTests();
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow(/"iss"/);
  });

  it("rejects an expired token (past the clock tolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await raw(keyA.privateKey, { kid: keyA.kid }, { iat: now - 40, exp: now - 10 });
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow(/exp/i);
  });

  it("clamps the TTL at 60 seconds", async () => {
    const token = await sign("44444444-4444-4444-4444-444444444444", 6_000);
    const verified = await verifySsoHandoff({ token, expectedAudience: AUD });
    expect(verified.payload.exp - verified.payload.iat).toBeLessThanOrEqual(60);
  });

  it("enforces the 60s ceiling on the RECEIVER via maxTokenAge — a signer that failed to clamp exp gains nothing (review #61)", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Freshly issued but long-lived: accepted now (age 0)…
    const fresh = await raw(keyA.privateKey, { kid: keyA.kid }, { iat: now, exp: now + 3600 });
    await expect(verifySsoHandoff({ token: fresh, expectedAudience: AUD })).resolves.toBeDefined();
    // …but the same shape issued 70s ago is rejected even though exp is far away.
    const stale = await raw(keyA.privateKey, { kid: keyA.kid }, { iat: now - 70, exp: now + 3600 });
    await expect(verifySsoHandoff({ token: stale, expectedAudience: AUD })).rejects.toThrow(
      /maxTokenAge|too far in the past/i,
    );
    // And a token with no iat at all cannot dodge the age check.
    const noIat = await new SignJWT({ ...baseClaims })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: keyA.kid })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject("ba-user-1")
      .setJti("no-iat")
      .setExpirationTime("30s")
      .sign(keyA.privateKey);
    await expect(verifySsoHandoff({ token: noIat, expectedAudience: AUD })).rejects.toThrow(/iat/i);
  });

  it("rejects an HS256 token — including one keyed on the public key bytes (algorithm confusion)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const build = (secret: Uint8Array) =>
      new SignJWT({ ...baseClaims, iat: now, exp: now + 30 })
        .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: keyA.kid })
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setSubject("ba-user-1")
        .setJti("hs-1")
        .sign(secret);
    const legacy = await build(new TextEncoder().encode("legacy-fleet-wide-secret-legacy-fleet"));
    await expect(verifySsoHandoff({ token: legacy, expectedAudience: AUD })).rejects.toThrow();
    const confusion = await build(new TextEncoder().encode(keyA.jwk.x as string));
    await expect(verifySsoHandoff({ token: confusion, expectedAudience: AUD })).rejects.toThrow();
  });

  it("rejects a token whose kid names no published key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await raw(
      keyA.privateKey,
      { kid: "not-a-published-kid" },
      { iat: now, exp: now + 30 },
    );
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow();
  });

  it("rejects a token signed by a different Ed25519 key, even under the published kid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await raw(keyB.privateKey, { kid: keyA.kid }, { iat: now, exp: now + 30 });
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow(/signature/i);
  });

  it("rejects a token whose typ is not JWT", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await raw(
      keyA.privateKey,
      { kid: keyA.kid, typ: "at+jwt" },
      { iat: now, exp: now + 30 },
    );
    await expect(verifySsoHandoff({ token, expectedAudience: AUD })).rejects.toThrow(/typ/i);
  });

  it("keeps verifying tokens minted by the previous key during a rotation overlap, and stops once it is removed", async () => {
    // Token minted under key A, right before the rotation.
    const minted = await sign("rot-1");
    expect(decodeProtectedHeader(minted).kid).toBe(keyA.kid);

    // Rotate: B becomes current, A is kept as the previous key.
    process.env.SSO_HANDOFF_PRIVATE_KEY = keyB.json;
    process.env.SSO_HANDOFF_PREVIOUS_PRIVATE_KEY = keyA.json;
    __resetSsoHandoffKeyCacheForTests();

    const { keys } = await getSsoHandoffJwks();
    expect(keys.map((k) => k.kid)).toEqual([keyB.kid, keyA.kid]);
    expect(keys.every((k) => !("d" in k))).toBe(true);
    await expect(verifySsoHandoff({ token: minted, expectedAudience: AUD })).resolves.toBeDefined();
    const fresh = await sign("rot-2");
    expect(decodeProtectedHeader(fresh).kid).toBe(keyB.kid);
    await expect(verifySsoHandoff({ token: fresh, expectedAudience: AUD })).resolves.toBeDefined();

    // Window closed: the old key is dropped and its tokens no longer verify.
    delete process.env.SSO_HANDOFF_PREVIOUS_PRIVATE_KEY;
    __resetSsoHandoffKeyCacheForTests();
    expect((await getSsoHandoffJwks()).keys.map((k) => k.kid)).toEqual([keyB.kid]);
    await expect(verifySsoHandoff({ token: minted, expectedAudience: AUD })).rejects.toThrow();
  });

  it("is NOT a self-issuer when SSO_HANDOFF_ISSUER points at another origin", () => {
    process.env.BETTER_AUTH_URL = "https://satellite.test";
    expect(isSsoHandoffSignerConfigured()).toBe(true);
    expect(isSsoHandoffSelfIssuer()).toBe(false);
  });
});
