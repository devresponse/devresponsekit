import "server-only";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const JWT_ALG = "HS256";

/**
 * Hard upper bound on SSO handoff token TTL in seconds.
 * Both the signer and any caller computing nonce expiries MUST clamp
 * to this value so the token cannot outlive the persisted nonce row.
 */
export const SSO_HANDOFF_MAX_TTL_SECONDS = 60;

/** Clamps a requested TTL into the allowed range `[1, SSO_HANDOFF_MAX_TTL_SECONDS]`. */
export function clampSsoHandoffTtl(ttlSeconds: number): number {
  return Math.min(Math.max(ttlSeconds, 1), SSO_HANDOFF_MAX_TTL_SECONDS);
}

export interface SsoHandoffClaims extends JWTPayload {
  email: string;
  organizationId: string;
  appUserId: string;
  targetApplicationId: string;
  locale: string;
  roles: string[];
}

export interface SignSsoHandoffInput {
  betterAuthUserId: string;
  audience: string;
  jti: string;
  ttlSeconds: number;
  claims: SsoHandoffClaims;
}

/**
 * Signs an SSO handoff JWT.
 *
 * Threat / contract:
 *   - Tokens are short-lived (max 60s, enforced by SSO_HANDOFF_TTL_SECONDS).
 *   - The `jti` MUST be persisted as a one-time nonce by the caller; this
 *     helper does not own nonce tracking so the persistence layer can
 *     atomically check-and-consume on the receiving side.
 *   - The `aud` claim MUST exactly match the target application's
 *     `sso_audience`; the consumer rejects mismatches.
 */
export async function signSsoHandoff(input: SignSsoHandoffInput): Promise<string> {
  const secretEnv = process.env.SSO_HANDOFF_JWT_SECRET;
  if (!secretEnv) {
    throw new Error("SSO_HANDOFF_JWT_SECRET is not configured");
  }
  const issuerEnv = process.env.SSO_HANDOFF_ISSUER;
  if (!issuerEnv) {
    throw new Error("SSO_HANDOFF_ISSUER is not configured");
  }

  const secret = new TextEncoder().encode(secretEnv);
  const ttl = clampSsoHandoffTtl(input.ttlSeconds);

  return new SignJWT({ ...input.claims })
    .setProtectedHeader({ alg: JWT_ALG, typ: "JWT" })
    .setIssuer(issuerEnv)
    .setAudience(input.audience)
    .setSubject(input.betterAuthUserId)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secret);
}

export interface VerifySsoHandoffInput {
  token: string;
  expectedAudience: string;
}

export interface VerifiedSsoHandoff {
  payload: SsoHandoffClaims & { jti: string; sub: string; iat: number; exp: number };
}

/**
 * Verifies an SSO handoff JWT signature, issuer, audience, and expiration.
 *
 * Returns the decoded payload on success. Throws on signature mismatch,
 * audience mismatch, or expiration. Callers MUST then atomically mark
 * the `jti` consumed (one-time nonce contract).
 */
export async function verifySsoHandoff(input: VerifySsoHandoffInput): Promise<VerifiedSsoHandoff> {
  const secretEnv = process.env.SSO_HANDOFF_JWT_SECRET;
  if (!secretEnv) {
    throw new Error("SSO_HANDOFF_JWT_SECRET is not configured");
  }
  const issuerEnv = process.env.SSO_HANDOFF_ISSUER;
  if (!issuerEnv) {
    throw new Error("SSO_HANDOFF_ISSUER is not configured");
  }

  const secret = new TextEncoder().encode(secretEnv);
  const { payload } = await jwtVerify(input.token, secret, {
    algorithms: [JWT_ALG],
    issuer: issuerEnv,
    audience: input.expectedAudience,
  });

  if (typeof payload.jti !== "string" || typeof payload.sub !== "string") {
    throw new Error("SSO handoff token is missing required jti/sub claims");
  }

  return { payload: payload as VerifiedSsoHandoff["payload"] };
}
