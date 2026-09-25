import { commandFor } from "./config-file.js";
import { ed25519PrivateJwkProblem } from "./secrets.js";
import {
  type DeploymentProfile,
  type SatelliteProfile,
  hostSitsUnder,
  isCookieDomainShaped,
  optionLabel,
  originOf,
} from "./target.js";

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
  /**
   * What `env:sync` should tell the operator when it has no value and cannot
   * make one. The default ("no value available") is fine for a connection
   * string; it is not fine for a value that is deliberately un-generatable,
   * like an Option C satellite's shared session secret.
   */
  noValueHint?: string;
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

/** Loopback hosts, where plain http never leaves the machine. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The kit's origin rule, `httpOriginProblem` in `src/lib/env-validators.ts`
 * (F-22), copied because this package cannot import across its `rootDir`.
 * The kit's `tests/unit/env-validators.test.ts` runs both over the same
 * vectors, so a change to one that is not made to the other fails there.
 *
 * An http(s) origin and nothing more: another scheme (`httsp:`, the typo that
 * sat in the kit's production issuer for a week), a value the URL parser
 * repairs (`https:/host`), a path, query, fragment or credentials are refused,
 * and so is plain http in production unless the host is loopback. `exact`
 * (the issuers) also refuses a trailing slash and a capitalised host, because
 * the value is stamped into tokens as `iss` and compared as an exact string.
 */
export function httpOriginProblem(
  value: string,
  options: { production: boolean; exact?: boolean },
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute http(s) origin such as https://app.example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `must use the http: or https: scheme, not "${url.protocol}"`;
  }
  const canonical = url.origin;
  if (options.exact) {
    if (value === `${canonical}/`) {
      return `must not end with "/": it is compared as an exact string, so drop the trailing slash (${canonical})`;
    }
    if (value !== canonical) {
      return `must be written exactly as an origin, scheme://host[:port] in lowercase with no path, query, fragment or credentials (${canonical})`;
    }
  } else {
    const lowered = value.toLowerCase();
    if (lowered !== canonical && lowered !== `${canonical}/`) {
      return `must be an origin, scheme://host[:port] with no path, query, fragment or credentials (${canonical})`;
    }
  }
  if (options.production && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "must use https: in production (plain http is accepted only for localhost, 127.0.0.1 or [::1])";
  }
  return null;
}

/** Top-level names no email provider sends from. Copied from the kit, see {@link emailFromProblem}. */
const RESERVED_MAIL_TLDS: ReadonlySet<string> = new Set([
  "localhost",
  "local",
  "test",
  "invalid",
  "example",
  "internal",
]);
const RESERVED_MAIL_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];
const MAIL_DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The lowercased domain of the address in `local@domain` or `Name <local@domain>`, or `null`. */
function emailFromDomain(value: string): string | null {
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf("<");
  const address = open !== -1 && trimmed.endsWith(">") ? trimmed.slice(open + 1, -1).trim() : trimmed;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) return null;
  if (/[\s<>"]/.test(address)) return null;
  return address.slice(at + 1).toLowerCase();
}

/**
 * The kit's sender rule, `emailFromProblem` in `src/lib/env-validators.ts`
 * (F-27), copied because this package cannot import across its `rootDir`. The
 * kit's `tests/unit/env-validators.test.ts` runs both over the same vectors.
 *
 * The kit applies it in production when `EMAIL_PROVIDER` is set: a sender with
 * no address, on a reserved domain (the `no-reply@localhost` default,
 * `*.local`, `example.com`, …), an IP address or a single label fails boot,
 * because every reset, verification and invitation email would fail. This CLI
 * applies it to every EMAIL_FROM it writes, provider or not: every Vercel
 * deployment runs production, and a sender that stops the kit booting the
 * moment a provider is added is not worth storing. That also stops
 * `env:sync --force` from overwriting a working sender with the `.env.example`
 * default. The kit's Mailgun alignment rule needs a public-suffix list and is
 * not copied.
 */
export function emailFromProblem(value: string): string | null {
  const domain = emailFromDomain(value);
  if (domain === null) {
    return 'must be a sender address, written as no-reply@your-domain or "Name <no-reply@your-domain>"';
  }
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (
    RESERVED_MAIL_TLDS.has(tld) ||
    RESERVED_MAIL_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))
  ) {
    return `must be on a domain verified with the email provider: ${domain} is reserved for local, test or documentation use, so no provider sends mail from it`;
  }
  if (!MAIL_DOMAIN_RE.test(domain)) {
    return `must be on a public domain name verified with the email provider, not ${domain} (an IP address, a single label or a malformed name)`;
  }
  return null;
}

