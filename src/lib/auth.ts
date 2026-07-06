import { betterAuth, type BetterAuthOptions, type GenericEndpointContext } from "better-auth";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { isSupportedLocale } from "@/config/i18n-config";
import { db, pgPool } from "@/db/database";
import { ssoSession } from "@/lib/auth-sso-session";
import { getServerEnv } from "@/lib/env";
import { SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social-providers";
import { getTrustedOrigins } from "@/lib/trusted-origins";

/**
 * Better Auth server instance.
 *
 * Uses Better Auth's built-in Kysely-backed PostgreSQL integration. We
 * pass the shared `pgPool` directly via the `database` option, so auth
 * storage and app storage share one connection pool (and one Kysely-
 * based abstraction) without introducing Prisma or Drizzle.
 *
 * Note: account linking, session lifetime, and social providers are
 * configured here. All env access goes through `getServerEnv()` so a
 * misconfigured deployment fails at boot instead of registering broken
 * providers — a social provider is only enabled when BOTH its client id
 * and secret are present.
 */
const env = getServerEnv();

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}
if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
  socialProviders.microsoft = {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    // Multi-tenant Entra ID work/school accounts.
    tenantId: "organizations",
    prompt: "select_account",
  };
}
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  };
}

/**
 * The social providers actually registered above — those with BOTH a client
 * id and secret present — in canonical display order. The sign-in and sign-up
 * pages read this so the UI only offers a provider whose OAuth flow can
 * actually complete; a button for an unconfigured provider would fail on
 * click. Derived from `socialProviders` so it can never drift from what Better
 * Auth received.
 */
export const enabledSocialProviders: SocialProvider[] = SOCIAL_PROVIDERS.filter(
  (provider) => provider in socialProviders,
);

