import "server-only";
import { getCurrentSession } from "@/lib/auth-guard";
import { getUserAccessContext, type UserAccessContext } from "@/lib/auth-status";
import { getServerEnv } from "@/lib/env";
import { getClientIp } from "@/lib/client-ip";
import { looksLikeApiKey } from "@/lib/api-auth/api-key";
import { touchApiKeyUsage, verifyApiKey } from "@/lib/api-auth/api-keys.server";
import { isBetterAuthUserBanned } from "@/lib/api-auth/ban-status.server";
import { verifyAccessToken } from "@/lib/api-auth/jwt.server";
import { isJtiRevoked } from "@/lib/api-auth/revocation.server";

/**
 * Unified caller resolution (design docs/design-api-keys-and-tokens.md
 * §3) — the single entry point that understands every credential type and
 * returns a normalized principal. Authorization decisions are made by the
 * guards (`requireAdminPermission`, `requireAccountUser`) against the
 * returned `access` context, exactly as they were for cookies alone.
 *
 * Resolution order (first match wins):
 *   1. `Authorization: Bearer drk_…`  → API key (hash lookup).
 *   2. `Authorization: Bearer eyJ…`   → JWT (JWKS verify + jti revocation).
 *   3. Session cookie                 → existing getCurrentSession().
 */

export type CallerKind = "session" | "api_key" | "jwt";

export interface ResolvedCaller {
  kind: CallerKind;
  /** Principal identity (Better Auth user id). */
  betterAuthUserId: string;
  /** Same shape cookies produce today — the basis for every authz check. */
  access: UserAccessContext;
  /**
   * Scopes carried by the credential, intersected against the principal's
   * permissions by the guard. `null` for cookies (full user authority);
   * always an explicit array for bearer credentials.
   */
  grantedScopes: string[] | null;
  /** Non-ambient credential → CSRF/origin guard is not applicable. */
  isBearer: boolean;
  /** api_key id / jwt jti, for audit + per-credential rate limiting. */
  credentialId: string | null;
}

/** Extracts the `Bearer` token (if any) from the Authorization header. */
export function readBearerToken(headers: Headers): string | null {
  const header = headers.get("authorization") ?? headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

/** True when the request presents a bearer credential (cheap, header-only). */
export function hasBearerCredential(headers: Headers): boolean {
  return readBearerToken(headers) !== null;
}

function clientIp(headers: Headers): string | null {
  // P2-4: derive from a trusted proxy hop, not the spoofable leftmost XFF.
  return getClientIp(headers);
}

/**
 * Resolves the caller from credentials, or returns null when none
 * resolve. Status/membership and permission/scope checks are the guard's
 * responsibility — this function only answers "who is this?".
 */
export async function resolveCaller(request: { headers: Headers }): Promise<ResolvedCaller | null> {
  const env = getServerEnv();
  const token = readBearerToken(request.headers);

  if (token) {
    // ---- API key path -------------------------------------------------
    if (looksLikeApiKey(token)) {
      if (!env.API_KEYS_ENABLED) return null;
      const verified = await verifyApiKey(token);
      if (!verified) return null;
      // A Better Auth ban revokes browser sessions but does NOT touch
      // app_users.status, which is all getUserAccessContext reads — so an
      // API key would otherwise keep authenticating after its owner is
      // banned. Deny here, at the single resolution chokepoint (AUTH-1).
      if (await isBetterAuthUserBanned(verified.betterAuthUserId)) return null;
      const access = await getUserAccessContext(verified.betterAuthUserId);
      // Best-effort usage stamp; never blocks or breaks auth.
      touchApiKeyUsage(verified.id, clientIp(request.headers));
      return {
        kind: "api_key",
        betterAuthUserId: verified.betterAuthUserId,
        access,
        grantedScopes: verified.scopes,
        isBearer: true,
        credentialId: verified.id,
      };
    }

    // ---- JWT path -----------------------------------------------------
    if (env.API_JWT_ENABLED) {
      try {
        const verified = await verifyAccessToken(token);
        if (await isJtiRevoked(verified.jti)) return null;
        // Same as the API-key path: a banned owner's still-valid, non-revoked
        // access token must stop authenticating immediately (AUTH-1).
        if (await isBetterAuthUserBanned(verified.subject)) return null;
        const access = await getUserAccessContext(verified.subject);
        return {
          kind: "jwt",
          betterAuthUserId: verified.subject,
          access,
          grantedScopes: verified.scopes,
          isBearer: true,
          credentialId: verified.jti,
        };
      } catch {
        // Invalid / expired / wrong-audience token → unauthenticated.
        return null;
      }
    }

    // A bearer token was presented but no matching path is enabled.
    return null;
  }

  // ---- Cookie session path -------------------------------------------
  const session = await getCurrentSession();
  if (!session) return null;
  const access = await getUserAccessContext(session.user.id);
  return {
    kind: "session",
    betterAuthUserId: session.user.id,
    access,
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
  };
}
