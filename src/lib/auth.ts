import { betterAuth, type BetterAuthOptions, type GenericEndpointContext } from "better-auth";
import { admin } from "better-auth/plugins";
import { Pool } from "pg";
import { nextCookies } from "better-auth/next-js";
import { isSupportedLocale } from "@/config/i18n-config";
import { db } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { getTrustedOrigins } from "@/lib/trusted-origins";

/**
 * Better Auth server instance.
 *
 * Uses Better Auth's built-in Kysely-backed PostgreSQL integration. We
 * pass the `pg` Pool directly via the `database` option, which keeps the
 * project on a single Kysely-based database abstraction without
 * introducing Prisma or Drizzle.
 *
 * Note: account linking, session lifetime, and social providers are
 * configured here. All env access goes through `getServerEnv()` so a
 * misconfigured deployment fails at boot instead of registering broken
 * providers — a social provider is only enabled when BOTH its client id
 * and secret are present.
 */
const env = getServerEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

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
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  // Shared with the administrator origin guard; configured via
  // NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL / ADMIN_TRUSTED_ORIGINS.
  trustedOrigins: getTrustedOrigins(),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
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
  // server actions and route handlers correctly.
  plugins: [admin(), nextCookies()],
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
  const path =
    candidate.startsWith("http://") || candidate.startsWith("https://")
      ? new URL(candidate).pathname
      : candidate;
  const locale = path.split("/").filter(Boolean)[0];

  return locale && isSupportedLocale(locale) ? locale : undefined;
}
