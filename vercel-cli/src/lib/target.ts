import { CliError } from "./log.js";

/**
 * WHAT this CLI is pointed at.
 *
 * `drk-deploy` was written to deploy devresponsekit — the PRIMARY, the thing
 * that owns the database schema and signs SSO handoffs. A satellite
 * (devresponseapps: app-standalone = A, app-handoff = B, app-shared = C) is a
 * fork of the same application wired as a CONSUMER, and almost every safety
 * rule inverts:
 *
 *   - the kit ISSUES handoffs and holds an Ed25519 private key; a satellite
 *     verifies against the kit's published JWKS and holds NO signing material;
 *   - `SSO_HANDOFF_ISSUER` on the kit points at itself, on a satellite it
 *     points at the kit — same variable, opposite meaning;
 *   - the kit OWNS the schema and migrates; a satellite sharing that database
 *     must never run a migration (its own `db:*` scripts refuse for exactly
 *     this reason — see `scripts/db-owned-by-kit.mjs` in each app);
 *   - Option C shares the kit's SESSION, which means the same
 *     `BETTER_AUTH_SECRET` and a parent-domain cookie; A and B must not.
 *
 * Everything in this file is pure so the rules can be tested directly: this
 * package has no CI, so anything not covered here is unverified forever.
 *
 * BACKWARD COMPATIBILITY: a config with no `target` is the kit. That is the
 * shape every existing `.drk-deploy.json` has, and it must keep behaving
 * exactly as it did before satellites existed.
 */

export type DeployTarget = "kit" | "satellite";

/** Which satellite shape — the three options in `docs/design-satellite-apps.md`. */
export type SatelliteOption = "standalone" | "handoff" | "shared";

/**
 * Who owns the schema the satellite runs against.
 *
 * `shared-with-kit` is the default *and* the fail-closed answer: a satellite
 * pointed at the kit's database must never have migrations applied from a
 * satellite context.
 */
export type SatelliteDatabase = "shared-with-kit" | "own";

export const SATELLITE_OPTIONS: readonly SatelliteOption[] = ["standalone", "handoff", "shared"];
export const SATELLITE_DATABASES: readonly SatelliteDatabase[] = ["shared-with-kit", "own"];

/** The satellite half of `.drk-deploy.json`. Present only for a satellite. */
export interface SatelliteConfig {
  /** A = standalone, B = handoff, C = shared. */
  option: SatelliteOption;
  /** Absolute path to the satellite checkout that gets built and deployed. */
  appRoot: string;
  /**
   * The KIT's origin — the SSO issuer this satellite verifies handoffs
   * against. It becomes `SSO_HANDOFF_ISSUER`, which is emphatically NOT this
   * deployment's own origin.
   */
  issuerOrigin: string;
  /** Absent means `shared-with-kit`: the safe reading, not a convenient one. */
  database?: SatelliteDatabase;
  /**
   * Option C only: the parent domain the session cookie is scoped to, e.g.
   * `.example.com`. Never derived — guessing a registrable domain without a
   * public-suffix list is how `app.example.co.uk` silently gets a cookie
   * scoped to `co.uk`.
   */
  cookieDomain?: string;
}

/** The minimum a config must carry for the target to be resolved. */
export interface TargetConfigShape {
  target?: DeployTarget;
  satellite?: SatelliteConfig;
}

export interface KitProfile {
  kind: "kit";
}

export interface SatelliteProfile {
  kind: "satellite";
  option: SatelliteOption;
  database: SatelliteDatabase;
  issuerOrigin: string;
  cookieDomain: string | undefined;
  /**
   * Option C validates the KIT's session cookie directly. That only works
   * when both deployments hold the same `BETTER_AUTH_SECRET` and the cookie is
   * scoped to a shared parent domain — which is why this flag gates both the
   * "never generate a secret" rule and the COOKIE_DOMAIN rules below.
   */
  sharesSession: boolean;
}

export type DeploymentProfile = KitProfile | SatelliteProfile;

/**
 * Reads the target out of a project config.
 *
 * A missing `target` is the kit — that is the whole backward-compatibility
 * guarantee. Everything else is validated rather than coerced: a config that
 * half-describes a satellite is a configuration bug, and guessing which half
 * is right is exactly the "something clever" that gets an operator hurt.
 */
