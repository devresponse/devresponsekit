import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Generators for the values devresponsekit refuses to boot (or silently fails)
 * without. Each mirrors a rule enforced by `src/lib/env.ts` in the kit, so a
 * value produced here always survives that schema.
 */

/**
 * Signs session cookies. The kit requires >= 32 characters AND rejects the
 * `.env.example` placeholder in production, so this is a real 32 bytes of
 * entropy — the same thing `openssl rand -base64 32` produces.
 */
export function generateAuthSecret(): string {
  return randomBytes(32).toString("base64");
}

/**
 * An operator-chosen shared secret (CRON_SECRET, METRICS_TOKEN). The kit's
 * schema refuses anything under 32 characters when the variable is set, so a
 * short "temporary" token fails at boot rather than quietly weakening the
 * endpoint it guards. base64url keeps it safe to paste into a header.
 */
export function generateOperatorSecret(): string {
  return randomBytes(32).toString("base64url");
}

export interface HandoffKeypair {
  /** The private JWK, JSON-encoded — the value of SSO_HANDOFF_PRIVATE_KEY. */
  privateJwk: string;
  /** The public half, for eyeballing against `/api/sso/jwks.json` after deploy. */
  publicJwk: string;
}

/**
 * The Ed25519 keypair that signs SSO handoff tokens.
 *
 * Only the issuer (the primary) holds the private half; satellites verify
 * against the issuer's published JWKS. The kit IMPORTS the key at BOOT (F-22,
 * {@link ed25519PrivateJwkProblem}), so a truncated paste fails the
 * deployment instead of the first handoff — and until it is set,
 * `/api/sso/launch` answers 503 while `/api/sso/jwks.json` serves an empty key
 * set, which is exactly the state a fleet cannot verify against.
 */
export function generateHandoffKeypair(): HandoffKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateJwk: JSON.stringify(privateKey.export({ format: "jwk" })),
    publicJwk: JSON.stringify(publicKey.export({ format: "jwk" })),
  };
}

/** An Ed25519 JWK coordinate: 32 bytes as unpadded base64url, 43 characters. */
const ED25519_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The kit's WHOLE key rule (F-22), copied because this package cannot import
 * across its `rootDir`. The kit splits it in two: the shape
 * (`ed25519PrivateJwkProblem` in `src/lib/env-validators.ts`, run when the env
 * schema is parsed) and the import (`ed25519KeyPairProblem` in
 * `src/lib/env-signing-keys.server.ts`, run at Node boot). This CLI always
 * runs on Node, so it runs both, in the same order. The kit's
 * `tests/unit/env-signing-keys.test.ts` runs this copy and the kit's pair over
 * the same vectors, so a change to one that is not made to the other fails
 * there.
 *
 * Shape: JSON, kty OKP / crv Ed25519, and `x` and `d` each 43 unpadded
 * base64url characters, which catches a truncated or corrupted `d` and a
 * stray quote in `x`. Import: an `x` that is not `d`'s public half (halves
 * pasted from two keys) would publish a JWKS that verifies nothing. The
 * sentences never quote key material.
 */
export function ed25519PrivateJwkProblem(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "must be a JSON-encoded Ed25519 private JWK (it is not valid JSON)";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "must be a JSON-encoded Ed25519 private JWK (a JSON object)";
  }
  const { kty, crv, x, d } = parsed as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519") {
    return "must be an Ed25519 JWK (kty OKP, crv Ed25519)";
  }
  if (typeof d !== "string" || typeof x !== "string") {
    return "must carry both the private d and the public x member";
  }
  if (!ED25519_COORDINATE.test(d)) {
    return "has a d member that is not 43 unpadded base64url characters, the 32-byte private key (is d truncated or corrupted?)";
  }
  if (!ED25519_COORDINATE.test(x)) {
    return "has an x member that is not 43 unpadded base64url characters, the 32-byte public key (is x truncated or corrupted?)";
  }
  let derivedX: unknown;
  // Node reads any 43-character `d` as a 32-byte seed, and every seed is a
  // valid key, so the shape check above leaves this catch as a safety net.
  try {
    const key = createPrivateKey({ key: { kty, crv, x, d }, format: "jwk" });
    derivedX = createPublicKey(key).export({ format: "jwk" }).x;
  } catch {
    return "does not import as an Ed25519 private key (is d truncated or corrupted?)";
  }
  if (derivedX !== x) {
    return "has an x member that is not the public half of its d";
  }
  return null;
}

/** True when `value` imports as the Ed25519 private JWK the kit demands. */
export function isValidHandoffPrivateJwk(value: string): boolean {
  return ed25519PrivateJwkProblem(value) === null;
}