/**
 * Every Vercel deployment, preview included, runs NODE_ENV=production, so the
 * kit applies its production rule to whatever this CLI stores.
 */
const kitOrigin = (value: string): string | null => httpOriginProblem(value, { production: true });
const kitExactOrigin = (value: string): string | null =>
  httpOriginProblem(value, { production: true, exact: true });

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
    validate: kitOrigin,
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
    validate: kitExactOrigin,
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
    // The kit imports the key at boot (F-22); refuse here what it would refuse.
    validate: ed25519PrivateJwkProblem,
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
    comment:
      "From header for outbound email, e.g. App <no-reply@your-domain>, on a domain the provider has verified.",
    consequence:
      "Defaults to a localhost sender: harmless with no EMAIL_PROVIDER, but with one set the kit refuses to boot (F-27).",
    validate: emailFromProblem,
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

/* ================================================================== */
/*  Satellite profile                                                  */
/* ================================================================== */

/**
 * The environment contract for a SATELLITE (devresponseapps: app-standalone,
 * app-handoff, app-shared), derived from those apps' own `src/lib/env.ts` and
 * `src/lib/jwt-handoff.server.ts` rather than from their READMEs.
 *
 * A satellite is a CONSUMER. It verifies handoff tokens against the kit's
 * published JWKS (`createRemoteJWKSet` over `${SSO_HANDOFF_ISSUER}` +
 * `/api/sso/jwks.json`, EdDSA) and holds no signing material of its own. Three
 * things therefore invert relative to the kit, and each of them is the kind of
 * mistake that looks fine in the dashboard:
 *
 *   1. `SSO_HANDOFF_ISSUER` names the KIT, not this deployment;
 *   2. the issuer-only variables are REFUSED here, not merely omitted;
 *   3. Option C shares the kit's session, so its secret is supplied, never
 *      generated.
 *
 * Note on what is deliberately absent: the retired `SSO_HANDOFF_JWT_SECRET`
 * (the old shared HS256 secret) is NOT part of this contract. The handoff has
 * been EdDSA + JWKS for some time; a shared symmetric secret would have given
 * every consumer the ability to mint tokens, which is the exact property the
 * current design exists to remove.
 */

/** Everything a profile-aware spec list needs to know about this deployment. */
export interface DeploymentContext {
  profile: DeploymentProfile;
  /** THIS deployment's own public origin. */
  origin: string;
  appName: string;
  audiencePrefix: string;
  applicationId: string;
}

const atLeastChars =
  (n: number, why: string) =>
  (value: string): string | null =>
    value.length >= n ? null : `must be at least ${n} characters (${why})`;

/**
 * May this deployment generate its own `BETTER_AUTH_SECRET`?
 *
 * No, for an Option C satellite. That app validates the KIT's session cookie
 * directly, which only works when both hold the identical secret. Generating a
 * fresh one would not fail loudly — the satellite boots, serves, and passes
 * every health probe, while users bounce between "signed in" on the kit and
 * "signed out" here. That is a bug report reading "sometimes I get logged
 * out", and it takes days to trace.
 */
export function mayGenerateAuthSecret(profile: DeploymentProfile): boolean {
  return !(profile.kind === "satellite" && profile.sharesSession);
}

const SHARED_SECRET_HINT = [
  "cannot be generated for an Option C satellite: it must be byte-identical to the KIT's BETTER_AUTH_SECRET,",
  "because this app validates the kit's session cookie directly. A freshly generated secret would boot cleanly",
  "and then log users out at random. Copy the kit's value (--from-env, or the shell) and re-run.",
].join(" ");

