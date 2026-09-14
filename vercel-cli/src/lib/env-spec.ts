import { isValidHandoffPrivateJwk } from "./secrets.js";

/**
 * The environment contract between this CLI and devresponsekit.
 *
 * The kit validates `process.env` ONCE at boot (`src/lib/env.ts`) and throws if
 * a required variable is missing or malformed, so a misconfigured deployment
 * fails closed rather than serving broken auth. Everything below mirrors a rule
 * in that schema — this file is the deployable half of it.
 *
 * A note that costs an outage to learn: `next build` substitutes placeholders
 * for the required values, so a green build proves NOTHING about runtime
 * config. Only `env:check` (or the first real request) does.
 */

export type EnvTarget = "production" | "preview" | "development";

export type EnvSource =
  /** Generated here when absent: 32 bytes of entropy. */
  | "auth-secret"
  /** Generated here when absent: an Ed25519 private JWK. */
  | "handoff-key"
  /** Generated here when absent: a >=32 char operator token. */
  | "operator-secret"
  /** Computed from the deployment's own domain / project settings. */
  | "derived"
  /** Supplied by the operator (or by the Postgres provisioning step). */
  | "supplied";

export interface EnvVarSpec {
  key: string;
  /**
   * `required` — the kit refuses to boot without it.
   * `recommended` — boots, but a feature is silently dead until it is set.
   * `optional` — has a working default.
   */
  level: "required" | "recommended" | "optional";
  /** Secrets are stored `encrypted` on Vercel and never printed by this CLI. */
  secret: boolean;
  source: EnvSource;
  /**
   * `NEXT_PUBLIC_*` values are inlined into the client bundle at BUILD time, so
   * changing one has no effect until the next deployment — and whatever is in
   * it is publicly readable.
   */
  buildTime?: boolean;
  /** Shown in the Vercel dashboard next to the variable. */
  comment: string;
  /** Why an operator should care, printed by `env:check` when it is missing. */
  consequence: string;
  /** Returns an error string when the value would fail the kit's schema. */
  validate?: (value: string) => string | null;
}

const atLeast =
  (n: number) =>
  (value: string): string | null =>
    value.length >= n
      ? null
      : `must be at least ${n} characters (the kit's schema refuses shorter values at boot)`;

const isUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? null : "must be an http(s) URL";
  } catch {
    return "must be a valid URL";
  }
};

/**
 * The six the kit refuses to boot without, plus the ones whose absence turns a
 * feature off silently. Ordered the way an operator reads them, not
 * alphabetically.
 */
export const ENV_SPECS: readonly EnvVarSpec[] = [
  {
    key: "BETTER_AUTH_SECRET",
    level: "required",
    secret: true,
    source: "auth-secret",
    comment: "Signs session cookies. Rotating it invalidates every live session.",
    consequence: "The server will not boot.",
    validate: atLeast(32),
  },
  {
    key: "BETTER_AUTH_URL",
    level: "required",
    secret: false,
    source: "derived",
    comment: "The app's public origin. Callback URLs and OAuth discovery are built from it.",
    consequence: "The server will not boot.",
    validate: isUrl,
  },
  {
    key: "DATABASE_URL",
    level: "required",
    secret: true,
    source: "supplied",
    comment: "Postgres connection string. Use the DIRECT (non-pooled) endpoint for migrations.",
    consequence: "The server will not boot.",
    validate: (v) =>
      v.startsWith("postgres://") || v.startsWith("postgresql://") ? null : "must be a postgres:// URL",
  },
  {
    key: "SSO_HANDOFF_ISSUER",
    level: "required",
    secret: false,
    source: "derived",
    comment: "Origin that signs SSO handoffs. Satellites fetch its keys from ${this}/api/sso/jwks.json.",
    consequence: "The server will not boot.",
    validate: isUrl,
  },
  {
    key: "SSO_HANDOFF_AUDIENCE_PREFIX",
    level: "required",
    secret: false,
    source: "derived",
    comment: "First half of a handoff token's audience: ${prefix}:${applicationId}.",
    consequence: "The server will not boot.",
  },
  {
    key: "SSO_HANDOFF_APPLICATION_ID",
    level: "required",
    secret: false,
    source: "derived",
    comment: "Identifies THIS deployment when it consumes a handoff, and binds the nonce burn.",
    consequence: "The server will not boot.",
  },
  {
    key: "SSO_HANDOFF_PRIVATE_KEY",
    level: "recommended",
    secret: true,
    source: "handoff-key",
    comment: "Ed25519 private JWK that signs handoffs. Issuer only — satellites hold no key.",
    consequence:
      "/api/sso/launch answers 503 and /api/sso/jwks.json serves an EMPTY key set, so no satellite can verify a handoff.",
    validate: (v) =>
      isValidHandoffPrivateJwk(v)
        ? null
        : "must be a JSON Ed25519 private JWK (kty OKP, crv Ed25519, with d)",
  },
  {
    key: "SSO_ALLOWED_ORIGIN_SUFFIXES",
    level: "recommended",
    secret: false,
    source: "supplied",
    comment: "Comma-separated registrable domains a satellite origin may sit under, e.g. example.com.",
    consequence: "Production logs a boot warning and refuses to register ANY enterprise-app origin.",
    validate: (v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.includes("."))
        ? null
        : "each entry must be a registrable domain with at least one label beyond the public suffix",
  },
  {
    key: "CRON_SECRET",
    level: "recommended",
    secret: true,
    source: "operator-secret",
    comment: "Bearer token the scheduler presents to the outbox drainer and registration reaper.",
    consequence: "Both scheduled jobs answer 401 forever — they fail closed, and silently.",
    validate: atLeast(32),
  },
  {
    key: "METRICS_TOKEN",
    level: "optional",
    secret: true,
    source: "operator-secret",
    comment: "Bearer token gating the Prometheus scrape endpoint.",
    consequence: "/api/metrics stays closed (401).",
    validate: atLeast(32),
  },
  {
    key: "NEXT_PUBLIC_APP_URL",
    level: "recommended",
    secret: false,
    source: "derived",
    buildTime: true,
    comment: "The origin as the browser sees it. Inlined at build time.",
    consequence: "Client-side links may point at the wrong origin.",
    validate: isUrl,
  },
  {
    key: "NEXT_PUBLIC_PRODUCTION_HOST",
    level: "optional",
    secret: false,
    source: "derived",
    buildTime: true,
    comment: "Canonical production hostname, used to tell production from a preview.",
    consequence: "Previews may not identify themselves correctly.",
  },
  {
    key: "NEXT_PUBLIC_APP_NAME",
    level: "optional",
    secret: false,
    source: "derived",
    buildTime: true,
    comment: "Product name shown in the shell, page titles and email chrome.",
    consequence: "The UI falls back to a default name.",
  },
  {
    key: "EMAIL_FROM",
    level: "optional",
    secret: false,
    source: "supplied",
    comment: "From header for outbound email.",
    consequence: "Mail is sent from a localhost address (the default), which most providers reject.",
  },
] as const;

