import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ProjectConfig,
  commandFor,
  configPath,
  defaultKitRoot,
  loadConfig,
  requireToken,
  sameDeploymentInit,
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
import { assertNotIssuerProject } from "../lib/vercel-project.js";
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
 *
 * A re-run for the SAME deployment keeps every recorded answer it is not
 * given, which is what makes `init --yes` a safe refresh. A run that names a
 * DIFFERENT deployment keeps none of the deployment's own (F-50, see
 * {@link deploymentChanges}), and a satellite config never saves the SSO
 * issuer's own project (`assertNotIssuerProject`).
 */
export async function init(cliRoot: string, options: InitOptions): Promise<void> {
  const existing = loadConfig(cliRoot);
  const wasSatellite = existing?.target === "satellite";
  const isSatellite = options.satellite !== undefined || wasSatellite;
  /**
   * A KIT config being turned into a SATELLITE config, in place: one of the
   * changes {@link deploymentChanges} names, and the one where an inherited
   * value would be the PRIMARY's. A satellite carrying the kit's `projectId`
   * is not a mildly wrong config: `env:check` then read the KIT's project,
   * reported its real SSO_HANDOFF_PRIVATE_KEY and SSO_ALLOWED_ORIGIN_SUFFIXES
   * under "Must NOT be set on this satellite", and pointed at `env:prune`,
   * which deleted the issuer's signing key and broke handoff verification for
   * the whole fleet. `deploy` would likewise promote the satellite's build
   * into the kit's project.
   */
  const converting = existing !== null && !wasSatellite && options.satellite !== undefined;
  /** Why this run configures another deployment than the file records, if it does (F-50). */
  const changes = deploymentChanges(existing, options);
  const newDeployment = changes.length > 0;

  heading(isSatellite ? "Link a satellite to a Vercel project" : "Link a Vercel project");

  // Before the token and before any call: the refusal is about the file, and
  // it has to stop the run before a single recorded value is used.
  if (newDeployment) {
    const missing = unnamedForNewDeployment(options, existing);
    if (missing.length > 0) {
      const moved = movedCheckoutInit(existing, options);
      throw new CliError(
        `${configPath(cliRoot)} records another deployment: ${changes.join("; ")}. A new deployment is named in full: pass ${missing.join(", ")}.`,
        {
          hint: [
            "Nothing of the recorded deployment's own carries over to another one (F-50): its project, domain, application id, database and cookie domain.",
            "Inheriting them built the new app into the previous app's project, under its origin and its SSO audience, and `up` then replaced that app's production and reported it healthy.",
            "Better: give each deployment its own config file, `drk-deploy --config .drk-deploy.<name>.json init ...` (or DRK_DEPLOY_CONFIG), and this one stays as it is.",
            "Re-running init for the SAME deployment (no new --satellite or --app-root) keeps every recorded value.",
            ...(moved
              ? [
                  `The recorded checkout no longer exists. If this is the same app, moved or re-cloned, record it with: \`${moved}\`.`,
                ]
              : []),
          ].join(" "),
        },
      );
    }
  }

  if (tokenSource() === "none") {
    throw new CliError("No Vercel access token found.", { hint: "Run `drk-deploy login` first." });
  }
  const token = requireToken();

  const teamId = options.team ?? existing?.teamId;
  const client = new VercelClient(token, teamId);

  let projectRef = options.project ?? (newDeployment ? undefined : existing?.projectId);
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

  /** The project the file already records: by id, or by the name a hand-written config may carry. */
  const sameProject =
    existing !== null && (existing.projectId === project.id || existing.projectId === project.name);

  // Belt and braces: `--project` was demanded above, but it is a name-or-id and
  // may still resolve to the very project this config already points at. A
  // satellite and the kit are never the same Vercel project. (The issuer check
  // before saving catches the kit's project by its aliases too, F-50; this
  // one needs none.)
  if (converting && sameProject) {
    throw new CliError(`That is the project this config already points at (${project.id}) — the kit's.`, {
      hint: "A satellite is a separate Vercel project with its own environment. Deploying one into the kit's project would promote the satellite's build over the primary and write the satellite's environment over the issuer's. Create or name the satellite's own project.",
    });
  }

  /**
   * The recorded origin is the recorded PROJECT's domain, so it is kept only
   * while the project is the same one (F-50). On a new deployment it is the
   * previous app's (the KIT's, on a conversion, and a satellite on the kit's
   * origin names itself as its own SSO issuer). And a same-deployment re-run
   * with a new --project would otherwise keep the old project's domain. Either
   * way it comes from --domain, or from the named project as on a first `init`.
   */
  const inferredDomain = project.aliases.find((a) => !a.endsWith(".vercel.app")) ?? project.aliases[0];
  const domain =
    options.domain ??
    (newDeployment || !sameProject ? undefined : existing?.origin?.replace(/^https?:\/\//, "")) ??
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
    ? await configureSatellite({
        options,
        previous: recordedSatelliteAnswers(existing, newDeployment),
        origin,
        kitRoot,
      })
    : undefined;

  const config: ProjectConfig = {
    ...(satellite ? { target: "satellite" as const, satellite } : {}),
    projectId: project.id,
    ...(teamId ? { teamId } : {}),
    // The owner as the project itself reports it, never inherited: every
    // `vercel` child gets VERCEL_PROJECT_ID only together with it, and a
    // personal account has no --team to fall back on (F-48).
    ...(project.accountId ? { orgId: project.accountId } : {}),
    origin,
    // The product name is the app's, so a new deployment on another project
    // does not take the previous one's. On the recorded project it is kept:
    // that is the same app from a moved checkout, re-recorded in full as
    // `deploy` prints it, and re-typing the deployment used to reset
    // "Standalone" to the project's name. The audience prefix and the kit
    // checkout are the fleet's, and are kept.
    appName:
      options.appName ?? (newDeployment && !sameProject ? undefined : existing?.appName) ?? project.name,
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
  // Nor is a satellite bound to the SSO issuer's own project (F-50), however
  // it got there: `--project <the kit's>` on a satellite config kept it a
  // satellite. The project was read above, so this costs no call. Every
  // command that would act on the project refuses it again.
  assertNotIssuerProject(profile, { project });
  saveConfig(cliRoot, config);

  heading("Saved");
  field("config file", configPath(cliRoot));
  field("target", describeProfile(profile));
  field("project", `${project.name} ${dim(config.projectId)}`);
  field("team", config.teamId ?? dim("(personal account)"));
  field(
    "owner",
    config.orgId ?? dim("(not reported by Vercel: the checkout's .vercel/project.json will decide)"),
  );
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
  info(`Next: ${bold(commandFor("env:check"))} to see what the deployment still needs.`);
}

/**
 * What makes this run configure a DIFFERENT deployment than the one the file
 * records, as sentences for the refusal, or nothing for a re-run of the same
 * one (F-50).
 *
 * A deployment is what gets built and how it signs in: the target, and for a
 * satellite its option and its checkout. Changing either used to keep
 * everything else. `init --satellite handoff --app-root ...\app-handoff` on
 * app-standalone's config built app-handoff into app-standalone's project,
 * domain and application id, and `up` replaced app-standalone's production
 * with it while the consumer probe reported healthy. Only the kit-to-satellite
 * conversion refused, and only the project. A change of `--satellite` alone
 * kept the other app's checkout too.
 *
 * A satellite config never turns back into the kit's (see `init`), and a kit
 * re-run with another `--kit-root` is the same deployment from a moved
 * checkout.
 *
 * A change is a recorded value replaced by another. A value the file does not
 * record is filled in: a satellite block with no checkout (or no block at
 * all) is a broken file that every other command refuses, and the fix they
 * print, `init --app-root <path>` (`init --satellite <option>`), repairs this
 * deployment rather than naming another. There is no other app's value to
 * carry over.
 *
 * A satellite checkout that moved IS a new `--app-root`: another folder is far
 * more often another app, and nothing here can tell a re-clone from a
 * different app with the same option. {@link movedCheckoutInit} prints the
 * command that names it in full instead.
 */
function deploymentChanges(existing: ProjectConfig | null, options: InitOptions): string[] {
  if (existing === null) return [];
  if (existing.target !== "satellite") {
    return options.satellite !== undefined ? ["it is the kit's, and this run makes it a satellite"] : [];
  }
  const previous = existing.satellite;
  const changes: string[] = [];
  if (options.satellite !== undefined && previous?.option && options.satellite !== previous.option) {
    changes.push(`its satellite option is ${previous.option}, and this run names ${options.satellite}`);
  }
  if (options.appRoot !== undefined && previous?.appRoot && !samePath(options.appRoot, previous.appRoot)) {
    changes.push(`its app checkout is ${previous.appRoot}, and this run names ${resolve(options.appRoot)}`);
  }
  return changes;
}

/**
 * What of the recorded satellite block a run may keep (F-50): all of it for a
 * re-run of the same deployment, and only the issuer, which is the fleet's
 * (every satellite verifies against the one kit), for a new one. The option,
 * checkout, database and cookie domain are the previous app's.
 *
 * `configureSatellite` asks for none of what this returns, which is why it
 * matters most where no flag names it: under --yes a recorded cookie domain
 * would be taken silently, and the interactive database question is put only
 * when nothing is recorded. Inherited, app-standalone's `own` would have
 * recorded app-handoff as owning its database, and so allowed migrating it,
 * without a question.
 */
export function recordedSatelliteAnswers(
  existing: ProjectConfig | null,
  newDeployment: boolean,
): Partial<SatelliteConfig> | undefined {
  if (!newDeployment) return existing?.satellite;
  const issuerOrigin = existing?.satellite?.issuerOrigin;
  return issuerOrigin ? { issuerOrigin } : undefined;
}

/**
 * The `init` that records this satellite from the checkout this run names,
 * named in full from the file (`sameDeploymentInit`), when the refusal is
 * probably about a moved or re-cloned checkout: the option is unchanged and
 * the recorded checkout no longer exists. That is where `deploy` sends an
 * operator whose checkout is gone. Otherwise null: while the recorded checkout
 * exists, another folder is another app far more often than a move, and a
 * ready command would carry the recorded project over to it, which is what
 * F-50 refuses.
 */
function movedCheckoutInit(existing: ProjectConfig | null, options: InitOptions): string | null {
  const previous = existing?.target === "satellite" ? existing.satellite : undefined;
  if (!existing || !previous?.appRoot || options.appRoot === undefined) return null;
  if (options.satellite !== undefined && options.satellite !== previous.option) return null;
  if (existsSync(previous.appRoot)) return null;
  return sameDeploymentInit({ ...existing, satellite: previous }, `"${resolve(options.appRoot)}"`);
}

/** Two checkout paths name one folder: case-blind on Windows, where the file system is. */
function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The flags a new deployment must be given, because nothing of the recorded
 * one's may stand in for them (F-50): its project, domain and application id,
 * and for a satellite what it is (the option), what is built (the checkout)
 * and whose database it runs on. The database is asked for when there is
 * someone to ask, with the kit's as the default answer; under --yes it must be
 * a flag, unless the option is C, which is on the kit's by definition. The
 * issuer is the fleet's and is kept.
 */
function unnamedForNewDeployment(options: InitOptions, existing: ProjectConfig | null): string[] {
  const option = options.satellite ?? existing?.satellite?.option;
  const missing: string[] = [];
  if (!options.project) missing.push("--project <name|id>");
  if (!options.domain) missing.push("--domain <host>");
  if (!options.applicationId) missing.push("--application-id <id>");
  if (!options.satellite) missing.push(`--satellite <${SATELLITE_OPTIONS.join("|")}>`);
  if (!options.appRoot) missing.push("--app-root <path>");
  if (options.yes && option !== "shared" && !options.ownDatabase && !options.kitDatabase) {
    missing.push("--kit-database or --own-database");
  }
  return missing;
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
  /**
   * The recorded answers this run may keep: the whole satellite block for a
   * re-run of the same deployment, only the issuer for a new one (F-50).
   */
  previous: Partial<SatelliteConfig> | undefined;
  origin: string;
  /** Passed through so a `--app-root` that IS the kit is refused by path too. */
  kitRoot: string;
}): Promise<SatelliteConfig> {
  const { options, previous, origin, kitRoot } = input;

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