export function resolveProfile(config: TargetConfigShape): DeploymentProfile {
  const target = config.target ?? "kit";

  if (target !== "kit" && target !== "satellite") {
    throw new CliError(`Unknown deployment target \`${String(target)}\` in .drk-deploy.json.`, {
      hint: 'Use "kit" (the default when absent) or "satellite". Re-run `drk-deploy init`.',
    });
  }

  if (target === "kit") {
    // A satellite block under a kit target is contradictory. Refusing beats
    // picking one: reading it as "kit" would let `migrate` run against a
    // satellite's database, and reading it as "satellite" would silently
    // change what `deploy` builds.
    if (config.satellite) {
      throw new CliError('.drk-deploy.json has a `satellite` block but `target` is "kit".', {
        hint: 'Set "target": "satellite" if this is a satellite, or delete the `satellite` block. Re-run `drk-deploy init` to rewrite it.',
      });
    }
    return { kind: "kit" };
  }

  const satellite = config.satellite;
  if (!satellite) {
    throw new CliError('.drk-deploy.json sets `target: "satellite"` but has no `satellite` block.', {
      hint: "Re-run `drk-deploy init --satellite <standalone|handoff|shared>` to record the option, app checkout and issuer.",
    });
  }
  if (!SATELLITE_OPTIONS.includes(satellite.option)) {
    throw new CliError(`Unknown satellite option \`${String(satellite.option)}\`.`, {
      hint: `Use one of: ${SATELLITE_OPTIONS.join(", ")} (A, B, C).`,
    });
  }
  const database = satellite.database ?? "shared-with-kit";
  if (!SATELLITE_DATABASES.includes(database)) {
    throw new CliError(`Unknown satellite database mode \`${String(satellite.database)}\`.`, {
      hint: `Use one of: ${SATELLITE_DATABASES.join(", ")}.`,
    });
  }
  if (!satellite.appRoot) {
    throw new CliError("The satellite block has no `appRoot` — nothing to build.", {
      hint: "Re-run `drk-deploy init --app-root <path-to-the-satellite-checkout>`.",
    });
  }
  if (!isHttpOrigin(satellite.issuerOrigin)) {
    throw new CliError(`The satellite's \`issuerOrigin\` is not an http(s) URL: ${satellite.issuerOrigin}`, {
      hint: "It must be the KIT's origin, e.g. https://demo.devresponse.ca — the satellite fetches ${issuer}/api/sso/jwks.json from it.",
    });
  }

  return {
    kind: "satellite",
    option: satellite.option,
    database,
    issuerOrigin: originOf(satellite.issuerOrigin) ?? satellite.issuerOrigin,
    cookieDomain: satellite.cookieDomain,
    sharesSession: satellite.option === "shared",
  };
}

export function isSatellite(profile: DeploymentProfile): profile is SatelliteProfile {
  return profile.kind === "satellite";
}

/** How the target is named in headings and status output. */
export function describeProfile(profile: DeploymentProfile): string {
  if (profile.kind === "kit") return "devresponsekit (primary — issuer, schema owner)";
  return `satellite ${optionLabel(profile.option)} — ${profile.sharesSession ? "shared session" : "handoff consumer"}, ${
    profile.database === "own" ? "own database" : "kit's database"
  }`;
}

export function optionLabel(option: SatelliteOption): string {
  switch (option) {
    case "standalone":
      return "standalone (A)";
    case "handoff":
      return "handoff (B)";
    case "shared":
      return "shared (C)";
  }
}

/* ------------------------------------------------------------------ */
/*  Migrations                                                         */
/* ------------------------------------------------------------------ */

export interface MigrationPolicy {
  allowed: boolean;
  /** Printed when allowed, and used as the error message when not. */
  why: string;
  hint?: string;
}

/**
 * May `drk-deploy migrate` touch this deployment's schema?
 *
 * The dangerous case is a satellite sharing the kit's database. Migrations are
 * run from the KIT checkout (the satellites carry a truncated migration set and
 * a pre-checksum runner), so `migrate` from a satellite config would apply the
 * kit's migrations while every other signal — the project, the origin, the
 * environment — says "satellite". If the operator then points it at the wrong
 * connection string, the kit's database is the thing that breaks.
 *
 * The satellites already refuse their own `db:*` scripts for precisely this
 * reason. This mirrors that refusal on the deployment side, and there is no
 * `--force`: the escape is to record in the config that the satellite genuinely
 * owns its database, which is a decision that survives the session.
 */
export function migrationPolicy(profile: DeploymentProfile): MigrationPolicy {
  if (profile.kind === "kit") {
    return { allowed: true, why: "the kit owns the schema" };
  }
  if (profile.database === "own") {
    return {
      allowed: true,
      why: 'this satellite owns its database (recorded as `database: "own"`), so the kit\'s migration set is applied to it',
    };
  }
  return {
    allowed: false,
    why: "Refusing to migrate: this satellite runs against the KIT's database and does not own its schema.",
    hint: "Run migrations from the kit's deployment instead (a `drk-deploy` checkout configured for the kit). If this satellite genuinely has its OWN database, re-run `drk-deploy init --own-database` so the decision is recorded, then migrate with an explicit --database-url.",
  };
}

