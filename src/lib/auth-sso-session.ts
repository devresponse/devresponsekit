import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";

/**
 * Server-only Better Auth plugin that lets the SSO consume route
 * (`/api/sso/consume`) establish a real Better Auth session for a user
 * whose identity was just proven by a verified, single-use handoff JWT
 * (specs.md §22).
 *
 * Threat / contract:
 *   - `metadata.SERVER_ONLY: true` means better-call NEVER mounts this
 *     endpoint on the HTTP router — it is exclusively callable through
 *     `auth.api.createSsoSession(...)` from server code. There is no
 *     URL that reaches it.
 *   - The caller MUST have verified the handoff token AND consumed its
 *     nonce atomically BEFORE calling this. This endpoint only re-checks
 *     user-level state (exists, not banned) — it cannot see the token.
 *   - Any truthy `banned` flag rejects (403), even when a temporary ban's
 *     `banExpires` has already elapsed — unlike Better Auth's own sign-in
 *     and `isBetterAuthUserBanned` (ban-status.server.ts), which treat an
 *     elapsed expiry as not-banned. Such a user must sign in normally so
 *     Better Auth's hook clears the stale flag (review #126).
 *   - The session cookie is signed and set through Better Auth's own
 *     `setSessionCookie`, so attributes (httpOnly, secure, sameSite,
 *     maxAge) stay consistent with every other sign-in path.
 */
export const ssoSession = () => {
  return {
    id: "sso-session",
    endpoints: {
      createSsoSession: createAuthEndpoint(
        "/sso-session/create",
        {
          method: "POST",
          body: z.object({
            userId: z.string().min(1),
          }),
          metadata: {
            SERVER_ONLY: true,
          },
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: "unknown user" });
          }
          const banned = (user as { banned?: boolean | null }).banned;
          if (banned) {
            throw new APIError("FORBIDDEN", { message: "user is banned" });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed to create session" });
          }
          await setSessionCookie(ctx, { session, user });

          return ctx.json({ ok: true as const });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
