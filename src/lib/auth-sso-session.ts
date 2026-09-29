import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { isBanActive } from "@/lib/ban-status";

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
 *   - That flag is vendor metadata, honoured only because better-auth copies
 *     `options` through to better-call's router, and a bump of either could
 *     drop it (F-81). The handler therefore refuses, with the same 404 an
 *     unmounted route gives, any call that arrives with `ctx.request`: the
 *     router sets it from the incoming `Request`, and a server-side
 *     `auth.api.*` call (the consume route passes `headers`) never carries
 *     one — the same test `rejectClosedAuthEndpoints` applies. Without it,
 *     a mounted `POST /api/auth/sso-session/create {"userId": …}` would be an
 *     unauthenticated sign-in as any user.
 *   - The caller MUST have verified the handoff token AND consumed its
 *     nonce atomically BEFORE calling this. This endpoint only re-checks
 *     user-level state (exists, not banned) — it cannot see the token.
 *   - A CURRENTLY banned user is rejected (403) through the very same
 *     predicate the machine-API paths use (`isBanActive`, review #126), so an
 *     elapsed `banExpires` is honoured here exactly as Better Auth's own
 *     sign-in and `isBetterAuthUserBanned` honour it: a lapsed temporary ban
 *     no longer blocks the handoff, while an indefinite ban (or one that is
 *     still running, or one whose expiry is unparseable) always does.
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
          // F-81: server-only in fact, not just in vendor metadata (above).
          if (ctx.request) {
            throw new APIError("NOT_FOUND");
          }
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: "unknown user" });
          }
          if (isBanActive(user as { banned?: boolean | null; banExpires?: Date | string | null })) {
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