/* ------------------------------------------------------------------ */
/*  Configuration sanity (pure, so it can be asserted in tests)        */
/* ------------------------------------------------------------------ */

export interface ConfigProblem {
  what: string;
  why: string;
  hint?: string;
}

export interface SatelliteCheckInput {
  profile: SatelliteProfile;
  /** This deployment's own origin (`config.origin`). */
  origin: string;
  applicationId: string;
  audiencePrefix: string;
}

/**
 * The satellite-specific configuration mistakes that are invisible until a
 * user hits them, each of which has a single unambiguous right answer.
 */
export function satelliteConfigProblems(input: SatelliteCheckInput): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const own = originOf(input.origin);
  const issuer = originOf(input.profile.issuerOrigin);

  if (issuer === null) {
    problems.push({
      what: "SSO_HANDOFF_ISSUER",
      why: `\`${input.profile.issuerOrigin}\` is not an http(s) origin; the satellite fetches its JWKS from it`,
      hint: "Set it to the kit's origin, e.g. https://demo.devresponse.ca",
    });
  } else if (own !== null && issuer === own) {
    // `jwt-handoff.server.ts` treats "issuer origin === my origin" as
    // self-issuance and verifies against a LOCAL key set. A satellite has no
    // keys, so every handoff would fail with a signature error that looks
    // like the issuer's fault.
    problems.push({
      what: "SSO_HANDOFF_ISSUER",
      why: "points at this deployment's own origin — a satellite that names itself as issuer verifies handoffs against its own (empty) key set, so every handoff fails",
      hint: "It must be the KIT's origin, not this app's.",
    });
  }

  if (input.profile.sharesSession) {
    const domain = input.profile.cookieDomain;
    if (!domain) {
      problems.push({
        what: "COOKIE_DOMAIN",
        why: "Option C shares the kit's session cookie; without a parent domain the cookie stays scoped to this host and the shared session silently does not work",
        hint: "Re-run `drk-deploy init --cookie-domain .example.com` with the domain BOTH hosts sit under.",
      });
    } else if (own !== null && !hostSitsUnder(hostOf(own), domain)) {
      problems.push({
        what: "COOKIE_DOMAIN",
        why: `this deployment's host is not under \`${domain}\`, so the browser discards the cookie outright`,
        hint: "Use a domain both the kit and this app sit under.",
      });
    } else if (!isCookieDomainShaped(domain)) {
      problems.push({
        what: "COOKIE_DOMAIN",
        why: `\`${domain}\` has no dot — a cookie cannot be scoped to a bare public suffix`,
        hint: "Use the registrable domain, e.g. .example.com",
      });
    }
  }

  if (!input.applicationId.trim()) {
    problems.push({
      what: "SSO_HANDOFF_APPLICATION_ID",
      why: "is empty; the consume endpoint computes its expected audience from it and would 500 on the first handoff",
    });
  }
  if (!input.audiencePrefix.trim()) {
    problems.push({
      what: "SSO_HANDOFF_AUDIENCE_PREFIX",
      why: "is empty; it must match the kit's exactly or every handoff is rejected as the wrong audience",
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/*  Small URL / domain helpers                                         */
/* ------------------------------------------------------------------ */

/** `protocol//host` for an http(s) URL, else null. */
export function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isHttpOrigin(value: string | undefined | null): boolean {
  return originOf(value) !== null;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

/**
 * A cookie domain needs at least one dot: `.ca` is a public suffix, not a site.
 *
 * A SHAPE check, and only that. Without a public-suffix list it cannot tell
 * `.co.uk` (a two-label public suffix, which a browser will also reject) from
 * `.example.com`, and shipping a PSL to validate one variable is not a trade
 * worth making here. Two things cover the gap: `hostSitsUnder`, which rejects
 * a domain this deployment's host does not actually sit under, and `init`,
 * which shows its parent-domain guess to a human rather than using it.
 */
export function isCookieDomainShaped(domain: string): boolean {
  const bare = domain.replace(/^\./, "");
  return bare.includes(".") && !bare.endsWith(".");
}

/**
 * True when `host` would actually receive a cookie scoped to `domain`.
 *
 * A leading dot is the historical spelling and is accepted (browsers strip it).
 * The check is exact-or-subdomain — a suffix match would happily accept
 * `evil-example.com` for `example.com`.
 */
export function hostSitsUnder(host: string, domain: string): boolean {
  const h = host.toLowerCase().split(":")[0] ?? "";
  const d = domain.toLowerCase().replace(/^\./, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}
