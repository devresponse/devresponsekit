import { generateKeyPairSync, randomBytes } from "node:crypto";

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
 * against the issuer's published JWKS. The kit validates the shape at BOOT
 * (kty OKP, crv Ed25519, and a private `d`), so a truncated paste fails the
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

/** True when `value` parses as the Ed25519 private JWK the kit demands. */
export function isValidHandoffPrivateJwk(value: string): boolean {
  try {
    const jwk = JSON.parse(value) as Record<string, unknown>;
    return (
      jwk !== null &&
      typeof jwk === "object" &&
      jwk.kty === "OKP" &&
      jwk.crv === "Ed25519" &&
      typeof jwk.x === "string" &&
      typeof jwk.d === "string"
    );
  } catch {
    return false;
  }
}
