import "server-only";
import {
  SignJWT,
  jwtVerify,
  importJWK,
  createLocalJWKSet,
  createRemoteJWKSet,
  calculateJwkThumbprint,
  type JWK,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * SSO handoff token codec — ASYMMETRIC (review #5).
 *
 * The handoff used to be an HS256 JWT under one fleet-wide
 * `SSO_HANDOFF_JWT_SECRET`. Because HS256 is symmetric, the credential a
 * satellite needed to VERIFY a handoff was the same credential needed to
 * ISSUE one — so any A/B satellite could mint a sign-in token for any user
 * with any sibling's audience (lateral forgery across the fleet), which
 * contradicted the documented "a compromised satellite is contained" claim.
 *
 * Now the ISSUER (the primary) signs with an Ed25519 private JWK
 * (`SSO_HANDOFF_PRIVATE_KEY`, `alg: EdDSA`) and publishes the public half at
 * `GET /api/sso/jwks.json`. A CONSUMER verifies against that JWKS
 * (`createRemoteJWKSet`, fetched from `SSO_HANDOFF_ISSUER`) and holds NO
 * signing capability at all — a compromised satellite can forge nothing. The
 * same contract as the machine API's `src/lib/api-auth/jwt.server.ts`, with an
 * independent key pair ("independent keys" rule).
 *
 * Self-issuing deployments (the primary consuming its own handoffs, a
 * single-instance rig, CI) verify against the LOCAL public key set derived
 * from the private key instead of an HTTP self-fetch — no network needed.
 *
 * Env reads go through `process.env` (not `getServerEnv`) on purpose: the
 * satellite reference forks carry a byte-for-byte copy of this file and strip
 * parts of the kit's env schema.
 */

const JWT_ALG = "EdDSA";

/** Path (relative to `SSO_HANDOFF_ISSUER`) where the issuer publishes its public keys. */
export const SSO_HANDOFF_JWKS_PATH = "/api/sso/jwks.json";

/**
 * Hard upper bound on SSO handoff token TTL in seconds.
 * Both the signer and any caller computing nonce expiries MUST clamp
 * to this value so the token cannot outlive the persisted nonce row.
 * The VERIFIER also enforces it as `maxTokenAge` (review #61), so the ceiling
 * no longer depends on the signer alone.
 */
export const SSO_HANDOFF_MAX_TTL_SECONDS = 60;

/** Skew the verifier tolerates on `iat`/`exp`/`nbf` between the two hosts. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** Clamps a requested TTL into the allowed range `[1, SSO_HANDOFF_MAX_TTL_SECONDS]`. */
export function clampSsoHandoffTtl(ttlSeconds: number): number {
  return Math.min(Math.max(ttlSeconds, 1), SSO_HANDOFF_MAX_TTL_SECONDS);
}

/**
 * The full handoff claim set, validated at the verify boundary (P3-11). jose
 * has already checked the signature, issuer, audience, expiry, and age before
 * this; the schema pins the shape the consumer builds a session from so a
 * malformed/missing claim can never be `as`-cast into session establishment.
 *
 * Minimised per review #60 — the token rides in a `?token=` query string on
 * two redirect hops (browser history, proxy/CDN logs), so it carries ONLY what
 * a consumer needs: `sub` to establish/provision the session, `email` for the
 * confirm interstitial (and cross-DB provisioning), `locale` for the landing
 * URL, `targetApplicationId` for the application-id binding (review #15).
 * `organizationId`, `appUserId` and `roles[]` were DROPPED: no consumer reads
 * them, and `roles[]` was incomplete anyway (direct roles only, no
 * group-conferred roles) — satellites derive authority from their own store.
 */
const handoffClaimsSchema = z.object({
  jti: z.string().min(1),
  sub: z.string().min(1),
  email: z.string(),
  targetApplicationId: z.string(),
  locale: z.string(),
  iat: z.number(),
  exp: z.number(),
});

export interface SsoHandoffClaims extends JWTPayload {
  email: string;
  targetApplicationId: string;
  locale: string;
}

export interface SignSsoHandoffInput {
  betterAuthUserId: string;
  audience: string;
  jti: string;
  ttlSeconds: number;
  claims: SsoHandoffClaims;
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

interface SignerMaterial {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

/** Cached per raw env value so a swapped key (tests, rotation) is picked up. */
let signerCache: { raw: string; kid: string | undefined; material: SignerMaterial } | null = null;
let publicJwksCache: { fingerprint: string; keys: JWK[] } | null = null;
const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

/** Test-only: drop every cached key set so a new env can be applied. */
export function __resetSsoHandoffKeyCacheForTests(): void {
  signerCache = null;
  publicJwksCache = null;
  remoteJwksCache.clear();
}

function parseJwk(raw: string, label: string): JWK {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be a JSON-encoded Ed25519 private JWK`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON-encoded Ed25519 private JWK`);
  }
  const jwk = parsed as JWK;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error(`${label} must be an Ed25519 JWK (kty OKP, crv Ed25519)`);
  }
  return jwk;
}

/** Strips the secret `d` member and stamps the metadata verifiers need to
 *  select the right key. `kidOverride` wins; otherwise the JWK thumbprint
 *  (so the kid changes with the key material). */
async function toPublicJwk(jwk: JWK, kidOverride?: string): Promise<JWK> {
  const { d: _d, ...publicMembers } = jwk;
  void _d;
  const kid = kidOverride || (await calculateJwkThumbprint(jwk));
  return { ...publicMembers, alg: JWT_ALG, use: "sig", kid };
}

function privateKeyEnv(): string | undefined {
  const raw = process.env.SSO_HANDOFF_PRIVATE_KEY;
  return raw ? raw : undefined;
}

/**
 * True when THIS deployment can issue handoffs (a private key is configured).
 * Launch fails closed with a clear error when false; SSO consumption does not
 * need it.
 */
export function isSsoHandoffSignerConfigured(): boolean {
  return privateKeyEnv() !== undefined;
}

/**
 * Parses `SSO_HANDOFF_PRIVATE_KEY` (an Ed25519 JWK JSON string containing the
 * private `d` member), imports the signing key, and derives the public JWK.
 */
async function getSignerMaterial(): Promise<SignerMaterial> {
  const raw = privateKeyEnv();
  if (!raw) {
    throw new Error("SSO_HANDOFF_PRIVATE_KEY is not configured");
  }
  const kidOverride = process.env.SSO_HANDOFF_KID || undefined;
  if (signerCache && signerCache.raw === raw && signerCache.kid === kidOverride) {
    return signerCache.material;
  }
  const jwk = parseJwk(raw, "SSO_HANDOFF_PRIVATE_KEY");
  if (typeof jwk.d !== "string") {
    throw new Error("SSO_HANDOFF_PRIVATE_KEY must contain the private `d` member");
  }
  const privateKey = (await importJWK({ ...jwk, alg: JWT_ALG }, JWT_ALG)) as CryptoKey;
  const publicJwk = await toPublicJwk(jwk, kidOverride);
  const material = { privateKey, publicJwk, kid: publicJwk.kid! };
  signerCache = { raw, kid: kidOverride, material };
  return material;
}

/**
 * The public JWKs this deployment PUBLISHES (and, when self-issuing, verifies
 * against): the current signing key plus an OPTIONAL previous key kept during
 * a rotation overlap so tokens minted before the rotation still verify until
 * they expire (≤60s — the overlap can be very short). The previous key's
 * public half is derived from `SSO_HANDOFF_PREVIOUS_PRIVATE_KEY` (never
 * imported as a signing key); its kid comes from `SSO_HANDOFF_PREVIOUS_KID` or
 * the thumbprint.
 *
 * Returns `[]` when no signing key is configured — the JWKS route still
 * answers with a well-formed `{ keys: [] }` document.
 */
async function getLocalPublicJwks(): Promise<JWK[]> {
  const raw = privateKeyEnv();
  if (!raw) return [];
  const prevRaw = process.env.SSO_HANDOFF_PREVIOUS_PRIVATE_KEY || undefined;
  const prevKid = process.env.SSO_HANDOFF_PREVIOUS_KID || undefined;
  const fingerprint = JSON.stringify([raw, process.env.SSO_HANDOFF_KID ?? "", prevRaw, prevKid]);
  if (publicJwksCache && publicJwksCache.fingerprint === fingerprint) {
    return publicJwksCache.keys;
  }
  const { publicJwk } = await getSignerMaterial();
  const keys: JWK[] = [publicJwk];
  if (prevRaw) {
    const prev = parseJwk(prevRaw, "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY");
    keys.push(await toPublicJwk(prev, prevKid));
  }
  publicJwksCache = { fingerprint, keys };
  return keys;
}

/**
 * The public JWK Set served at `GET /api/sso/jwks.json` — consumers verify
 * handoffs against this and hold no secret. `{ keys: [] }` when this
 * deployment issues no handoffs.
 */
export async function getSsoHandoffJwks(): Promise<{ keys: JWK[] }> {
  return { keys: await getLocalPublicJwks() };
}

// ---------------------------------------------------------------------------
// Issuer resolution
// ---------------------------------------------------------------------------

function issuerEnv(): string {
  const issuer = process.env.SSO_HANDOFF_ISSUER;
  if (!issuer) {
    throw new Error("SSO_HANDOFF_ISSUER is not configured");
  }
  return issuer;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * True when THIS deployment is the issuer named by `SSO_HANDOFF_ISSUER` — i.e.
 * a signing key is configured AND the issuer's origin is this deployment's
 * own origin (`BETTER_AUTH_URL`). Such a deployment verifies against its own
 * public key set rather than fetching its own JWKS over HTTP, so a
 * single-deployment or CI flow needs no network.
 */
export function isSsoHandoffSelfIssuer(): boolean {
  if (!isSsoHandoffSignerConfigured()) return false;
  const issuerOrigin = originOf(process.env.SSO_HANDOFF_ISSUER);
  const ownOrigin = originOf(process.env.BETTER_AUTH_URL);
  return issuerOrigin !== null && ownOrigin !== null && issuerOrigin === ownOrigin;
}

/**
 * The key resolver `jwtVerify` selects from by the token's `kid`:
 *   - self-issuer → a local JWK Set (current + optional previous key);
 *   - otherwise   → the issuer's published JWKS at
 *     `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json` (jose caches the document,
 *     refreshes it on an unknown `kid`, and rate-limits refetches with a
 *     cooldown, so a rotation on the primary is picked up automatically).
 */
async function getVerificationKeys(): Promise<JWTVerifyGetKey> {
  const issuer = issuerEnv();
  if (isSsoHandoffSelfIssuer()) {
    return createLocalJWKSet({ keys: await getLocalPublicJwks() });
  }
  if (originOf(issuer) === null) {
    throw new Error(
      "SSO_HANDOFF_ISSUER must be the issuer's origin URL (its JWKS is fetched from it)",
    );
  }
  const jwksUrl = new URL(SSO_HANDOFF_JWKS_PATH, issuer).toString();
  let remote = remoteJwksCache.get(jwksUrl);
  if (!remote) {
    remote = createRemoteJWKSet(new URL(jwksUrl), {
      // Tokens live ≤60s, so a stale key set is harmless well before this.
      cacheMaxAge: 5 * 60 * 1000,
      cooldownDuration: 30 * 1000,
      timeoutDuration: 5 * 1000,
    });
    remoteJwksCache.set(jwksUrl, remote);
  }
  return remote;
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Signs an SSO handoff JWT (EdDSA, `kid` = the published key id).
 *
 * Threat / contract:
 *   - Tokens are short-lived (max 60s, enforced by `clampSsoHandoffTtl` here
 *     AND by `maxTokenAge` on the verifier).
 *   - The `jti` MUST be persisted as a one-time nonce by the caller; this
 *     helper does not own nonce tracking so the persistence layer can
 *     atomically check-and-consume on the receiving side.
 *   - The `aud` claim MUST exactly match the target application's
 *     `sso_audience`; the consumer rejects mismatches.
 *   - Only a deployment holding `SSO_HANDOFF_PRIVATE_KEY` can sign; every
 *     other party (every satellite) holds public material only.
 */
export async function signSsoHandoff(input: SignSsoHandoffInput): Promise<string> {
  const issuer = issuerEnv();
  const { privateKey, kid } = await getSignerMaterial();
  const ttl = clampSsoHandoffTtl(input.ttlSeconds);

  return new SignJWT({ ...input.claims })
    .setProtectedHeader({ alg: JWT_ALG, kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(input.audience)
    .setSubject(input.betterAuthUserId)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);
}

export interface VerifySsoHandoffInput {
  token: string;
  expectedAudience: string;
}

export interface VerifiedSsoHandoff {
  payload: SsoHandoffClaims & { jti: string; sub: string; iat: number; exp: number };
}

/**
 * Verifies an SSO handoff JWT: EdDSA signature against the issuer's public
 * keys (selected by `kid`), `typ`, issuer, audience, expiry, and — review #61
 * — a receiver-side age ceiling (`maxTokenAge` = 60s), so a signer that failed
 * to clamp `exp` still cannot produce a long-lived token this side accepts.
 *
 * Returns the decoded, schema-validated payload on success. Throws on any
 * failure. Callers MUST then bind `targetApplicationId` to their own
 * application id and atomically mark the `jti` consumed (one-time nonce
 * contract).
 */
export async function verifySsoHandoff(input: VerifySsoHandoffInput): Promise<VerifiedSsoHandoff> {
  const issuer = issuerEnv();
  const keys = await getVerificationKeys();

  const { payload } = await jwtVerify(input.token, keys, {
    algorithms: [JWT_ALG],
    typ: "JWT",
    issuer,
    audience: input.expectedAudience,
    maxTokenAge: `${SSO_HANDOFF_MAX_TTL_SECONDS}s`,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });

  const parsed = handoffClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("SSO handoff token has an invalid or incomplete claim set");
  }

  // Validated above — the cast only bridges to JWTPayload's index signature.
  return { payload: parsed.data as VerifiedSsoHandoff["payload"] };
}