export const auth = betterAuth({
  database: pgPool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  // Shared with the administrator origin guard; configured via
  // NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL / ADMIN_TRUSTED_ORIGINS.
  trustedOrigins: getTrustedOrigins(),

  // Better Auth rate-limits sensitive endpoints in production mode
  // (e.g. /sign-in/email at 3 req / 10 s per IP). Browser test suites
  // run against `next start` and sign in far faster than that from one
  // IP, so CI disables the limiter via this test-only env escape hatch.
  ...(env.AUTH_RATE_LIMIT_DISABLED ? { rateLimit: { enabled: false } } : {}),

  emailAndPassword: {
    enabled: true,
    // AUTH-4: block sign-in until the email address is verified. New email/
    // password sign-ups receive a verification link (see the `emailVerification`
    // block below); OAuth identities arrive pre-verified from a trusted provider
    // and are unaffected. Seed fixtures are marked verified by the seed script.
    // Per-org signup policy (0007): this global flag stays ON as the fail-closed
    // baseline; an org that waives verification gets its sign-ups pre-verified
    // by the `user.create.before` hook below, which satisfies this check.
    requireEmailVerification: true,
    // AUTH-2: revoke ALL of the user's sessions on a successful password
    // reset. A reset is the canonical "I think my account is compromised"
    // action, so it must also evict any attacker session — otherwise the
    // reset leaves the attacker signed in, defeating its purpose. (The
    // self-service change-password form already passes revokeOtherSessions.)
    // Better Auth honors this flag at runtime (deletes the user's sessions
    // after the reset) but does not yet expose it in its options type, so
    // the block is asserted to the option type — the same pattern the
    // admin-plugin wrappers use in auth-admin.server.ts.
    revokeSessionsOnPasswordReset: true,
    // Outbox-first delivery (specs.md §35): the email is rendered and
    // recorded in `app_outbox` even when no provider is configured, so
    // the forgot-password flow and the administrator "send reset email"
    // action are observable in every environment. Lazy import keeps the
    // email module out of the auth chain for tooling that only needs
    // the instance shape.
    sendResetPassword: async ({ user, url }) => {
      const { sendAppEmail } = await import("@/lib/email/send.server");
      await sendAppEmail({
        to: user.email,
        templateKey: "password_reset",
        variables: { name: user.name || user.email, resetUrl: url },
        relatedBetterAuthUserId: user.id,
      });
    },
  } as NonNullable<BetterAuthOptions["emailAndPassword"]>,

  // Email verification (AUTH-4). Better Auth sends the verification link on
  // sign-up and, together with `requireEmailVerification` above, blocks sign-in
  // until the address is confirmed. Delivery is outbox-first (specs.md §35),
  // mirroring `sendResetPassword`; the lazy import keeps the email module out of
  // the auth chain for tooling that only needs the instance shape. `url` is the
  // Better Auth verification link, carrying the sign-up `callbackURL` as its
  // post-verification destination.
  //
  // `autoSignInAfterVerification: false` — clicking the link confirms the
  // address but does NOT create a session; the link's `callbackURL` points at
  // the localized "email verified" confirmation page (verify-email/confirmed),
  // which then offers an explicit "proceed to login" step. This keeps
  // verification and sign-in as distinct, legible steps instead of dropping a
  // freshly-verified user straight onto a secure page.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      // Per-org signup policy (0007): the `user.create.before` hook below
      // pre-verifies sign-ups whose organization waives verification, but
      // `sendOnSignUp` fires unconditionally — skip the pointless (and
      // confusing) verification email for an already-verified address.
      if (user.emailVerified) {
        return;
      }
      const { sendAppEmail } = await import("@/lib/email/send.server");
      await sendAppEmail({
        to: user.email,
        templateKey: "email_verification",
        variables: { name: user.name || user.email, verifyUrl: url },
        relatedBetterAuthUserId: user.id,
      });
    },
  },

  socialProviders,

  account: {
    accountLinking: {
      enabled: true,
      // Only link accounts when the verified email matches; never link by
      // unverified email, since the alternate provider could lie about it.
      trustedProviders: ["google", "microsoft", "github"],
      allowDifferentEmails: false,
    },
  },

  session: {
    // 8-hour rolling session, refreshed every 15 minutes of activity.
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 15,
  },

  databaseHooks: {
    // AUTH-5: provision the app_users row at SIGN-UP (email/password), so a
    // self-registered account is visible in the admin Users list immediately —
    // even before it verifies its email. With `requireEmailVerification` a new
    // user gets NO session until they verify, so the `session.create` hook below
    // would never run and the account would be a "ghost" (present in Better
    // Auth, absent from `app_users`). This restores the pre-AUTH-4 behaviour.
    user: {
      create: {
        // Per-org signup policy (0007): when the organization that will
        // receive this sign-up waives email verification, pre-verify the
        // identity AT CREATION. The global `requireEmailVerification: true`
        // stays on (fail-closed) and passes naturally for these users; the
        // client form then signs them in immediately (sign-up itself never
        // starts a session while `requireEmailVerification` is set — see
        // better-auth's sign-up route, which decides from static options).
        // Scope: genuine email/password self-registrations only —
        // `shouldProvisionSelfSignup` excludes OAuth callbacks (verification
        // state belongs to the provider), admin/machine creation (which sets
        // `emailVerified` explicitly), and suppressed seed runs.
        before: async (user, context) => {
          const { shouldProvisionSelfSignup } = await import("@/lib/auth-signup-provisioning");
          if (!shouldProvisionSelfSignup(context)) {
            return;
          }
          // Invitation-backed sign-up (0008): presenting a live token for
          // THIS email proves mailbox access — the token was delivered to
          // that mailbox — so it carries the same weight as clicking a
          // verification link. Pre-verify regardless of the org's
          // verification policy. Any lookup failure falls through to the
          // policy path below (fail closed to the normal flow).
          const invitationToken = getInvitationToken(context);
          if (invitationToken) {
            try {
              const { findValidInvitationByToken } = await import("@/lib/invitations.server");
              const invitation = await findValidInvitationByToken(invitationToken);
              if (invitation && invitation.email === user.email.trim().toLowerCase()) {
                return { data: { emailVerified: true } };
              }
            } catch (error) {
              const { logServerError } = await import("@/lib/observability/logger.server");
              logServerError("invitation lookup failed in sign-up hook", { err: error });
            }
          }
          const { resolveSignupPolicy } = await import("@/lib/auth-policy.server");
          const policy = await resolveSignupPolicy({
            provider: "email",
            email: user.email,
            emailVerified: false,
          });
          if (policy.requireEmailVerification) {
            return;
          }
          return { data: { emailVerified: true } };
        },
        after: async (user, context) => {
          if (!context) {
            return;
          }
          // Provision only the email/password self-registration endpoint:
          //   - OAuth (`/callback/*`) gets a session immediately → the session
          //     hook below covers it (unchanged).
          //   - Admin / machine-API creation (`/admin/create-user`) provisions
          //     `app_users` itself (POST /api/administrator/users, /api/v1/users).
          //   - Seeds hit `/sign-up/email` too but provision themselves and
          //     suppress this hook (see auth-signup-provisioning).
          // `provisionUserFromAuth` is idempotent, so the session hook
          // re-running after the user later verifies + signs in is a no-op.
          const { shouldProvisionSelfSignup } = await import("@/lib/auth-signup-provisioning");
          if (!shouldProvisionSelfSignup(context)) {
            return;
          }
          const { provisionUserFromAuth } = await import("@/lib/user-provisioning.server");
          try {
            await provisionUserFromAuth({
              betterAuthUserId: user.id,
              email: user.email,
              emailVerified: user.emailVerified,
              displayName: user.name,
              provider: getProvisioningProvider(context),
              preferredLocale: getPreferredLocale(context),
              invitationToken: getInvitationToken(context),
            });
          } catch (error) {
            // Best-effort: a provisioning hiccup must never fail the sign-up
            // itself (the Better Auth user + verification email already exist).
            // The idempotent session hook re-provisions on the first sign-in.
            const { logServerError } = await import("@/lib/observability/logger.server");
            logServerError("sign-up app-user provisioning failed", {
              err: error,
              betterAuthUserId: user.id,
            });
          }
        },
      },
    },
    session: {
      create: {
        after: async (session, context) => {
          if (!context) {
            return;
          }

          const authUser = await context.context.internalAdapter.findUserById(session.userId);
          if (!authUser) {
            return;
          }

          // Record the login (every session creation is one login; refreshes
          // don't fire this hook) for the "daily logins" dashboard metrics.
          // Best-effort and lazily imported — it never blocks or breaks
          // sign-in. Runs for ALL logins, so it must precede the
          // existing-user early return below.
          const { recordSessionLogin } = await import("@/lib/auth-login-audit.server");
          await recordSessionLogin(
            authUser.id,
            context.request ? { headers: context.request.headers } : undefined,
          );

          const existing = await db
            .selectFrom("app_users")
            .select(["id", "status"])
            .where("better_auth_user_id", "=", authUser.id)
            .executeTakeFirst();

          if (existing) {
            // Per-org signup policy (0007): a still-pending account may now
            // qualify for activation — its org switched to `auto_active`, or
            // the address is now verified and matches an auto-approve domain
            // (a user who just confirmed their email re-signs-in here, since
            // verification no longer auto-creates a session).
            // Best-effort and fail-closed: on any error the user simply stays
            // pending and sign-in itself is never blocked.
            if (existing.status === "pending_approval") {
              try {
                const { reevaluatePendingActivation } =
                  await import("@/lib/user-provisioning.server");
                await reevaluatePendingActivation({
                  betterAuthUserId: authUser.id,
                  email: authUser.email,
                  emailVerified: authUser.emailVerified,
                  provider: getProvisioningProvider(context),
                });
              } catch (error) {
                const { logServerError } = await import("@/lib/observability/logger.server");
                logServerError("pending-activation re-evaluation failed", {
                  err: error,
                  betterAuthUserId: authUser.id,
                });
              }
            }
            return;
          }

          const { provisionUserFromAuth } = await import("@/lib/user-provisioning.server");

          await provisionUserFromAuth({
            betterAuthUserId: authUser.id,
            email: authUser.email,
            emailVerified: authUser.emailVerified,
            displayName: authUser.name,
            provider: getProvisioningProvider(context),
            preferredLocale: getPreferredLocale(context),
          });
        },
      },
    },
  },

  // The nextCookies plugin makes Better Auth set cookies via Next.js
  // server actions and route handlers correctly — it MUST stay last.
  plugins: [
    // `allowImpersonatingAdmins`: Better Auth otherwise refuses to impersonate
    // ANY user holding the `admin` role ("You cannot impersonate admins"),
    // which blocks a superadmin from impersonating an org admin — a legitimate
    // support action. We delegate the real policy to the impersonate route
    // (`/api/administrator/users/[id]/impersonate`), which gates on the app
    // RBAC `admin.users.impersonate` permission AND enforces a privilege-
    // escalation guard (a non-superadmin can never assume a session carrying a
    // permission they lack). That guard is finer-grained than Better Auth's
    // blanket block, so the block here only causes false negatives.
    admin({ allowImpersonatingAdmins: true }),
    ssoSession(),
    nextCookies(),
  ],
});

