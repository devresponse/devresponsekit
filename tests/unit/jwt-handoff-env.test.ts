import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type CryptoKey } from "jose";
import {
  __resetSsoHandoffKeyCacheForTests,
  clampSsoHandoffTtl,
  getSsoHandoffJwks,
  signSsoHandoff,
  verifySsoHandoff,
} from "@/lib/jwt-handoff.server";

/**
 * Branch coverage for `jwt-handoff.server.ts` (§29.4.5) — the "missing /
 * malformed env" guard branches that the happy-path suites in
 * `tests/security/jwt-handoff*.test.ts` intentionally do not hit. The global
 * setup provides an ephemeral `SSO_HANDOFF_PRIVATE_KEY` and a self-issuer
 * (`SSO_HANDOFF_ISSUER` = `BETTER_AUTH_URL`).
 */
const TOUCHED = [
  "SSO_HANDOFF_PRIVATE_KEY",
  "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY",
  "SSO_HANDOFF_ISSUER",
] as const;
const snapshot: Record<string, string | undefined> = {};

describe("jwt-handoff.server env guards", () => {
  const baseInput = {
    betterAuthUserId: "ba-1",
    audience: "devresponse-app:portal",
    jti: "11111111-1111-1111-1111-111111111111",
    ttlSeconds: 30,
    claims: { email: "u@x.com", targetApplicationId: "portal", locale: "en" },
  };

  beforeEach(() => {
    for (const k of TOUCHED) snapshot[k] = process.env[k];
    __resetSsoHandoffKeyCacheForTests();
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
    __resetSsoHandoffKeyCacheForTests();
  });

  it("throws on sign when SSO_HANDOFF_PRIVATE_KEY is missing (launch fails closed)", async () => {
    delete process.env.SSO_HANDOFF_PRIVATE_KEY;
    await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
  });

  it("treats an empty SSO_HANDOFF_PRIVATE_KEY as unset", async () => {
    process.env.SSO_HANDOFF_PRIVATE_KEY = "";
    await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
    expect(await getSsoHandoffJwks()).toEqual({ keys: [] });
  });

  it("throws on sign when SSO_HANDOFF_ISSUER is missing", async () => {
    delete process.env.SSO_HANDOFF_ISSUER;
    await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_ISSUER/);
  });

  it("throws on verify when SSO_HANDOFF_ISSUER is missing", async () => {
    delete process.env.SSO_HANDOFF_ISSUER;
    await expect(verifySsoHandoff({ token: "x", expectedAudience: "y" })).rejects.toThrow(
      /SSO_HANDOFF_ISSUER/,
    );
  });

  it.each([
    ["not JSON", "not-json"],
    ["a JSON scalar", '"just-a-string"'],
    ["a non-Ed25519 JWK", JSON.stringify({ kty: "RSA", n: "x", e: "AQAB", d: "y" })],
    ["a public-only JWK (no d)", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "abc" })],
  ])("rejects a malformed SSO_HANDOFF_PRIVATE_KEY (%s) with a clear error", async (_label, raw) => {
    process.env.SSO_HANDOFF_PRIVATE_KEY = raw;
    await expect(signSsoHandoff(baseInput)).rejects.toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
  });

  it("rejects a malformed SSO_HANDOFF_PREVIOUS_PRIVATE_KEY when building the key set", async () => {
    process.env.SSO_HANDOFF_PREVIOUS_PRIVATE_KEY = "{}";
    await expect(getSsoHandoffJwks()).rejects.toThrow(/SSO_HANDOFF_PREVIOUS_PRIVATE_KEY/);
  });

  it("rejects tokens with an invalid or incomplete claim set (P3-11)", async () => {
    const jwk = JSON.parse(process.env.SSO_HANDOFF_PRIVATE_KEY!) as Parameters<typeof importJWK>[0];
    const key = (await importJWK({ ...jwk, alg: "EdDSA" }, "EdDSA")) as CryptoKey;
    const { keys } = await getSsoHandoffJwks();
    const kid = keys[0]!.kid!;
    const base = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
        .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
        .setAudience("devresponse-app:portal")
        .setIssuedAt()
        .setExpirationTime("60s");

    // Missing jti/sub (and every custom claim).
    const noJtiSub = await base().sign(key);
    await expect(
      verifySsoHandoff({ token: noJtiSub, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow(/invalid or incomplete claim set/);

    // Has jti/sub but omits a required custom claim (email) — the full-claim
    // boundary validation rejects it rather than `as`-casting a partial payload
    // into session establishment.
    const missingEmail = await new SignJWT({ targetApplicationId: "portal", locale: "en" })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
      .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
      .setAudience("devresponse-app:portal")
      .setSubject("ba-1")
      .setJti("j1")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
    await expect(
      verifySsoHandoff({ token: missingEmail, expectedAudience: "devresponse-app:portal" }),
    ).rejects.toThrow(/invalid or incomplete claim set/);
  });

  it("reuses cached key material for the same env value and rebuilds it when the key changes", async () => {
    const first = await getSsoHandoffJwks();
    expect((await getSsoHandoffJwks()).keys).toBe(first.keys); // cache hit — same array
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    process.env.SSO_HANDOFF_PRIVATE_KEY = JSON.stringify(await exportJWK(privateKey));
    const second = await getSsoHandoffJwks();
    expect(second.keys).not.toBe(first.keys);
    expect(second.keys[0]!.kid).not.toBe(first.keys[0]!.kid);
  });

  it("re-exports the clamp helper used by SSO callers", () => {
    expect(clampSsoHandoffTtl(120)).toBe(60);
  });
});
