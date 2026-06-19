import "server-only";
import {
  SignJWT,
  importJWK,
  jwtVerify,
  createLocalJWKSet,
  calculateJwkThumbprint,
  type JWK,
  type CryptoKey,
} from "jose";
import { getServerEnv } from "@/lib/env";

/**
 * JWT access-token issuer + verifier and the JWKS publisher (design
 * docs/design-api-keys-and-tokens.md §6).
 *
 * Design deviation (documented): the design proposed adopting Better
 * Auth's `jwt()` plugin. We instead sign with `jose` directly because
 *   - `jose` is already a dependency (no new package, no plugin-version
 *     API risk),
 *   - it keeps the signing key in our own env / KMS reference rather than
 *     a Better-Auth-managed table,
 *   - it is trivially unit-testable offline.
 * The public contract (asymmetric EdDSA + a `/api/v1/jwks.json` document +
 * `kid` rotation) is identical to the design.
 *
 * The keypair and audience are deliberately SEPARATE from
 * `SSO_HANDOFF_JWT_SECRET` (HS256, 60-second subdomain handoff) per the
 * "independent secrets" rule.
 */

const ALG = "EdDSA";

interface KeyMaterial {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

let cached: KeyMaterial | null = null;
let cachedPublicJwks: JWK[] | null = null;

/** Strips the secret `d` member and stamps the metadata clients need to select
 *  and verify with the right key. `kidOverride` wins; otherwise the JWK
 *  thumbprint (so the kid changes with the key material). */
async function toPublicJwk(jwk: JWK, kidOverride?: string): Promise<JWK> {
  const { d: _d, ...publicMembers } = jwk;
  void _d;
  const kid = kidOverride || (await calculateJwkThumbprint(jwk));
  return { ...publicMembers, alg: ALG, use: "sig", kid };
}

function parseJwk(raw: string, label: string): JWK {
  try {
    return JSON.parse(raw) as JWK;
  } catch {
    throw new Error(`${label} must be a JSON-encoded Ed25519 JWK`);
  }
}

/**
 * Parses `API_JWT_PRIVATE_KEY` (an Ed25519 JWK JSON string containing the
 * private `d` member), imports the signing key, and derives the public
 * JWK for JWKS publication. Cached after first use.
 */
async function getKeyMaterial(): Promise<KeyMaterial> {
  if (cached) return cached;
  const env = getServerEnv();
  if (!env.API_JWT_PRIVATE_KEY) {
    throw new Error("API_JWT_PRIVATE_KEY is not configured (API_JWT_ENABLED requires it)");
  }

  const jwk = parseJwk(env.API_JWT_PRIVATE_KEY, "API_JWT_PRIVATE_KEY");
  const privateKey = (await importJWK({ ...jwk, alg: ALG }, ALG)) as CryptoKey;
  const publicJwk = await toPublicJwk(jwk, env.API_JWT_KID);

  cached = { privateKey, publicJwk, kid: publicJwk.kid! };
  return cached;
}

/**
 * The public JWKs to PUBLISH and VERIFY against: the current signing key, plus
 * an OPTIONAL previous key kept during a rotation overlap (P3-7) so tokens
 * minted before the rotation still verify until they expire. The previous key's
 * public half is derived from `API_JWT_PREVIOUS_PRIVATE_KEY` (never imported as
 * a signing key); its kid comes from `API_JWT_PREVIOUS_KID` or the thumbprint.
 */
async function getPublicJwks(): Promise<JWK[]> {
  if (cachedPublicJwks) return cachedPublicJwks;
  const env = getServerEnv();
  const { publicJwk } = await getKeyMaterial();
  const keys: JWK[] = [publicJwk];
  if (env.API_JWT_PREVIOUS_PRIVATE_KEY) {
    const prev = parseJwk(env.API_JWT_PREVIOUS_PRIVATE_KEY, "API_JWT_PREVIOUS_PRIVATE_KEY");
    keys.push(await toPublicJwk(prev, env.API_JWT_PREVIOUS_KID));
  }
  cachedPublicJwks = keys;
  return keys;
}

/** Test-only: drop the cached key material so a new env can be applied. */
export function __resetJwtKeyCacheForTests(): void {
  cached = null;
  cachedPublicJwks = null;
}

export interface MintAccessTokenInput {
  /** Principal identity (Better Auth user id) → `sub`. */
  subject: string;
  /** Space-delimited scope string is built from this array. */
  scopes: string[];
  /** Organization id → `org` claim. */
  organizationId?: string | null;
  /** Unique token id → `jti` (used for revocation + audit). */
  jti: string;
  /** Override TTL in seconds (defaults to `API_JWT_ACCESS_TTL_SECONDS`). */
  ttlSeconds?: number;
}

export interface MintedAccessToken {
  token: string;
  jti: string;
  expiresInSeconds: number;
  scopes: string[];
}

/** Signs a short-lived EdDSA access token. */
export async function mintAccessToken(input: MintAccessTokenInput): Promise<MintedAccessToken> {
  const env = getServerEnv();
  const { privateKey, kid } = await getKeyMaterial();
  const ttl = input.ttlSeconds ?? env.API_JWT_ACCESS_TTL_SECONDS;

  const token = await new SignJWT({
    scope: input.scopes.join(" "),
    org: input.organizationId ?? undefined,
  })
    .setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
    .setIssuer(env.API_JWT_ISSUER ?? env.BETTER_AUTH_URL)
    .setAudience(env.API_JWT_AUDIENCE)
    .setSubject(input.subject)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);

  return { token, jti: input.jti, expiresInSeconds: ttl, scopes: input.scopes };
}

export interface VerifiedAccessToken {
  subject: string;
  scopes: string[];
  organizationId: string | null;
  jti: string;
  expiresAt: Date;
}

/**
 * Verifies an access token's signature, issuer, and audience. Throws on
 * any failure (bad signature, expired, wrong aud/iss). The caller is
 * responsible for the `jti` revocation check and principal resolution.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  const env = getServerEnv();
  // A local JWK Set (current + optional previous key) selects the key by the
  // token's `kid`, so a token minted with either key verifies during a rotation
  // overlap (P3-7).
  const jwks = createLocalJWKSet({ keys: await getPublicJwks() });

  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.API_JWT_ISSUER ?? env.BETTER_AUTH_URL,
    audience: env.API_JWT_AUDIENCE,
    algorithms: [ALG],
  });

  if (!payload.sub || !payload.jti || typeof payload.exp !== "number") {
    throw new Error("token missing required claims");
  }

  const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
  return {
    subject: payload.sub,
    scopes: scopeClaim.split(/\s+/).filter(Boolean),
    organizationId: typeof payload.org === "string" ? payload.org : null,
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * Returns the public JWK Set served at `/api/v1/jwks.json` — the current
 * signing key plus the optional previous key during a rotation overlap (P3-7),
 * so external verifiers accept tokens signed by either.
 */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  return { keys: await getPublicJwks() };
}
