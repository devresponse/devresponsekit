import "server-only";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";
import { getUserAccessContext, decideSecureAccess } from "@/lib/auth-status";
import {
  signSsoHandoff,
  clampSsoHandoffTtl,
  type SsoHandoffClaims,
} from "@/lib/jwt-handoff.server";

export interface CreateSsoHandoffRedirectInput {
  applicationId: string;
  betterAuthUserId: string;
  request: NextRequest;
}

interface SsoAccessContext {
  appUserId: string;
  email: string;
  organizationId: string;
  locale: string;
  roles: string[];
}

/**
 * Loads the SSO access context required to sign a handoff token.
 *
 * This function is the authorization gate for SSO launches: it fails when
 * the user does not have an active membership or lacks access to the
 * target application. The caller MUST treat any thrown error as a 403.
 */
async function loadSsoAccessContext(
  betterAuthUserId: string,
  targetApp: { organization_id: string | null },
): Promise<SsoAccessContext> {
  const access = await getUserAccessContext(betterAuthUserId);
  const decision = decideSecureAccess(access.status, access.membershipStatus);
  if (decision !== "allow") {
    throw new Error(`sso_denied:${decision}`);
  }
  if (!access.appUserId || !access.organizationId || !access.primaryEmail) {
    throw new Error("sso_denied:missing_context");
  }

  // Look up roles assigned to this user inside the resolved organization.
  const roleRows = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .select(["r.key as key"])
    .where("ur.app_user_id", "=", access.appUserId)
    .where("ur.organization_id", "=", access.organizationId)
    .execute();

  // Verify access to the target application: either the application is
  // global (no organization_id) or it belongs to the user's organization.
  if (targetApp.organization_id && targetApp.organization_id !== access.organizationId) {
    throw new Error("sso_denied:application_not_in_organization");
  }

  return {
    appUserId: access.appUserId,
    email: access.primaryEmail,
    organizationId: access.organizationId,
    locale: access.preferredLocale,
    roles: roleRows.map((r) => r.key),
  };
}

/**
 * Creates a short-lived JWT handoff redirect URL for cross-subdomain SSO.
 *
 * Threat / contract:
 *   - JWT is at most 60 seconds and signed with `SSO_HANDOFF_JWT_SECRET`.
 *   - A one-time `jti` is persisted before signing so a replayed token
 *     can be detected by the consumer atomically.
 *   - The URL is returned to the route handler which then issues the
 *     redirect with `Referrer-Policy: no-referrer`.
 */
export async function createSsoHandoffRedirect(input: CreateSsoHandoffRedirectInput): Promise<URL> {
  const targetApp = await db
    .selectFrom("app_enterprise_applications")
    .selectAll()
    .where("id", "=", input.applicationId)
    .where("status", "=", "available")
    .executeTakeFirst();
  if (!targetApp) {
    throw new Error("sso_denied:application_unavailable");
  }

  const context = await loadSsoAccessContext(input.betterAuthUserId, targetApp);

  const ttlSeconds = clampSsoHandoffTtl(Number(process.env.SSO_HANDOFF_TTL_SECONDS ?? 60));
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Opportunistically purge long-expired nonces so the table does not
  // grow without bound; tokens live <= 60s, so anything expired for
  // over an hour can never be consumed again.
  await db
    .deleteFrom("app_sso_handoff_nonces")
    .where("expires_at", "<", new Date(Date.now() - 60 * 60 * 1000))
    .execute();

  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti,
      app_user_id: context.appUserId,
      target_application_id: input.applicationId,
      expires_at: expiresAt,
    })
    .execute();

  const claims: SsoHandoffClaims = {
    email: context.email,
    organizationId: context.organizationId,
    appUserId: context.appUserId,
    targetApplicationId: input.applicationId,
    locale: context.locale,
    roles: context.roles,
  };

  const token = await signSsoHandoff({
    betterAuthUserId: input.betterAuthUserId,
    audience: targetApp.sso_audience,
    jti,
    ttlSeconds,
    claims,
  });

  const redirectUrl = new URL("/api/sso/consume", targetApp.origin);
  redirectUrl.searchParams.set("token", token);
  return redirectUrl;
}

/**
 * Atomically consumes a handoff `jti`, returning true exactly once per token.
 *
 * The burn is predicated on `targetApplicationId` as well as `jti` (review
 * #15): the nonce row records which app the launch was FOR, so a consumer
 * can only spend nonces minted for its own application id — even if two
 * registered apps were to share an `sso_audience`.
 */
export async function consumeSsoHandoffNonce(
  jti: string,
  targetApplicationId: string,
): Promise<boolean> {
  const result = await db
    .updateTable("app_sso_handoff_nonces")
    .set({ consumed_at: new Date() })
    .where("jti", "=", jti)
    .where("target_application_id", "=", targetApplicationId)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .returning(["jti"])
    .executeTakeFirst();

  return Boolean(result);
}
