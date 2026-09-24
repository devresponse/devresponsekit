import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ProjectConfig,
  defaultKitRoot,
  loadConfig,
  requireToken,
  saveConfig,
  saveToken,
  tokenSource,
} from "../lib/config.js";
import { assertKitRoot, assertSatelliteRoot } from "../lib/kit.js";
import { CliError, bold, dim, field, heading, info, mask, ok, step, warn } from "../lib/log.js";
import {
  SATELLITE_OPTIONS,
  SATELLITE_OPTION_SUMMARIES,
  type SatelliteConfig,
  type SatelliteOption,
  describeProfile,
  isHttpOrigin,
  originOf,
  resolveProfile,
  satelliteConfigProblems,
} from "../lib/target.js";
import { VercelClient } from "../lib/vercel-client.js";
import { reportContainment } from "./env.js";

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ` ${dim(`[${fallback}]`)}` : "";
    const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

/** A yes/no prompt that defaults to the SAFE answer when the operator just hits enter. */
async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = await ask(`${question} (y/n)`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}

/**
 * `drk-deploy login` — stores an access token after proving it works.
 *
 * The token is written to the user profile, never the repo. A token that
 * cannot list projects is rejected here rather than at the first deploy.
 */
export async function login(options: { token?: string }): Promise<void> {
  heading("Vercel authentication");

  const token =
    options.token ?? (await ask("Paste a Vercel access token (https://vercel.com/account/tokens)"));
  if (!token) throw new CliError("No token supplied.");

  step("Verifying the token against the Vercel API");
  const client = new VercelClient(token);
  await client.whoami();
  ok("Token accepted");

  const file = saveToken(token);
  ok(`Saved to ${file} ${dim("(user profile, not the repository)")}`);
  if (process.env.VERCEL_TOKEN) {
    warn("VERCEL_TOKEN is also set in this shell and takes precedence over the saved token.");
  }
}

export interface InitOptions {
  project?: string;
  team?: string;
  domain?: string;
  appName?: string;
  kitRoot?: string;
  create?: boolean;
  yes?: boolean;
  /* --- satellite --- */
  satellite?: string;
  appRoot?: string;
  issuer?: string;
  cookieDomain?: string;
  applicationId?: string;
  audiencePrefix?: string;
  ownDatabase?: boolean;
  kitDatabase?: boolean;
}

/**
 * `drk-deploy init` — links this checkout to a Vercel project and records the
 * handful of settings every other command needs.
 *
 * Nothing here touches the deployment: it writes one gitignored JSON file.
 *
 * It configures either target. `--satellite <standalone|handoff|shared>` makes
 * this a satellite, and re-running `init` on an existing satellite config KEEPS
 * it a satellite — silently demoting one back to "kit" would re-enable
 * migrations against a database it does not own, which is the single most
 * expensive mistake this CLI can make.
 */
