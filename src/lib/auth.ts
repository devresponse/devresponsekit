import { betterAuth, type BetterAuthOptions, type GenericEndpointContext } from "better-auth";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { isSupportedLocale } from "@/config/i18n-config";
import { db, pgPool } from "@/db/database";
import { ssoSession } from "@/lib/auth-sso-session";
import { getServerEnv } from "@/lib/env";
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
    requireEmailVerification: false,
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
            .select(["id"])
            .where("better_auth_user_id", "=", authUser.id)
            .executeTakeFirst();

          if (existing) {
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
