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
const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 chars"),
    BETTER_AUTH_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    DATABASE_TEST_URL: z.string().optional(),
    /**
     * Schema every table is deployed into (app tables + Better Auth tables).
     * Applied at the connection level via `search_path` (see
     * `src/db/schema-config.ts`). Must be a plain SQL identifier — it is
     * interpolated into DDL. Default `auth`; set a different value per
     * deployment to isolate applications by schema.
     */
    DB_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i, "DB_SCHEMA must be a plain SQL identifier")
      .default("auth"),
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
    /**
     * Outbound email delivery provider. Unset = no delivery: every email
     * is still rendered and recorded in `app_outbox` with status `logged`
     * (specs.md §35), which is the right mode for local dev and CI.
     */
    EMAIL_PROVIDER: z.enum(["resend", "mailgun"]).optional(),
    /** From header for outbound email, e.g. `App <no-reply@example.com>`. */
    EMAIL_FROM: z.string().default("DevResponse <no-reply@localhost>"),
    RESEND_API_KEY: z.string().optional(),
    MAILGUN_API_KEY: z.string().optional(),
    MAILGUN_DOMAIN: z.string().optional(),
    /** Override for the EU region: https://api.eu.mailgun.net */
    MAILGUN_BASE_URL: z.url().default("https://api.mailgun.net"),
    /**
     * Test-only escape hatch ("1"/"true"): disables Better Auth's built-in
     * rate limiter, which production mode applies to sensitive endpoints
     * (e.g. /sign-in/email at 3 req / 10 s per IP). Browser suites sign in
     * far faster than that from one IP against `next start`, so the CI
     * browser job sets it. Never set on a real deployment.
     */
    AUTH_RATE_LIMIT_DISABLED: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /* ----------------------------------------------------------------- */
    /*  Machine credentials (design docs/design-api-keys-and-tokens.md)  */
    /* ----------------------------------------------------------------- */
    /** Master switch for the API-key credential path. */
    API_KEYS_ENABLED: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /** Stamped into the key prefix: `drk_<tag>_…`. */
    API_KEY_ENV_TAG: z.enum(["live", "test"]).default("live"),
    /** Default key lifetime in days; unset = no default expiry (UI warns). */
    API_KEY_DEFAULT_TTL_DAYS: z.coerce.number().int().positive().optional(),
    /** Master switch for JWT access tokens + JWKS. */
    API_JWT_ENABLED: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /** JWT `iss`; defaults to BETTER_AUTH_URL when unset. */
    API_JWT_ISSUER: z.string().optional(),
    /** JWT `aud`. */
    API_JWT_AUDIENCE: z.string().default("devresponse-api"),
    /** Ed25519 private key as a JSON-encoded JWK (contains `d`). */
    API_JWT_PRIVATE_KEY: z.string().optional(),
    /** Optional explicit key id; defaults to the JWK thumbprint. */
    API_JWT_KID: z.string().optional(),
    /** Access-token lifetime in seconds (≤ 1 hour). */
    API_JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    SEED_ADMIN_EMAIL: z.string().email().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
    SEED_DEFAULT_ORGANIZATION_SLUG: z.string().default("default"),
    /* ----------------------------------------------------------------- */
    /*  Documentation viewer (src/app/[locale]/(secure)/app/docs)        */
    /* ----------------------------------------------------------------- */
    /** Source backend for documents. Phase 1 supports `filesystem` only. */
    DOCS_SOURCE: z.enum(["filesystem"]).default("filesystem"),
    /**
     * Absolute or cwd-relative path to the document root. Defaults to the
     * repo's `docs/` folder. The safe-path resolver canonicalizes this and
     * confines every slug to stay inside it.
     */
    DOCS_ROOT: z.string().optional(),
    /**
     * Gates full MDX evaluation (executing author JS). OFF by default and
     * only ever safe for the trusted filesystem source — never for an
     * external/CMS source. Phase 1 ignores it (MDX renders as Markdown).
     */
    DOCS_ALLOW_MDX_EXECUTION: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /** When false, documents marked `visibility: internal` never render. */
    DOCS_INTERNAL_VISIBLE: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
  })
  .superRefine((env, ctx) => {
    // A configured provider without its credentials should fail at boot,
    // not at first send.
    if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required for resend" });
    }
    if (env.EMAIL_PROVIDER === "mailgun" && !env.MAILGUN_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["MAILGUN_API_KEY"], message: "required for mailgun" });
    }
    if (env.EMAIL_PROVIDER === "mailgun" && !env.MAILGUN_DOMAIN) {
      ctx.addIssue({ code: "custom", path: ["MAILGUN_DOMAIN"], message: "required for mailgun" });
    }
    // JWT access tokens require a signing key (and issuer) to be present
    // at boot rather than failing on the first token mint.
    if (env.API_JWT_ENABLED && !env.API_JWT_PRIVATE_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["API_JWT_PRIVATE_KEY"],
        message: "required when API_JWT_ENABLED",
      });
    }
    // Production hardening (AUTH-5): the rate-limit kill switch disables
    // Better Auth's sign-in brute-force protection. It exists only for
    // test/CI suites that sign in faster than the per-IP limiter allows.
    // Refuse it in a real production deployment so it can never silently
    // weaken auth. CI is still permitted: the browser job runs `next start`
    // (NODE_ENV=production) and sets CI=true, which is the legitimate case.
    if (env.AUTH_RATE_LIMIT_DISABLED && env.NODE_ENV === "production" && !process.env.CI) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_RATE_LIMIT_DISABLED"],
        message:
          "must not be enabled in a production deployment (it disables sign-in rate limiting); permitted only outside production or in CI",
      });
    }
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
  // The genuine Next.js production *build* always sets this — and never the
  // running server (which is `phase-production-server`). Always safe to honor.
  if (process.env.NEXT_PHASE === "phase-production-build") return true;
  // SKIP_ENV_VALIDATION is an escape hatch for non-Next build harnesses
  // (Docker layers, codegen scripts). It must NEVER mask missing/invalid
  // secrets in a real production *runtime*, or the server would silently boot
  // on placeholder auth secrets. Honor it only outside production (OPS-6).
  if (process.env.SKIP_ENV_VALIDATION && process.env.NODE_ENV !== "production") return true;
  return false;
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