/**
 * Variables that must NEVER exist on a Vercel deployment. Some are simply
 * inert; the first two actively weaken or mask the app's own safety checks,
 * and the kit's schema refuses to boot on AUTH_RATE_LIMIT_DISABLED in
 * production for exactly that reason.
 */
export const FORBIDDEN_ON_VERCEL: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: "AUTH_RATE_LIMIT_DISABLED",
    why: "disables sign-in brute-force protection; the kit refuses to boot with it in production",
  },
  {
    key: "SKIP_ENV_VALIDATION",
    why: "would mask a missing secret; deliberately ignored in production, so it only creates false confidence",
  },
  { key: "SEED_ADMIN_EMAIL", why: "seed-script only; never read by the running server" },
  {
    key: "SEED_ADMIN_PASSWORD",
    why: "seed-script only; a production password sitting in the environment for nothing",
  },
  { key: "SEED_ADMIN_ADOPT_EXISTING", why: "seed-script only; lets a re-seed take over an existing account" },
  { key: "SEED_DEMO_APPS", why: "seeds demo data into a production database" },
  { key: "DEV_SEED_PASSWORD", why: "local development rig only" },
  { key: "DATABASE_TEST_URL", why: "test-suite only" },
  { key: "SSO_VERIFY_EMAIL", why: "local verification script only" },
  { key: "SSO_VERIFY_PASSWORD", why: "local verification script only" },
  { key: "TEST_SHARDS", why: "CI only" },
];

export const REQUIRED_KEYS: readonly string[] = ENV_SPECS.filter((s) => s.level === "required").map(
  (s) => s.key,
);

export function specFor(key: string): EnvVarSpec | undefined {
  return ENV_SPECS.find((s) => s.key === key);
}

/** Values this CLI can compute once it knows the deployment's domain. */
export function derivedValues(options: {
  origin: string;
  appName: string;
  audiencePrefix: string;
  applicationId: string;
}): Record<string, string> {
  const host = new URL(options.origin).host;
  return {
    BETTER_AUTH_URL: options.origin,
    SSO_HANDOFF_ISSUER: options.origin,
    SSO_HANDOFF_AUDIENCE_PREFIX: options.audiencePrefix,
    SSO_HANDOFF_APPLICATION_ID: options.applicationId,
    NEXT_PUBLIC_APP_URL: options.origin,
    NEXT_PUBLIC_PRODUCTION_HOST: host,
    NEXT_PUBLIC_APP_NAME: options.appName,
  };
}

/** The Vercel env-var `type` for a spec — secrets are stored encrypted. */
export function vercelTypeFor(spec: EnvVarSpec): "encrypted" | "plain" {
  return spec.secret ? "encrypted" : "plain";
}

export const ALL_TARGETS: readonly EnvTarget[] = ["production", "preview", "development"];