/** The satellite's variables, in the order an operator reads them. */
export function satelliteEnvSpecs(context: DeploymentContext & { profile: SatelliteProfile }): EnvVarSpec[] {
  const { profile } = context;
  /** Option C: shares the kit's SESSION (same secret, parent-domain cookie). */
  const shared = profile.sharesSession;
  /**
   * Shares the kit's DATABASE — which is a different question, and the one
   * most of this contract actually turns on.
   *
   * `shared-with-kit` is the DEFAULT for every option, so the common Option A
   * or B satellite has `sharesSession === false` and still runs against the
   * primary's Postgres (the apps' own `scripts/db-owned-by-kit.mjs` says so in
   * as many words). Branching the database variables on session sharing told
   * that satellite to give itself a database — and then `migrate` refused it,
   * which is the CLI telling an operator to do the opposite of what it permits.
   */
  const usesKitDatabase = profile.database === "shared-with-kit";
  const ownOrigin = originOf(context.origin);

  const specs: EnvVarSpec[] = [
    {
      key: "BETTER_AUTH_SECRET",
      level: "required",
      secret: true,
      // The Option C rule, expressed where `env:sync` already looks: a
      // "supplied" source is never generated.
      source: shared ? "supplied" : "auth-secret",
      comment: shared
        ? "MUST be the SAME value as the kit's: this app validates the kit's session cookie directly."
        : "Signs THIS app's own session cookies. Independent of the kit; rotating it signs out only this app.",
      consequence: "The server will not boot.",
      validate: atLeastChars(32, "the kit uses 32+ and an Option C satellite must match it exactly"),
      ...(shared ? { noValueHint: SHARED_SECRET_HINT } : {}),
    },
    {
      key: "BETTER_AUTH_URL",
      level: "required",
      secret: false,
      source: "derived",
      comment: "THIS app's own public origin. Callback URLs and its trusted-origin list are built from it.",
      consequence: "The server will not boot.",
      validate: isUrl,
    },
    {
      key: "DATABASE_URL",
      level: "required",
      secret: true,
      source: "supplied",
      comment: usesKitDatabase
        ? shared
          ? "The KIT's Postgres — Option C reads the primary's user/session tables. Do not point it elsewhere."
          : "The KIT's Postgres: this satellite does not own its schema, so it must be the primary's connection string. On it, a compromise of this app reaches the kit's auth tables: not contained."
        : "This app's OWN Postgres (recorded as `database: own`) — separate from the kit's, and reached as this app's OWN role. The kit's role with another database name in the URL still reaches the kit's auth tables: not contained.",
      consequence: usesKitDatabase
        ? "The server will not boot. Pointed at a SEPARATE database it boots and looks healthy — /api/health/ready only proves the connection works — while every handoff nonce and session lookup misses, and `drk-deploy migrate` refuses to populate it."
        : "The server will not boot.",
      validate: (v) =>
        v.startsWith("postgres://") || v.startsWith("postgresql://") ? null : "must be a postgres:// URL",
    },
    {
      key: "SSO_HANDOFF_ISSUER",
      level: "required",
      secret: false,
      source: "derived",
      comment:
        "The KIT's origin — NOT this app's. Handoffs are verified against its /api/sso/jwks.json (EdDSA).",
      consequence: "The server will not boot.",
      validate: (value) => {
        const issuer = originOf(value);
        if (issuer === null) return "must be the issuer's http(s) origin — its JWKS is fetched from it";
        if (ownOrigin !== null && issuer === ownOrigin) {
          return "must be the KIT's origin, not this deployment's own: a satellite that names itself as issuer verifies against its own EMPTY key set, so every handoff fails";
        }
        return null;
      },
    },
    {
      key: "SSO_HANDOFF_AUDIENCE_PREFIX",
      level: "required",
      secret: false,
      source: "derived",
      comment: "Must match the kit's exactly. A token's audience is ${prefix}:${applicationId}.",
      consequence: "The server will not boot.",
    },
    {
      key: "SSO_HANDOFF_APPLICATION_ID",
      level: "required",
      secret: false,
      source: "derived",
      comment: `Identifies THIS satellite (${optionLabel(profile.option)}) when it consumes a handoff, and binds the nonce burn.`,
      consequence: "The server will not boot.",
    },
  ];

  if (shared) {
    specs.push({
      key: "COOKIE_DOMAIN",
      level: "required",
      secret: false,
      source: "derived",
      comment:
        "Parent domain the session cookie is scoped to, e.g. .example.com. Option C only — it is what makes one session span both hosts.",
      consequence:
        "The cookie stays scoped to this host, so the kit's session is never presented here: the app boots, looks healthy, and users appear randomly signed out.",
      noValueHint: `must be supplied for an Option C satellite and is never guessed — record it with \`${commandFor("init --cookie-domain .example.com")}\` (the domain BOTH the kit and this app sit under).`,
      validate: (value) => {
        if (!isCookieDomainShaped(value)) {
          return "must be a registrable domain with at least one dot, e.g. .example.com (a bare public suffix is refused by browsers)";
        }
        if (ownOrigin !== null && !hostSitsUnder(new URL(ownOrigin).host, value)) {
          return `this deployment's host does not sit under \`${value}\`, so the browser would discard the cookie`;
        }
        return null;
      },
    });
  }

  specs.push(
    {
      key: "DB_SCHEMA",
      // Recommended whenever the tables belong to the kit, not just for Option
      // C: an A or B satellite on the primary's database reads the primary's
      // rows, so a schema mismatch is the same silent emptiness.
      level: usesKitDatabase ? "recommended" : "optional",
      secret: false,
      source: "supplied",
      comment: usesKitDatabase
        ? "Must equal the KIT's DB_SCHEMA exactly — this app reads the primary's tables. Defaults to `auth`."
        : "Schema every table is deployed into. Defaults to `auth`.",
      consequence: usesKitDatabase
        ? "Falls back to `auth`; if the kit uses another schema this app reads an empty one — sessions look invalid and every handoff nonce lookup misses."
        : "Falls back to `auth`, which is usually right.",
      validate: (v) =>
        /^[a-z_][a-z0-9_]*$/i.test(v) ? null : "must be a plain SQL identifier (it is interpolated into DDL)",
    },
    {
      key: "ADMIN_TRUSTED_ORIGINS",
      // Optional, and deliberately NOT "add the kit's origin". The satellite's
      // trusted-origin list (`src/lib/trusted-origins.ts`) feeds Better Auth's
      // CSRF check and the admin origin guard, and it is consulted only for
      // UNSAFE methods. No unsafe cross-origin request from the kit ever
      // arrives here: the handoff is a GET redirect (unchecked), and the
      // confirm POST is submitted by this app's own interstitial, so it is
      // same-origin. Listing the kit would widen the CSRF allow-list for a
      // request that does not happen — a cost with no matching benefit.
      level: "optional",
      secret: false,
      source: "supplied",
      comment:
        "Comma-separated EXTRA origins of this same app (a preview host, a second alias). Not the kit's — the handoff is a GET redirect and the confirm POST is same-origin, so trusting the kit only widens the CSRF allow-list.",
      consequence:
        "Only this app's own origin (NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL) is trusted, which is correct unless this deployment answers on a second hostname.",
    },
    {
      key: "CRON_SECRET",
      /**
       * Gated on database OWNERSHIP, because that is what decides whether this
       * app may drain the outbox at all.
       *
       * No satellite ships a `crons` entry — all three `vercel.json` files
       * carry only `$schema` and `regions`; the kit's is the one with the
       * schedule. That is deliberate, and the route says why in its own header:
       * `app_outbox` has no originating-app column, so a drain here claims the
       * PRIMARY's rows, sends the primary's mail through this app's provider
       * credentials, and reads `delivery_payload` — the unredacted copy that
       * carries live password-reset and invitation tokens.
       *
       * So on a shared database the variable is `supplied`, never generated:
       * `env:sync` generates for any `operator-secret` source regardless of
       * level, and generating this one is precisely what arms a route that is
       * currently, correctly, failing closed at 401.
       */
      level: profile.database === "own" ? "recommended" : "optional",
      secret: true,
      source: profile.database === "own" ? "operator-secret" : "supplied",
      comment: usesKitDatabase
        ? "Leave UNSET. This app ships no cron, and it shares the KIT's outbox — the kit's own cron drains it with the right credentials. Setting this arms /api/internal/outbox-drain to send the PRIMARY's mail from this app."
        : "Bearer token for /api/internal/outbox-drain. This app ships NO crons entry, so schedule that path externally; the route fails closed (401) until this is set.",
      consequence: usesKitDatabase
        ? "Unset is the correct state: the drain route answers 401 and the kit's cron sends this app's queued mail."
        : "Nothing drains the outbox: the route answers 401 to every caller, so queued email is retried by nobody.",
      ...(usesKitDatabase
        ? {
            noValueHint:
              "is deliberately not generated for a satellite on the kit's database: it would arm a drain route that would send the PRIMARY's mail. Supply one only if you own the database and have scheduled the route yourself.",
          }
        : {}),
      // NOT a schema rule: unlike the kit, the satellites do not declare
      // CRON_SECRET in `serverEnvSchema` at all — the route reads process.env
      // directly and compares in constant time. 32 is this CLI's own floor for
      // a bearer secret.
      validate: atLeastChars(32, "this CLI's floor for a bearer token compared in constant time"),
    },
    {
      key: "NEXT_PUBLIC_APP_URL",
      level: "recommended",
      secret: false,
      source: "derived",
      buildTime: true,
      comment:
        "The origin as the browser sees it. Inlined at build time, and part of the trusted-origin list.",
      consequence: "Client-side links may point at the wrong origin.",
      validate: isUrl,
    },
    {
      key: "METRICS_TOKEN",
      level: "optional",
      secret: true,
      source: "operator-secret",
      comment: "Bearer token gating the Prometheus scrape endpoint.",
      consequence: "/api/metrics stays closed (401).",
      // Same caveat as CRON_SECRET: not declared in the satellites'
      // `serverEnvSchema` — the route reads process.env itself.
      validate: atLeastChars(32, "this CLI's floor for a bearer token compared in constant time"),
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
  );

  return specs;
}

/**
 * Variables that must NEVER be set on a satellite.
 *
 * The first two are the security ones, and they are not theoretical: a
 * satellite ships the SAME `/api/sso/launch` route the kit does. Give it
 * `SSO_HANDOFF_PRIVATE_KEY` and it stops being a consumer: it signs handoff
 * tokens. Consumers verify against the ISSUER's published keys, so a key of
 * the satellite's own signs tokens they refuse. But the realistic way a key
 * gets there is an environment copied from the kit's, and with the kit's own
 * key it signs tokens every consumer accepts, while the kit's private key sits
 * on one more deployment (F-51). The EdDSA + JWKS design exists so that
 * compromising a satellite lets an attacker forge NO handoff token; a copy of
 * the issuer's key on a consumer hands that property back.
 * (Forging no token is not the same as being contained: on the kit's database
 * or under its cookie domain a satellite is not, key or no key. See
 * `containmentWarnings` in target.ts, F-24.)
 *
 * The rest are inert rather than dangerous, and are listed for the same reason
 * FORBIDDEN_ON_VERCEL lists seed variables: an inert setting that looks
 * load-bearing is how an operator ends up believing a control is enforced here
 * when it is enforced somewhere else entirely.
 */
export const SATELLITE_ISSUER_ONLY: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: "SSO_HANDOFF_PRIVATE_KEY",
    why: "ISSUER ONLY. A consumer holds no signing material — with this set, THIS app's /api/sso/launch signs handoffs, and with the kit's own key (a copied .env) every consumer accepts them, so compromising a satellite becomes enough to forge a session anywhere",
  },
  {
    key: "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY",
    why: "ISSUER ONLY. The rotation-overlap half of the issuer's signing key — the same regression as above, one rotation behind",
  },
  {
    key: "SSO_HANDOFF_KID",
    why: "issuer-only: it pins the key id the ISSUER publishes; a consumer publishes no keys",
  },
  {
    key: "SSO_HANDOFF_PREVIOUS_KID",
    why: "issuer-only: names the previous published key id; a consumer publishes no keys",
  },
  {
    key: "SSO_ALLOWED_ORIGIN_SUFFIXES",
    why: "issuer-only: the allow-list of satellite origins the ISSUER may register for handoff. Inert here, and it reads like a control this app enforces",
  },
];

