import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { nextCookies } from "better-auth/next-js";

/**
 * Better Auth server instance.
 *
 * Uses Better Auth's built-in Kysely-backed PostgreSQL integration. We
 * pass the `pg` Pool directly via the `database` option, which keeps the
 * project on a single Kysely-based database abstraction without
 * introducing Prisma or Drizzle.
 *
 * Note: account linking, session lifetime, and social providers are
 * configured here; OAuth secrets are read from validated env vars.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  trustedOrigins: [
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    "https://app.devresponse.com",
  ],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      // Multi-tenant Entra ID work/school accounts.
      tenantId: "organizations",
      prompt: "select_account",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  },

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

  // The nextCookies plugin makes Better Auth set cookies via Next.js
  // server actions and route handlers correctly.
  plugins: [nextCookies()],
});

/** Convenience type for the resolved session shape. */
export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