/** Convenience type for the resolved session shape. */
export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function getProvisioningProvider(
  context: GenericEndpointContext,
): "email" | "google" | "microsoft" | "github" {
  const path = context.path || context.request?.url || "";

  if (path.includes("/callback/google")) return "google";
  if (path.includes("/callback/microsoft")) return "microsoft";
  if (path.includes("/callback/github")) return "github";

  return "email";
}

/**
 * Extracts the invitation secret riding a sign-up request body (0008). The
 * extra field flows through better-auth's sign-up schema (which accepts a
 * record of additional fields) into `context.body`, same as `callbackURL`.
 */
function getInvitationToken(
  context: GenericEndpointContext | null | undefined,
): string | undefined {
  const token =
    context?.body && typeof context.body === "object" && "invitationToken" in context.body
      ? (context.body as Record<string, unknown>).invitationToken
      : undefined;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function getPreferredLocale(context: GenericEndpointContext): string | undefined {
  const callbackUrl =
    context.body && typeof context.body === "object" && "callbackURL" in context.body
      ? context.body.callbackURL
      : undefined;
  const referer = context.request?.headers.get("referer") ?? undefined;

  for (const candidate of [callbackUrl, referer]) {
    if (typeof candidate !== "string") {
      continue;
    }

    const locale = extractLocale(candidate);
    if (locale) {
      return locale;
    }
  }

  return undefined;
}

function extractLocale(candidate: string): string | undefined {
  // `candidate` comes from a request body / Referer header, so a
  // malformed URL must not throw inside the session-create hook.
  let path: string;
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    try {
      path = new URL(candidate).pathname;
    } catch {
      return undefined;
    }
  } else {
    path = candidate;
  }
  const locale = path.split("/").filter(Boolean)[0];

  return locale && isSupportedLocale(locale) ? locale : undefined;
}