/**
 * Must-not-be-set list for a given deployment, on top of FORBIDDEN_ON_VERCEL.
 *
 * Empty for the kit — the kit IS the issuer.
 *
 * `COOKIE_DOMAIN` is refused for Options A and B, but for the INERT reason,
 * not a dangerous one: only app-shared reads it (`src/lib/auth.ts` passes it as
 * the session cookie's `domain`), so on A and B it is a variable that does
 * nothing at all. It is listed here for the same reason FORBIDDEN_ON_VERCEL
 * lists the seed variables — a setting that looks load-bearing and is not is
 * how an operator comes to believe a control is enforced here when it is not.
 * And it stops being inert the moment this app is re-pointed at Option C.
 */
export function refusedFor(profile: DeploymentProfile): ReadonlyArray<{ key: string; why: string }> {
  if (profile.kind !== "satellite") return [];
  if (profile.sharesSession) return SATELLITE_ISSUER_ONLY;
  return [
    ...SATELLITE_ISSUER_ONLY,
    {
      key: "COOKIE_DOMAIN",
      why: `Option ${profile.option === "standalone" ? "A" : "B"} holds its OWN host-scoped session and never reads this variable — only the Option C app does. Inert here, and it reads like a shared-session setting this app honours`,
    },
  ];
}

