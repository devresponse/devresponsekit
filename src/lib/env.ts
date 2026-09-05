import { z } from "zod";
import { invalidOriginSuffixes, splitOriginSuffixList } from "@/lib/admin/origin-suffixes";

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
/**
 * The obvious signing-secret placeholders shipped in `.env.example`. A
 * deployment that copies the example file without replacing them must fail
 * closed in production rather than boot on a publicly-known secret. (audit #12)
 */
const EXAMPLE_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "replace-with-strong-random-secret",
]);

/**
 * An OPTIONAL Ed25519 private JWK (JSON string). Unset or empty ⇒ `undefined`;
 * when a value IS present it must parse as an OKP/Ed25519 JWK carrying the
 * private `d` member, so a truncated or wrong-type key fails at boot rather
 * than on the first SSO launch (review #5).
 */
function optionalEd25519PrivateJwk(name: string) {
  return z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine(
      (value) => {
        if (value === undefined) return true;
        try {
          const jwk = JSON.parse(value) as Record<string, unknown> | null;
          return (
            !!jwk &&
            typeof jwk === "object" &&
            jwk.kty === "OKP" &&
            jwk.crv === "Ed25519" &&
            typeof jwk.x === "string" &&
            typeof jwk.d === "string"
          );
        } catch {
          return false;
        }
      },
      { message: `${name} must be a JSON-encoded Ed25519 private JWK (kty OKP, crv Ed25519, d)` },
    );
}

/**
 * An OPTIONAL operator-chosen shared secret (cron / scrape tokens). Unset or
 * empty ⇒ `undefined`, so the consuming route keeps failing closed; when a
 * value IS present it must be at least {@link OPERATOR_SECRET_MIN_LENGTH}
 * chars — a short guessable token must fail at boot, not be accepted
 * silently (review #92/#222).
 */
