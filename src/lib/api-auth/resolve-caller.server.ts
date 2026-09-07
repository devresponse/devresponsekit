import "server-only";
import { getCurrentSession } from "@/lib/auth-guard";
import { getUserAccessContext, type UserAccessContext } from "@/lib/auth-status";
import { getServerEnv } from "@/lib/env";
import { getClientIp } from "@/lib/client-ip";
import { readImpersonatorId } from "@/lib/impersonation";
import { looksLikeApiKey } from "@/lib/api-auth/api-key";
import { touchApiKeyUsage, verifyApiKey } from "@/lib/api-auth/api-keys.server";
import { isBetterAuthUserBanned } from "@/lib/api-auth/ban-status.server";
import {
  AccessTokenAudienceError,
  verifyAccessToken,
  type TokenCredentialRef,
} from "@/lib/api-auth/jwt.server";
import { isSourceCredentialActive } from "@/lib/api-auth/revocation.server";

/**
 * Unified caller resolution (design docs/design-api-keys-and-tokens.md
 * §3) — the single entry point that understands every credential type and
 * returns a normalized principal. Authorization decisions are made by the
 * guards (`requireAdminPermission`, `requireAccountUser`) against the
 * returned `access` context, exactly as they were for cookies alone.
 *
 * Resolution order (first match wins):
 *   1. `Authorization: Bearer drk_…`  → API key (hash lookup).
 *   2. `Authorization: Bearer eyJ…`   → JWT (JWKS verify + audience + source
 *                                        credential still active).
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
  /**
   * The org the BEARER credential is bound to — `app_api_keys.organization_id`
   * or the JWT `org` claim — before {@link getUserAccessContext} resolves it
   * against the principal's memberships. `null` for an org-less credential
   * and for cookie sessions.
   *
   * Distinct from `access.organizationId`, which is null when the principal
   * holds no membership in the bound org (the fail-closed case). The MCP
   * gateway re-mints this value into the token it hands its own self-call
   * (review #207), so it MUST be the credential's binding: re-deriving it
   * from `access` would turn "bound to an org I am not a member of" into
   * "bound to nothing", and the downstream fallback would then act in the
   * principal's earliest org instead of denying.
   */
  boundOrganizationId: string | null;
  /**
   * The ORIGINAL actor's id when the cookie session is an impersonation
   * session (admin plugin `impersonatedBy`), else `null`. Always `null` for
   * bearer credentials — a minted key/token is never an impersonation.
   * Surfaced here so a guard consumer (e.g. the active-org switch, P0-1) can
   * refuse impersonated sessions without a second session lookup (review #28).
   */
  impersonatorId: string | null;
  /**
   * The verified token's own claims, for `kind === "jwt"` only. The MCP
   * gateway uses these to exchange an MCP-audience token for a v1-audience
   * one when it calls the v1 API on the agent's behalf (review #50/#53).
   */
  jwt?: {
    organizationId: string | null;
    expiresAt: Date;
    audience: string[];
    credential: TokenCredentialRef | null;
  };
}

/**
 * Why a presented credential did NOT resolve. Guards map these to distinct
 * error codes where a client can act on the difference (review #43, #50):
 *   - `credential_revoked` — stop retrying with this token AND stop minting
 *     from its key/client; it has been revoked or rotated.
 *   - `audience_mismatch`  — the token is fine but minted for another
 *     resource; re-request it with the right `resource`.
 * Everything else is a generic 401.
 */
export type CallerRejectReason =
  | "no_credential"
  | "path_disabled"
  | "invalid_credential"
  | "audience_mismatch"
  | "credential_revoked"
  | "principal_banned";

export type CallerResolution =
  { ok: true; caller: ResolvedCaller } | { ok: false; reason: CallerRejectReason };