/** The spec list for whatever this deployment is. The kit's is untouched. */
export function envSpecsFor(context: DeploymentContext): readonly EnvVarSpec[] {
  if (context.profile.kind !== "satellite") return ENV_SPECS;
  return satelliteEnvSpecs({ ...context, profile: context.profile });
}

/**
 * The values this CLI computes from the project's own settings.
 *
 * The one line worth staring at is SSO_HANDOFF_ISSUER: on the kit it is the
 * kit's own origin, on a satellite it is the KIT's origin as seen from the
 * satellite. Same variable, opposite meaning — so it is derived from the
 * recorded issuer, never from the deployment's own domain.
 */
export function derivedValuesFor(context: DeploymentContext): Record<string, string> {
  const base = derivedValues({
    origin: context.origin,
    appName: context.appName,
    audiencePrefix: context.audiencePrefix,
    applicationId: context.applicationId,
  });
  if (context.profile.kind !== "satellite") return base;

  const satellite: Record<string, string> = {
    ...base,
    SSO_HANDOFF_ISSUER: context.profile.issuerOrigin,
  };
  if (context.profile.sharesSession && context.profile.cookieDomain) {
    satellite.COOKIE_DOMAIN = context.profile.cookieDomain;
  }
  return satellite;
}

/**
 * The derived keys a STORED value must equal (F-46): the deployment's origin
 * and its SSO identity. A different value in any of them breaks sign-in, the
 * trusted-origin list, every handoff or the shared session, while the
 * deployment boots and looks healthy.
 *
 * NEXT_PUBLIC_APP_NAME and NEXT_PUBLIC_PRODUCTION_HOST are derived too, but
 * only as defaults. One is the product name in the UI; the kit reads the other
 * only outside production (the origin-suffix fallback). A value the operator
 * chose for either is not a reason to refuse a deploy, so neither is held to
 * the recorded config.
 */
const PINNED_TO_CONFIG: ReadonlySet<string> = new Set([
  "BETTER_AUTH_URL",
  "SSO_HANDOFF_ISSUER",
  "SSO_HANDOFF_AUDIENCE_PREFIX",
  "SSO_HANDOFF_APPLICATION_ID",
  "NEXT_PUBLIC_APP_URL",
  "COOKIE_DOMAIN",
]);

/**
 * The values `env:check` and `env:sync` hold a stored Production or Preview
 * value to (F-46): {@link derivedValuesFor}, narrowed to the keys in
 * PINNED_TO_CONFIG. `env:sync` refuses to write a supplied value that differs
 * from one of them, so it never writes what its next run, or `env:check`,
 * would reject.
 */
export function pinnedValuesFor(context: DeploymentContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(derivedValuesFor(context)).filter(([key]) => PINNED_TO_CONFIG.has(key)),
  );
}

/** The required keys for a deployment, whatever it is. */
export function requiredKeysFor(context: DeploymentContext): string[] {
  return envSpecsFor(context)
    .filter((s) => s.level === "required")
    .map((s) => s.key);
}