export async function init(cliRoot: string, options: InitOptions): Promise<void> {
  const existing = loadConfig(cliRoot);
  const wasSatellite = existing?.target === "satellite";
  const isSatellite = options.satellite !== undefined || wasSatellite;
  /**
   * A KIT config being turned into a SATELLITE config, in place.
   *
   * This is the one transition where inheriting the previous answers is
   * dangerous rather than convenient, because the inherited value would be the
   * PRIMARY's. A satellite carrying the kit's `projectId` is not a mildly wrong
   * config: `env:check` then reads the KIT's project, reports its real
   * SSO_HANDOFF_PRIVATE_KEY and SSO_ALLOWED_ORIGIN_SUFFIXES under "Must NOT be
   * set on this satellite", and points at `env:prune` — which would delete the
   * issuer's signing key and break handoff verification for the whole fleet.
   * `deploy` would likewise promote the satellite's build into the kit's
   * project. So the project and the domain are re-asked here, never inherited.
   */
  const converting = existing !== null && !wasSatellite && options.satellite !== undefined;

  heading(isSatellite ? "Link a satellite to a Vercel project" : "Link a Vercel project");

  if (tokenSource() === "none") {
    throw new CliError("No Vercel access token found.", { hint: "Run `drk-deploy login` first." });
  }
  const token = requireToken();

  const teamId = options.team ?? existing?.teamId;
  const client = new VercelClient(token, teamId);

  if (converting && !options.project) {
    throw new CliError("Converting a kit config into a satellite needs an explicit --project.", {
      hint: "A satellite is its OWN Vercel project — it is never the kit's, and inheriting the kit's id would point env:prune and deploy at the primary. Prefer a SEPARATE vercel-cli checkout per deployment (one .drk-deploy.json describes one deployment); if you really mean to convert this one, pass --project <name|id> and --domain <host>.",
    });
  }

  let projectRef = options.project ?? (converting ? undefined : existing?.projectId);
  if (!projectRef && !options.yes) {
    step("Projects visible to this token:");
    const projects = await client.listProjects();
    if (projects.length === 0) {
      info(dim("  (none — pass --create to make one)"));
    }
    for (const p of projects.slice(0, 15)) field(p.name, dim(p.id), 32);
    projectRef = await ask("Project name or id");
  }
  if (!projectRef) throw new CliError("No project specified.", { hint: "Pass --project <name|id>." });

  let project;
  try {
    project = await client.getProject(projectRef);
    ok(`Linked to ${bold(project.name)} ${dim(project.id)}`);
  } catch (err) {
    if (!options.create) throw err;
    step(`Creating project ${projectRef}`);
    project = await client.createProject(projectRef);
    ok(`Created ${bold(project.name)} ${dim(project.id)}`);
  }

  // Belt and braces: `--project` was demanded above, but it is a name-or-id and
  // may still resolve to the very project this config already points at. A
  // satellite and the kit are never the same Vercel project.
  if (converting && existing && project.id === existing.projectId) {
    throw new CliError(`That is the project this config already points at (${project.id}) — the kit's.`, {
      hint: "A satellite is a separate Vercel project with its own environment. Deploying one into the kit's project would promote the satellite's build over the primary, and `env:prune` would delete the issuer's SSO_HANDOFF_PRIVATE_KEY. Create or name the satellite's own project.",
    });
  }

  const inferredDomain = project.aliases.find((a) => !a.endsWith(".vercel.app")) ?? project.aliases[0];
  const domain =
    options.domain ??
    // Same reasoning as the project: on a conversion the recorded origin is the
    // KIT's, and a satellite deployed on the kit's origin is a satellite that
    // names itself as its own SSO issuer.
    (converting ? undefined : existing?.origin?.replace(/^https?:\/\//, "")) ??
    (options.yes ? inferredDomain : await ask("Production domain", inferredDomain));
  if (!domain) {
    throw new CliError("No production domain known for this project.", {
      hint: "Pass --domain <host>. Every URL the app mints (auth callbacks, the SSO issuer) is built from it.",
    });
  }
  const origin = domain.startsWith("http") ? domain.replace(/\/$/, "") : `https://${domain}`;

  // The kit checkout stays recorded for BOTH targets: it is where migrations
  // come from (the satellites' own runners are the refusal stub), and it is
  // what "run it in the kit instead" points at.
  const kitRoot = options.kitRoot ?? existing?.kitRoot ?? defaultKitRoot(cliRoot);
  if (!existsSync(kitRoot)) throw new CliError(`Kit checkout not found at ${kitRoot}`);
  assertKitRoot(kitRoot);

  const satellite = isSatellite
    ? await configureSatellite({ options, existing, origin, kitRoot })
    : undefined;

  const config: ProjectConfig = {
    ...(satellite ? { target: "satellite" as const, satellite } : {}),
    projectId: project.id,
    ...(teamId ? { teamId } : {}),
    origin,
    appName: options.appName ?? existing?.appName ?? project.name,
    audiencePrefix: options.audiencePrefix ?? existing?.audiencePrefix ?? "devresponse-app",
    applicationId:
      options.applicationId ??
      (satellite ? satelliteApplicationId(satellite.option, existing, wasSatellite) : undefined) ??
      existing?.applicationId ??
      "portal",
    kitRoot,
  };

  // Resolve before writing: a config this CLI would refuse to read is not a
  // config worth saving.
  const profile = resolveProfile(config);
  saveConfig(cliRoot, config);

  heading("Saved");
  field("target", describeProfile(profile));
  field("project", `${project.name} ${dim(config.projectId)}`);
  field("team", config.teamId ?? dim("(personal account)"));
  field("origin", config.origin);
  field("application id", config.applicationId);
  if (satellite) {
    field("app checkout", satellite.appRoot);
    field("sso issuer", `${satellite.issuerOrigin} ${dim("(the kit — NOT this app)")}`);
    field("database", satellite.database === "own" ? "its own" : "the kit's (migrations refused)");
    if (satellite.cookieDomain) field("cookie domain", satellite.cookieDomain);
  }
  field("kit checkout", config.kitRoot);
  field("token", mask(token));

  if (profile.kind === "satellite") {
    const problems = satelliteConfigProblems({
      profile,
      origin: config.origin,
      applicationId: config.applicationId,
      audiencePrefix: config.audiencePrefix,
    });
    if (problems.length > 0) {
      heading("Still wrong");
      for (const problem of problems) {
        field(problem.what, problem.why, 26);
        if (problem.hint) info(`    ${dim(problem.hint)}`);
      }
      info("");
      warn("The config was saved, but `env:check` will report these until they are fixed.");
    }
    // Where the topology is chosen, so where it is first said (F-24).
    reportContainment(profile, config.origin);
  }

  info("");
  info(`Next: ${bold("drk-deploy env:check")} to see what the deployment still needs.`);
}

/** The satellite's default SSO application id: its option name, per .env.example. */
function satelliteApplicationId(
  option: SatelliteOption,
  existing: ProjectConfig | null,
  wasSatellite: boolean,
): string {
  // Only reuse the recorded id when the config was ALREADY a satellite:
  // inheriting the kit's `portal` would give the satellite the primary's
  // audience, and an audience collision is precisely what the application id
  // exists to prevent.
  if (wasSatellite && existing?.applicationId) return existing.applicationId;
  return option;
}

/**
 * Collects the satellite-specific settings, prompting for what is missing.
 *
 * Everything here has a wrong answer that looks fine: an issuer pointing at the
 * satellite itself, a cookie domain the host does not sit under, a database
 * marked "own" when it is really the kit's. Each is validated at the point it
 * is entered rather than at the point it breaks.
 */
async function configureSatellite(input: {
  options: InitOptions;
  existing: ProjectConfig | null;
  origin: string;
  /** Passed through so a `--app-root` that IS the kit is refused by path too. */
  kitRoot: string;
}): Promise<SatelliteConfig> {
  const { options, existing, origin, kitRoot } = input;
  const previous = existing?.satellite;

  /* ---- Which option (A/B/C) ---- */
  const optionRaw = options.satellite ?? previous?.option ?? "";
  if (optionRaw && !SATELLITE_OPTIONS.includes(optionRaw as SatelliteOption)) {
    throw new CliError(`Unknown satellite option \`${optionRaw}\`.`, {
      hint: `Use one of: ${SATELLITE_OPTIONS.join(", ")} — A (own session + handoff), B (handoff, table-less), C (shared session).`,
    });
  }
  let option = optionRaw as SatelliteOption;
  if (!option) {
    if (options.yes) {
      throw new CliError("No satellite option given.", {
        hint: `Pass --satellite <${SATELLITE_OPTIONS.join("|")}>.`,
      });
    }
    info("");
    info(`  ${bold("standalone")} (A) — ${SATELLITE_OPTION_SUMMARIES.standalone}`);
    info(`  ${bold("handoff")}    (B) — ${SATELLITE_OPTION_SUMMARIES.handoff}`);
    info(`  ${bold("shared")}     (C) — ${SATELLITE_OPTION_SUMMARIES.shared}`);
    // A and B are asked about their database below, and the default answer is
    // the KIT's. Said here too, because this list used to promise A its "own
    // database" (F-24).
    info(dim("  A and B run on the KIT's database unless you record otherwise below."));
    const answer = await ask("Satellite option", "standalone");
    if (!SATELLITE_OPTIONS.includes(answer as SatelliteOption)) {
      throw new CliError(`Unknown satellite option \`${answer}\`.`);
    }
    option = answer as SatelliteOption;
  }

  /* ---- The checkout that gets built ---- */
  let appRoot = options.appRoot ?? previous?.appRoot ?? "";
  if (!appRoot && !options.yes) {
    appRoot = await ask("Path to the satellite checkout (the app folder)");
  }
  if (!appRoot) {
    throw new CliError("No satellite checkout given.", {
      hint: "Pass --app-root <path>, e.g. C:\\my\\repos\\devresponseapps\\app-standalone",
    });
  }
  appRoot = resolve(appRoot);
  if (!existsSync(appRoot)) throw new CliError(`Satellite checkout not found at ${appRoot}`);
  const checkout = assertSatelliteRoot(appRoot, kitRoot);
  ok(`Satellite checkout ${bold(checkout.name)} ${dim(appRoot)}`);

  /* ---- The issuer: the KIT, never this app ---- */
  let issuerOrigin = options.issuer ?? previous?.issuerOrigin ?? "";
  if (!issuerOrigin && !options.yes) {
    issuerOrigin = await ask("The KIT's origin (its SSO issuer URL)", "https://demo.devresponse.ca");
  }
  if (!issuerOrigin) {
    throw new CliError("No SSO issuer given.", {
      hint: "Pass --issuer https://<the kit's domain>. A satellite verifies handoffs against ${issuer}/api/sso/jwks.json.",
    });
  }
  if (!isHttpOrigin(issuerOrigin)) {
    throw new CliError(`\`${issuerOrigin}\` is not an http(s) origin.`, {
      hint: "It must be a URL, e.g. https://demo.devresponse.ca — the JWKS document is fetched from it.",
    });
  }
  if (originOf(issuerOrigin) === originOf(origin)) {
    // Caught here rather than at the first handoff: `jwt-handoff.server.ts`
    // reads "issuer === my origin" as self-issuance and verifies against a
    // local key set the satellite does not have.
    throw new CliError("The SSO issuer must not be this deployment's own origin.", {
      hint: "A satellite verifies handoffs against the KIT's published keys. Point --issuer at the kit.",
    });
  }

  /* ---- Who owns the database ---- */
  let database: SatelliteConfig["database"] = previous?.database ?? "shared-with-kit";
  if (options.ownDatabase && options.kitDatabase) {
    throw new CliError("--own-database and --kit-database contradict each other.");
  }
  if (options.ownDatabase) database = "own";
  else if (options.kitDatabase) database = "shared-with-kit";
  else if (!options.yes && previous?.database === undefined) {
    if (option === "shared") {
      // Option C is defined by sharing the primary's schema. There is no
      // question to ask.
      info(dim("  Option C shares the KIT's database by definition — migrations will be refused."));
      database = "shared-with-kit";
    } else {
      info("");
      if (checkout.databaseOwnedByKit) {
        info(dim(`  ${checkout.name} disables its own db:* scripts, which is that app stating it does`));
        info(dim("  not own its schema. Answering yes here means you have given this deployment a"));
        info(dim("  SEPARATE database that the kit's migrations may be applied to."));
      }
      // The default answer is the uncontained topology, so it is named before
      // anyone takes it (F-24).
      info(dim("  No (the default) keeps it on the KIT's database, where a compromise of this app"));
      info(dim("  reaches the kit's auth tables: security-equivalent to Option C, not contained."));
      // Yes is taken at its word from here on (the CLI never sees the value of
      // DATABASE_URL), so it has to mean the credentials too.
      info(dim("  Yes contains it only if its DATABASE_URL signs in as its OWN role: a new database"));
      info(dim("  reached as the kit's role is no boundary, because roles are cluster-wide."));
      database = (await confirm("Does this satellite have its OWN database?", false))
        ? "own"
        : "shared-with-kit";
    }
  }
  if (option === "shared" && database === "own") {
    throw new CliError("An Option C satellite cannot own its database.", {
      hint: "Option C reads the PRIMARY's user and session tables — that is what makes the shared session work. Use --satellite standalone or handoff if this app has its own database.",
    });
  }

  /* ---- Option C only: the shared cookie domain ---- */
  let cookieDomain = options.cookieDomain ?? previous?.cookieDomain;
  if (option === "shared" && !cookieDomain && !options.yes) {
    const host = new URL(origin).hostname;
    const suggestion = suggestParentDomain(host);
    info("");
    info(dim("  Option C shares one session cookie with the kit, so the cookie must be scoped to a"));
    info(dim("  domain BOTH hosts sit under. It is never guessed for you — confirm or correct it."));
    cookieDomain = await ask("Cookie domain", suggestion);
  }
  if (option === "shared" && !cookieDomain) {
    throw new CliError("An Option C satellite needs a cookie domain.", {
      hint: "Pass --cookie-domain .example.com — the domain both the kit and this app sit under. Without it the kit's session is never presented here and users appear randomly signed out.",
    });
  }
  if (option !== "shared" && cookieDomain) {
    // A and B hold their own session; a parent cookie would shadow it.
    warn("COOKIE_DOMAIN is only for Option C — it is being dropped from this config.");
    cookieDomain = undefined;
  }

  return {
    option,
    appRoot,
    issuerOrigin: originOf(issuerOrigin) ?? issuerOrigin,
    database,
    ...(cookieDomain ? { cookieDomain } : {}),
  };
}

/**
 * A SUGGESTION for the shared cookie domain, shown for a human to confirm.
 *
 * Deliberately not used as a value: dropping the first label is right for
 * `app.example.com` and wrong for `app.example.co.uk`, and getting it wrong
 * means the browser silently discards the cookie. Prompting keeps a person in
 * the loop; `--cookie-domain` is how a script states it.
 */
export function suggestParentDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 3) return `.${host}`;
  return `.${labels.slice(1).join(".")}`;
}
