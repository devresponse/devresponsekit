import { z } from "zod";

/**
 * Server-side environment variable schema.
 *
 * Validates required variables once at module load. Production builds will
 * fail loudly if a required variable is missing. Public (NEXT_PUBLIC_*)
 * values are intentionally accessed via `process.env` directly elsewhere
 * because Next.js inlines them at build time.
 *
 * This module intentionally does NOT import the `server-only` sentinel:
 * it must stay importable from `tsx` scripts (migrations, seeds) where
 * that package cannot resolve. The runtime guard below provides the
 * equivalent protection against accidental client-side use.
 */
if (typeof window !== "undefined") {
  throw new Error("env.ts must never be imported from client-side code");
}
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 chars"),
  BETTER_AUTH_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_TEST_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  MICROSOFT_CLIENT_ID: z.string().optional().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().optional().default(""),
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  SSO_HANDOFF_ISSUER: z.string().min(1),
  SSO_HANDOFF_AUDIENCE_PREFIX: z.string().min(1),
  SSO_HANDOFF_JWT_SECRET: z.string().min(16, "SSO_HANDOFF_JWT_SECRET must be at least 16 chars"),
  SSO_HANDOFF_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60),
  /** Identifier of THIS deployment when consuming SSO handoffs. */
  SSO_HANDOFF_APPLICATION_ID: z.string().min(1).optional(),
  /**
   * Comma-separated list of additional trusted origins shared by Better
   * Auth's `trustedOrigins` and the administrator origin guard.
   */
  ADMIN_TRUSTED_ORIGINS: z.string().optional(),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_DEFAULT_ORGANIZATION_SLUG: z.string().default("default"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * `next build` evaluates server modules while collecting page data, and
 * CI/preview builders (e.g. Vercel) typically have no runtime secrets
 * configured. In that phase we substitute placeholders instead of
 * failing the build — the instances constructed with them are discarded
 * after collection, and the strict parse re-runs at real server boot.
 * `SKIP_ENV_VALIDATION` covers non-Next build harnesses (Docker, CI).
 */
function isBuildPhase(): boolean {
  return (
    process.env.NEXT_PHASE === "phase-production-build" || Boolean(process.env.SKIP_ENV_VALIDATION)
  );
}

function buildPhasePlaceholders(): ServerEnv {
  return serverEnvSchema.parse({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "build-placeholder-secret-0000",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://build:build@localhost:5432/build",
    SSO_HANDOFF_ISSUER: "build-placeholder",
    SSO_HANDOFF_AUDIENCE_PREFIX: "build-placeholder",
    SSO_HANDOFF_JWT_SECRET: "build-placeholder-secret-0000",
  });
}

/**
 * Returns the parsed and validated server environment.
 *
 * Throws on first access if any required variable is missing or invalid.
 * Cached after the first successful parse.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    if (isBuildPhase()) {
      // Intentionally NOT cached: only the build worker should ever see
      // placeholder values.
      return buildPhasePlaceholders();
    }
    // Do not echo secrets back; only emit which keys were invalid.
    const invalidKeys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid server environment variables: ${invalidKeys}`);
  }
  cached = parsed.data;
  return cached;
}
