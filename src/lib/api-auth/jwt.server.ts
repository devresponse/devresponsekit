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
 * `SSO_HANDOFF_PRIVATE_KEY` (the EdDSA key behind the 60-second subdomain
 * handoff, `src/lib/jwt-handoff.server.ts`) per the "independent keys" rule.
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

/**
 * The long-lived credential a token was minted FROM (review #43). Carried as
 * the `cid` claim (`"<kind>:<row id>"`) so the resolver can re-check, on
 * every request, that the source key / client is still `active` — revoking
 * or rotating the credential then kills its outstanding tokens instead of
 * leaving them valid until `exp`.
 */
export interface TokenCredentialRef {
  kind: "api_key" | "oauth_client";
  id: string;
}

const CID_KINDS: ReadonlySet<string> = new Set(["api_key", "oauth_client"]);

function encodeCredentialRef(ref: TokenCredentialRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Parses a `cid` claim; `null` for a legacy token minted without one, or junk. */
function decodeCredentialRef(claim: unknown): TokenCredentialRef | null {
  if (typeof claim !== "string") return null;
  const idx = claim.indexOf(":");
  if (idx <= 0) return null;
  const kind = claim.slice(0, idx);
  const id = claim.slice(idx + 1);
  if (!CID_KINDS.has(kind) || id === "") return null;
  return { kind: kind as TokenCredentialRef["kind"], id };
}

export interface MintAccessTokenInput {
  /** Principal identity (Better Auth user id) → `sub`. */
  subject: string;
  /** Space-delimited scope string is built from this array. */
  scopes: string[];
  /** Organization id → `org` claim. */
  organizationId?: string | null;
  /** Unique token id → `jti` (used for audit + per-credential rate limiting). */
  jti: string;
  /** Override TTL in seconds (defaults to `API_JWT_ACCESS_TTL_SECONDS`). */
  ttlSeconds?: number;
  /**
   * `aud` claim. Defaults to `API_JWT_AUDIENCE` (the v1 machine API); the
   * token endpoint passes the MCP resource identifier for `resource=<mcp>`
   * (RFC 8707, review #50/#53). See `src/lib/api-auth/resources.ts`.
   */
  audience?: string;
  /** Source credential → `cid` claim (review #43). Omitted only by tests. */
  credential?: TokenCredentialRef | null;
}

export interface MintedAccessToken {
  token: string;
  jti: string;
  expiresInSeconds: number;
  scopes: string[];
  audience: string;
}

/** Signs a short-lived EdDSA access token. */
export async function mintAccessToken(input: MintAccessTokenInput): Promise<MintedAccessToken> {
  const env = getServerEnv();
  const { privateKey, kid } = await getKeyMaterial();
  const ttl = input.ttlSeconds ?? env.API_JWT_ACCESS_TTL_SECONDS;
  const audience = input.audience ?? env.API_JWT_AUDIENCE;

  const token = await new SignJWT({
    scope: input.scopes.join(" "),
    org: input.organizationId ?? undefined,
    cid: input.credential ? encodeCredentialRef(input.credential) : undefined,
  })
    .setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
    .setIssuer(env.API_JWT_ISSUER ?? env.BETTER_AUTH_URL)
    .setAudience(audience)
    .setSubject(input.subject)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);

  return { token, jti: input.jti, expiresInSeconds: ttl, scopes: input.scopes, audience };
}

export interface VerifiedAccessToken {
  subject: string;
  scopes: string[];
  organizationId: string | null;
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Every `aud` value the token carries (normalised to an array). */
  audience: string[];
  /** Source credential from the `cid` claim; `null` for a legacy token. */
  credential: TokenCredentialRef | null;
}

/**
 * Thrown by {@link verifyAccessToken} when the signature, issuer and
 * lifetime are all fine but the token was minted for a DIFFERENT resource
 * (review #50/#53). Distinguished from every other verification failure so
 * a resource server can answer with RFC 6750 `invalid_token` + a hint to
 * request the right `resource`, instead of a generic 401.
 */
export class AccessTokenAudienceError extends Error {
  readonly expected: string[];
  readonly actual: string[];
  constructor(expected: string[], actual: string[]) {
    super(`token audience [${actual.join(", ")}] is not one of [${expected.join(", ")}]`);
    this.name = "AccessTokenAudienceError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface VerifyAccessTokenOptions {
  /**
   * Audience(s) this resource server accepts; the token must carry at least
   * one. Defaults to `API_JWT_AUDIENCE` (the v1 machine API). `/api/mcp`
   * passes its own resource identifier — plus the v1 audience while
   * `MCP_AUDIENCE_GRACE` is on.
   */
  expectedAudience?: string | string[];
}

/**
 * Verifies an access token's signature, issuer, lifetime and audience.
 * Throws on any failure — {@link AccessTokenAudienceError} for a wrong
 * `aud`, a plain error otherwise. The caller is responsible for the source-
 * credential status check (`cid`, review #43) and principal resolution.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions = {},
): Promise<VerifiedAccessToken> {
  const env = getServerEnv();
  // A local JWK Set (current + optional previous key) selects the key by the
  // token's `kid`, so a token minted with either key verifies during a rotation
  // overlap (P3-7).
  const jwks = createLocalJWKSet({ keys: await getPublicJwks() });

  // The audience is checked HERE rather than via jose's `audience` option so
  // a mismatch is a typed, distinguishable failure (review #50/#53); every
  // other claim check stays with jose.
  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.API_JWT_ISSUER ?? env.BETTER_AUTH_URL,
    algorithms: [ALG],
  });

  if (
    !payload.sub ||
    !payload.jti ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number"
  ) {
    throw new Error("token missing required claims");
  }

  const expectedRaw = options.expectedAudience ?? env.API_JWT_AUDIENCE;
  const expected = Array.isArray(expectedRaw) ? expectedRaw : [expectedRaw];
  const actual =
    typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  if (!actual.some((aud) => expected.includes(aud))) {
    throw new AccessTokenAudienceError(expected, actual);
  }

  const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
  return {
    subject: payload.sub,
    scopes: scopeClaim.split(/\s+/).filter(Boolean),
    organizationId: typeof payload.org === "string" ? payload.org : null,
    jti: payload.jti,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    audience: actual,
    credential: decodeCredentialRef(payload.cid),
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