const OPERATOR_SECRET_MIN_LENGTH = 32;
function operatorSecret(name: string) {
  return z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || value.length >= OPERATOR_SECRET_MIN_LENGTH, {
      message: `${name} must be at least ${OPERATOR_SECRET_MIN_LENGTH} chars when set`,
    });
}

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 chars"),
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
    /**
     * PostgreSQL RUNTIME-pool sizing + timeouts (src/db/database.ts). Coerced
     * and bounded here so a non-numeric value fails fast at boot instead of
     * silently becoming `NaN` and being handed to `pg` (P2-12). database.ts
     * also reads them defensively via {@link intFromEnv} — it is imported by
     * env-poor cron scripts (outbox:drain, db:prune) that must NOT require the
     * full schema — with the SAME defaults. Keep the two in sync.
     */
    PGPOOL_MAX: z.coerce.number().int().positive().default(10),
    PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    PG_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    /**
     * Opt-in ("1"/"true") fail-fast on `uncaughtException` (review #23). Next
     * 16 treats both `uncaughtException` and `unhandledRejection` as
     * non-fatal, so by default the D5 handlers (src/lib/process-errors.server.ts)
     * only log + capture. Set this to have an uncaught exception exit 1 after
     * the capture so the orchestrator restarts the worker; an unhandled
     * rejection never exits regardless. The handler reads `process.env`
     * directly with the same rule — keep the two in sync.
     */
    PROCESS_FATAL_ON_UNCAUGHT: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /**
     * Trusted reverse-proxy hop count for client-IP extraction (P2-4): the
     * (count)-th `X-Forwarded-For` entry from the right is the IP the trusted
     * edge observed. Must be >= 1. Read via {@link intFromEnv} in client-ip.ts.
     */
    TRUSTED_PROXY_COUNT: z.coerce.number().int().min(1).default(1),
    GOOGLE_CLIENT_ID: z.string().optional().default(""),
    GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
    MICROSOFT_CLIENT_ID: z.string().optional().default(""),
    MICROSOFT_CLIENT_SECRET: z.string().optional().default(""),
    GITHUB_CLIENT_ID: z.string().optional().default(""),
    GITHUB_CLIENT_SECRET: z.string().optional().default(""),
    /**
     * The handoff issuer's ORIGIN URL (`iss` claim). Consumers fetch the
     * issuer's public keys from `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json`, so
     * it must be a URL — the primary's own origin.
     */
    SSO_HANDOFF_ISSUER: z.string().min(1),
    SSO_HANDOFF_AUDIENCE_PREFIX: z.string().min(1),
    /**
     * OPTIONAL Ed25519 private JWK that SIGNS handoff tokens (review #5 —
     * replaces the fleet-wide symmetric `SSO_HANDOFF_JWT_SECRET`). Only the
     * ISSUER (the primary) sets it; consumers verify against the issuer's
     * published JWKS and hold no signing material. Unset ⇒ this deployment
     * cannot launch handoffs (`/api/sso/launch` → 503) but still consumes.
     */
    SSO_HANDOFF_PRIVATE_KEY: optionalEd25519PrivateJwk("SSO_HANDOFF_PRIVATE_KEY"),
    /** Optional fixed `kid` for the handoff key (default: the JWK thumbprint). */
    SSO_HANDOFF_KID: z.string().optional(),
    /**
     * OPTIONAL previous handoff signing key kept during a rotation overlap:
     * its PUBLIC half stays in the JWKS (and the self-issuer verifier) so
     * tokens minted just before the rotation still verify until they expire
     * (≤60s). Set the new key as SSO_HANDOFF_PRIVATE_KEY, move the old one
     * here, and remove it once the window has passed.
     */
    SSO_HANDOFF_PREVIOUS_PRIVATE_KEY: optionalEd25519PrivateJwk("SSO_HANDOFF_PREVIOUS_PRIVATE_KEY"),
    /** Only needed if the previous key was published under a pinned SSO_HANDOFF_KID. */
    SSO_HANDOFF_PREVIOUS_KID: z.string().optional(),
    SSO_HANDOFF_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60),
    /**
     * Identifier of THIS deployment when consuming SSO handoffs. Required (not
     * optional): the consume endpoint computes the expected audience as
     * `${SSO_HANDOFF_AUDIENCE_PREFIX}:${SSO_HANDOFF_APPLICATION_ID}`, so a
     * deployment that sets the (already-required) prefix but omits the app id
     * would 500 on its FIRST handoff instead of failing at boot (P3-6). The
     * shell mounts /api/sso/consume on every instance, so this pairs with the
     * other required SSO_HANDOFF_* vars.
     */
    SSO_HANDOFF_APPLICATION_ID: z.string().min(1),
    /**
     * Comma-separated registrable-domain suffixes an enterprise-app origin may
     * sit under to be a valid SSO handoff target (e.g. `devresponse.com`).
     * Parsed by `allowedOriginSuffixes()`. Each entry must carry at least one
     * label beyond its public suffix — a bare TLD or PSL entry (`com`,
     * `co.uk`, `github.io`) fails boot in `superRefine` below, because it
     * would let an org admin register a token-harvesting origin (review #14).
     * Unset in production ⇒ registration fails closed (warned at boot).
     */
    SSO_ALLOWED_ORIGIN_SUFFIXES: z.string().optional(),
    /**
     * Comma-separated list of additional trusted origins shared by Better
     * Auth's `trustedOrigins` and the administrator origin guard.
     */
    ADMIN_TRUSTED_ORIGINS: z.string().optional(),
    /**
     * Parent domain for the Better Auth session cookie (e.g.
     * `.devresponse.com`). Unset (the default) keeps the cookie host-only —
     * the safe per-app isolation posture. Set it ONLY for the shared-`auth`-
     * schema satellite model (Option C, docs/integration-satellite-apps.md):
     * the primary and every co-trusted satellite must then share the SAME
     * value so one session cookie spans the fleet. Never set it on a
     * deployment whose subdomains are not all first-party and co-trusted.
     */
    COOKIE_DOMAIN: z.string().optional(),
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
     * Shared secret the scheduler presents (`Authorization: Bearer …`) to
     * `GET /api/internal/outbox-drain`. OPTIONAL — the route FAILS CLOSED
     * (401) when unset — but when set it must be a real secret: at least 32
     * chars, so a one-character value cannot silently enable the endpoint
     * (review #92). An empty string is treated as unset. Read through
     * {@link getServerEnv} by the route so the check actually bites.
     */
    CRON_SECRET: operatorSecret("CRON_SECRET"),
    /**
     * Bearer token gating the Prometheus scrape endpoint `GET /api/metrics`.
     * Same contract as CRON_SECRET: optional, fails closed when unset, at
     * least 32 chars when set, empty string = unset (review #222).
     */
    METRICS_TOKEN: operatorSecret("METRICS_TOKEN"),
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
    /**
     * OPTIONAL previous signing key (the prior API_JWT_PRIVATE_KEY) kept during
     * a rotation overlap: its PUBLIC half is published in JWKS and accepted by
     * verifyAccessToken, so tokens minted BEFORE the rotation keep verifying
     * until they expire (≤ API_JWT_ACCESS_TTL_SECONDS). Remove once that window
     * drains (P3-7). Never used to mint. To rotate with zero downtime: move the
     * old key here, set the new key as API_JWT_PRIVATE_KEY.
     */
    API_JWT_PREVIOUS_PRIVATE_KEY: z.string().optional(),
    /**
     * The previous key's `kid`, ONLY needed when the deployment pins a fixed
     * API_JWT_KID (otherwise the JWK thumbprint is used and matches automatically).
     */
    API_JWT_PREVIOUS_KID: z.string().optional(),
    /** Access-token lifetime in seconds (≤ 1 hour). */
    API_JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    /* ----------------------------------------------------------------- */
    /*  MCP agent gateway (design docs/design-mcp-agent-gateway.md)      */
    /* ----------------------------------------------------------------- */
    /**
     * Master switch for the `/api/mcp` Model Context Protocol endpoint.
     * DARK by default. The endpoint authenticates with the same bearer
     * credential the machine API accepts, so it is only usable where
     * API_KEYS_ENABLED / API_JWT_ENABLED are also on.
     */
    MCP_ENABLED: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /**
     * Rollout grace for RFC 8707 audience binding at `/api/mcp` (review
     * #50/#53). OFF (default): the gateway accepts only JWTs minted with
     * `resource=<origin>/api/mcp` (an MCP audience). ON (`1`/`true`): legacy
     * tokens carrying the plain v1 audience (`API_JWT_AUDIENCE`) are ALSO
     * accepted, so existing agents keep working while they migrate to
     * requesting the MCP resource. Unset it once every agent has moved.
     * API keys are not audience-bound and are unaffected either way.
     */
    MCP_AUDIENCE_GRACE: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /** Master switch for the `/api/mcp/register` self-registration endpoint (RFC 7591). DARK by default. */
    MCP_REGISTRATION_ENABLED: z
      .string()
      .optional()
      .transform((value) => value === "1" || value === "true"),
    /**
     * `approval` (default): a self-registered agent's service account is
     * `pending_approval` and cannot mint a token until an admin activates it.
     * `open`: the account is active immediately but the client still holds
     * ZERO scopes, so every tool 403s until an admin grants scopes.
     */
    MCP_REGISTRATION_MODE: z.enum(["approval", "open"]).default("approval"),
    /**
     * Target org slug/id used when a registration request omits
     * `organization`. Once set, a caller-supplied `organization` is REFUSED
     * unless it names this org or one in `MCP_REGISTRATION_ALLOWED_ORGS` —
     * a public caller must not be able to steer a registration into any
     * tenant the operator did not open (review #51).
     */
    MCP_REGISTRATION_DEFAULT_ORG: z.string().optional(),
    /**
     * Comma-separated org slugs/ids a registration request may name in
     * `organization` (review #51). Unset: only the default org (when one is
     * configured) is reachable; with neither set, any active org resolves —
     * the pre-#51 behaviour, kept for deployments that deliberately run an
     * open multi-tenant registration endpoint.
     */
    MCP_REGISTRATION_ALLOWED_ORGS: z.string().optional(),
    /**
     * Max SELF-REGISTERED active OAuth clients per org before registration
     * is refused (0 = unlimited). Admin-created clients never count toward
     * this quota (review #51), so junk self-registrations can never lock an
     * admin out of creating clients — and vice versa.
     */
    MCP_REGISTRATION_MAX_PER_ORG: z.coerce.number().int().nonnegative().default(50),
    /**
     * Age in days after which a still-`pending_approval` self-registration
     * is expired by the reaper (`GET /api/internal/mcp-registration-reap` /
     * `pnpm mcp:reap`), so junk registrations do not pile up in the Agents
     * console indefinitely (review #13, #51). 0 disables the sweep; a BLANK
     * value means "unset" (default 7) — `z.coerce` alone would turn
     * `MCP_REGISTRATION_PENDING_TTL_DAYS=` into 0 and silently disable it.
     */
    MCP_REGISTRATION_PENDING_TTL_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().nonnegative().default(7),
    ),
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
     * Content root for the Help viewer (`/app/help`) — the docs viewer's
     * sibling space. Defaults to the repo's `help/` folder. Shares
     * `DOCS_SOURCE` / `DOCS_INTERNAL_VISIBLE` with the docs space.
     */
    HELP_ROOT: z.string().optional(),
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
    // Signing-key hygiene (audit #12/#22, review #5). BETTER_AUTH_SECRET signs
    // sessions; the SSO handoff is signed by an independent asymmetric key
    // (SSO_HANDOFF_PRIVATE_KEY, validated as an Ed25519 JWK above) and the
    // machine API by another (API_JWT_PRIVATE_KEY) — three distinct trust
    // domains. Refuse one keypair doing double duty.
    if (env.SSO_HANDOFF_PRIVATE_KEY && env.SSO_HANDOFF_PRIVATE_KEY === env.API_JWT_PRIVATE_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["SSO_HANDOFF_PRIVATE_KEY"],
        message: "must differ from API_JWT_PRIVATE_KEY (they sign distinct trust domains)",
      });
    }
    // Origin allow-list hygiene (review #14): every configured suffix must be
    // a registrable domain. `localhost` is tolerated outside production for
    // the local satellite rig. Unset is NOT an error (SSO may be unused) —
    // production then fails closed on registration, see getServerEnv().
    const badSuffixes = invalidOriginSuffixes(env.SSO_ALLOWED_ORIGIN_SUFFIXES, {
      allowLocalhost: env.NODE_ENV !== "production",
    });
    if (badSuffixes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["SSO_ALLOWED_ORIGIN_SUFFIXES"],
        message: `every entry must be a registrable domain (at least one label beyond the public suffix — never a bare TLD such as "com" or a public suffix such as "co.uk" / "github.io"); rejected: ${badSuffixes.join(", ")}`,
      });
    }
    // And a production deployment must never boot on a publicly-known
    // .env.example placeholder — an env copied but not edited fails closed.
    if (env.NODE_ENV === "production") {
      for (const key of ["BETTER_AUTH_SECRET"] as const) {
        if (EXAMPLE_SECRET_PLACEHOLDERS.has(env[key])) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message:
              "must not use the .env.example placeholder in production — generate a real random secret (openssl rand -base64 32)",
          });
        }
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * NaN-safe integer read straight from `process.env`, for modules that must not
 * trigger full-schema validation — notably `src/db/database.ts`, which is
 * imported by env-poor cron scripts (`outbox:drain`, `db:prune`) that should
 * not require every app secret to be present just to open a pool.
 *
 * Returns `fallback` when the value is absent, non-numeric, non-integer, or
 * below `min` (default 1) — so `PGPOOL_MAX=abc` yields the default, never the
 * `NaN` that `Number(x ?? N)` silently produced (P2-12). The same vars are also
 * declared in {@link serverEnvSchema}, so a running server still fails fast on a
 * bad value via {@link getServerEnv}; this is the defensive read for the early /
 * script path. Keep the defaults here in sync with the schema.
 */