export interface ResolveCallerOptions {
  /**
   * Audience(s) a JWT must carry to be accepted by THIS resource. Defaults
   * to the v1 machine-API audience (`API_JWT_AUDIENCE`); `/api/mcp` passes
   * its own resource identifier. Ignored for API keys and cookies.
   */
  expectedAudience?: string | string[];
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
 * responsibility — this function only answers "who is this?". Use
 * {@link resolveCallerDetailed} where the rejection reason matters.
 */
export async function resolveCaller(
  request: { headers: Headers },
  options: ResolveCallerOptions = {},
): Promise<ResolvedCaller | null> {
  const result = await resolveCallerDetailed(request, options);
  return result.ok ? result.caller : null;
}

/** {@link resolveCaller} with the rejection reason surfaced. */
export async function resolveCallerDetailed(
  request: { headers: Headers },
  options: ResolveCallerOptions = {},
): Promise<CallerResolution> {
  const env = getServerEnv();
  const token = readBearerToken(request.headers);

  if (token) {
    // ---- API key path -------------------------------------------------
    if (looksLikeApiKey(token)) {
      if (!env.API_KEYS_ENABLED) return reject("path_disabled");
      const verified = await verifyApiKey(token);
      if (!verified) return reject("invalid_credential");
      // A Better Auth ban revokes browser sessions but does NOT touch
      // app_users.status, which is all getUserAccessContext reads — so an
      // API key would otherwise keep authenticating after its owner is
      // banned. Deny here, at the single resolution chokepoint (AUTH-1).
      if (await isBetterAuthUserBanned(verified.betterAuthUserId)) {
        return reject("principal_banned");
      }
      // Resolve against the org the key is BOUND to, not the active_org
      // cookie, so a credential always acts in its minted tenant (MACHINE-1).
      const access = await getUserAccessContext(verified.betterAuthUserId, {
        organizationId: verified.organizationId,
      });
      // Best-effort usage stamp; never blocks or breaks auth.
      touchApiKeyUsage(verified.id, clientIp(request.headers));
      return {
        ok: true,
        caller: {
          kind: "api_key",
          betterAuthUserId: verified.betterAuthUserId,
          access,
          grantedScopes: verified.scopes,
          isBearer: true,
          credentialId: verified.id,
          boundOrganizationId: verified.organizationId,
          impersonatorId: null,
        },
      };
    }

    // ---- JWT path -----------------------------------------------------
    if (env.API_JWT_ENABLED) {
      let verified;
      try {
        verified = await verifyAccessToken(token, { expectedAudience: options.expectedAudience });
      } catch (error) {
        // A signature-valid token for ANOTHER resource is reported apart from
        // garbage / expired tokens so the resource can say which `resource`
        // to request (review #50/#53); everything else is unauthenticated.
        return reject(
          error instanceof AccessTokenAudienceError ? "audience_mismatch" : "invalid_credential",
        );
      }
      // The credential the token was minted from must still be active: a
      // revoked or rotated key / client retires its outstanding tokens
      // immediately instead of at `exp` (review #43). One PK read. A legacy
      // token minted before the `cid` claim existed has none; it is honoured
      // until it expires (≤ API_JWT_ACCESS_TTL_SECONDS after the deploy) —
      // the window closes on its own and cannot be re-opened.
      if (
        verified.credential &&
        !(await isSourceCredentialActive(verified.credential, verified.issuedAt))
      ) {
        return reject("credential_revoked");
      }
      // Same as the API-key path: a banned owner's still-valid access token
      // must stop authenticating immediately (AUTH-1).
      if (await isBetterAuthUserBanned(verified.subject)) return reject("principal_banned");
      // The token's `org` claim is the bound tenant; ignore the cookie
      // (MACHINE-1).
      const access = await getUserAccessContext(verified.subject, {
        organizationId: verified.organizationId,
      });
      return {
        ok: true,
        caller: {
          kind: "jwt",
          betterAuthUserId: verified.subject,
          access,
          grantedScopes: verified.scopes,
          isBearer: true,
          credentialId: verified.jti,
          boundOrganizationId: verified.organizationId,
          impersonatorId: null,
          jwt: {
            organizationId: verified.organizationId,
            expiresAt: verified.expiresAt,
            audience: verified.audience,
            credential: verified.credential,
          },
        },
      };
    }

    // A bearer token was presented but no matching path is enabled.
    return reject("path_disabled");
  }

  // ---- Cookie session path -------------------------------------------
  const session = await getCurrentSession();
  if (!session) return reject("no_credential");
  const access = await getUserAccessContext(session.user.id);
  return {
    ok: true,
    caller: {
      kind: "session",
      betterAuthUserId: session.user.id,
      access,
      grantedScopes: null,
      isBearer: false,
      credentialId: null,
      boundOrganizationId: null,
      impersonatorId: readImpersonatorId(session),
    },
  };
}

function reject(reason: CallerRejectReason): CallerResolution {
  return { ok: false, reason };
}
