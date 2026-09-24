import "server-only";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { ed25519PrivateJwkProblem } from "@/lib/env-validators";

/**
 * Boot-time import of the Ed25519 signing keys (F-22, review #50).
 *
 * The env schema (`src/lib/env.ts`) checks each key's SHAPE with
 * `ed25519PrivateJwkProblem`: JSON, kty OKP / crv Ed25519, and `x` and `d`
 * each 32 bytes of unpadded base64url. It cannot import the key, because
 * `env.ts` is in the Edge instrumentation graph where `node:crypto` is not
 * available (`tests/unit/edge-import-graph.test.ts`). So a key whose halves
 * came from two different JWKs passes the schema, and the JWKS would then
 * publish a public key that verifies nothing while `jose` refuses to import the
 * private one: every handoff or machine-API token fails.
 *
 * This module does the import, on Node only. The Node branch of `register()`
 * in `src/instrumentation.ts` calls {@link assertSigningKeysImport} once per
 * process, outside `next build`, and lets it throw, so Next fails startup with
 * "An error occurred while loading instrumentation hook". The runtime
 * `JwtKeyMaterialError` path in `src/lib/api-auth/jwt.server.ts` stays as the
 * safety net. Nothing in the Edge graph may import this file.
 */

/** The four variables that hold an Ed25519 private JWK. */
export const SIGNING_KEY_VARIABLES = [
  "SSO_HANDOFF_PRIVATE_KEY",
  "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY",
  "API_JWT_PRIVATE_KEY",
  "API_JWT_PREVIOUS_PRIVATE_KEY",
] as const;

const DOES_NOT_IMPORT = "does not import as an Ed25519 private key (is d truncated or corrupted?)";
const X_IS_NOT_D_PUBLIC_HALF = "has an x member that is not the public half of its d";

/**
 * Imports `raw` as an Ed25519 private JWK, synchronously, the way `jose`'s
 * `importJWK` will at the first mint or JWKS request, and checks that `x` is
 * the public half of `d`. Returns a problem sentence or `null`; the sentences
 * never quote key material.
 *
 * It is the import half of the key rule: {@link assertSigningKeysImport} runs
 * `ed25519PrivateJwkProblem` first, whose sentences are more precise for a
 * value of the wrong shape. On its own it still accepts nothing but a usable
 * Ed25519 private key: a value that is not a JSON object, not a private key or
 * not on Ed25519 answers {@link DOES_NOT_IMPORT}.
 */
export function ed25519KeyPairProblem(raw: string): string | null {
  let x: unknown;
  let derivedX: unknown;
  try {
    const jwk = JSON.parse(raw) as Record<string, unknown>;
    x = jwk.x;
    const { kty, crv, d } = jwk;
    const key = createPrivateKey({ key: { kty, crv, x, d } as JsonWebKey, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") return DOES_NOT_IMPORT;
    derivedX = createPublicKey(key).export({ format: "jwk" }).x;
  } catch {
    return DOES_NOT_IMPORT;
  }
  if (derivedX !== x) return X_IS_NOT_D_PUBLIC_HALF;
  return null;
}

/**
 * Checks every signing-key variable that is set and not blank: its shape, then
 * its import. Throws ONE error naming each failing variable with its rule, in
 * the `NAME (rule)` form of the env schema's own boot error, and never its
 * value. A no-op when every key is unset or sound.
 */
export function assertSigningKeysImport(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const failures: string[] = [];
  for (const name of SIGNING_KEY_VARIABLES) {
    const value = env[name];
    if (!value?.trim()) continue;
    const problem = ed25519PrivateJwkProblem(value) ?? ed25519KeyPairProblem(value);
    if (problem) failures.push(`${name} (${problem})`);
  }
  if (failures.length > 0) {
    throw new Error(`Invalid Ed25519 signing keys at boot: ${failures.join("; ")}`);
  }
}
