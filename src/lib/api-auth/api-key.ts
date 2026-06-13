/**
 * API key codec (design docs/design-api-keys-and-tokens.md §5).
 *
 * Pure, dependency-free, no `server-only` so unit tests and route
 * handlers share one implementation. Uses Web Crypto (`globalThis.crypto`)
 * so it works in both the Node and edge runtimes.
 *
 * Format: `drk_<env>_<random>` where
 *   - `drk`     — fixed product prefix (lets the resolver detect a key vs
 *                 a JWT by inspecting the bearer token's leading bytes),
 *   - `<env>`   — `live` | `test` (stamped from `API_KEY_ENV_TAG`),
 *   - `<random>`— 32 base62 chars (~190 bits of CSPRNG entropy).
 *
 * Only the SHA-256 hash is ever persisted; the plaintext is shown once.
 * Because keys are high-entropy, a fast hash with a unique index is the
 * correct choice — bcrypt/argon2 exist to slow down guessing of
 * low-entropy human passwords, which does not apply here.
 */

export const API_KEY_PRODUCT_PREFIX = "drk";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 32;
/** Chars of the random segment surfaced (with the tag) as the display prefix. */
const DISPLAY_RANDOM_CHARS = 8;

export type ApiKeyEnvTag = "live" | "test";

export interface GeneratedApiKey {
  /** Full secret, returned to the caller exactly once. */
  plaintext: string;
  /** Stable, non-secret display prefix, e.g. `drk_live_AbCd1234`. */
  prefix: string;
}

/** Returns `true` when a bearer token looks like one of our API keys. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(`${API_KEY_PRODUCT_PREFIX}_`);
}

function randomBase62(length: number): string {
  // Rejection-free mapping: draw a byte per char and fold into 62. The
  // slight modulo bias over 256→62 is immaterial for a 190-bit secret.
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62.charAt(bytes[i]! % BASE62.length);
  }
  return out;
}

/**
 * Generates a fresh API key for the given environment tag. The returned
 * `prefix` is safe to store and display; the `plaintext` must be handed
 * to the caller and then discarded (only its hash is persisted).
 */
export function generateApiKey(tag: ApiKeyEnvTag): GeneratedApiKey {
  const random = randomBase62(RANDOM_LENGTH);
  const plaintext = `${API_KEY_PRODUCT_PREFIX}_${tag}_${random}`;
  const prefix = `${API_KEY_PRODUCT_PREFIX}_${tag}_${random.slice(0, DISPLAY_RANDOM_CHARS)}`;
  return { plaintext, prefix };
}

/** Derives the display prefix from a plaintext key (for verification UIs). */
export function deriveApiKeyPrefix(plaintext: string): string {
  const parts = plaintext.split("_");
  if (parts.length < 3) return plaintext.slice(0, 12);
  const product = parts[0]!;
  const tag = parts[1]!;
  const random = parts.slice(2).join("_");
  return `${product}_${tag}_${random.slice(0, DISPLAY_RANDOM_CHARS)}`;
}

/**
 * SHA-256 of the plaintext, hex-encoded. This is the value stored in
 * `app_api_keys.key_hash` (unique-indexed) and recomputed on every
 * presented key for an O(1) lookup. Never store or log the plaintext.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

/** SHA-256 of an arbitrary secret (used for OAuth client secrets too). */
export async function hashSecret(secret: string): Promise<string> {
  return hashApiKey(secret);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