export function intFromEnv(name: string, fallback: number, min = 1): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

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
    // ≥32 chars so it satisfies the tightened min-length rule; discarded after
    // build-time page-data collection (never a running-server secret). No SSO
    // signing key: it is optional, and the build never signs.
    BETTER_AUTH_SECRET: "build-phase-placeholder-better-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://build:build@localhost:5432/build",
    SSO_HANDOFF_ISSUER: "http://localhost:3000",
    SSO_HANDOFF_AUDIENCE_PREFIX: "build-placeholder",
    SSO_HANDOFF_APPLICATION_ID: "build-placeholder",
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
  warnIfOriginAllowListUnset(cached);
  return cached;
}

/**
 * Boot-time warning (review #14): a production deployment with no
 * `SSO_ALLOWED_ORIGIN_SUFFIXES` can register NO enterprise-app origin
 * (`allowedOriginSuffixes()` fails closed rather than deriving a possibly
 * bare public suffix from the host). Not a boot failure — SSO may be unused —
 * but loud, so the operator sees it before the first `origin_not_allowed`.
 * `console.warn` on purpose: this module must stay importable from `tsx`
 * scripts, where the `server-only` pino logger cannot resolve. Skipped during
 * `next build` (no running server; the strict parse re-runs at real boot).
 */
function warnIfOriginAllowListUnset(env: ServerEnv): void {
  if (env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (splitOriginSuffixList(env.SSO_ALLOWED_ORIGIN_SUFFIXES).length > 0) return;
  console.warn(
    "[env] SSO_ALLOWED_ORIGIN_SUFFIXES is unset: in production the enterprise-app origin allow-list is EMPTY (no origin can be registered for SSO handoff). Set it to the registrable domain(s) your satellites live under, e.g. devresponse.com — see docs/configuration.md#single-sign-on-handoff",
  );
}
