import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE, commandFor, selectedConfigFile } from "./config-file.js";
import type { DeploymentContext } from "./env-spec.js";
import { CliError } from "./log.js";
import { type DeployTarget, type SatelliteConfig, resolveProfile } from "./target.js";

/**
 * Project settings live in the repo (`vercel-cli/.drk-deploy.json`, gitignored,
 * or the per-deployment file `--config` names, F-50); the access token lives in
 * the user profile, never in the repo, so a stray `git add -A` can never commit
 * it.
 */

export interface ProjectConfig {
  /**
   * WHAT is being deployed. Absent means `kit`, which is the shape every
   * config written before satellites existed has — those keep behaving
   * exactly as they did. See `lib/target.ts` for why the two differ so much.
   */
  target?: DeployTarget;
  /** Present only when `target` is `satellite`. */
  satellite?: SatelliteConfig;
  /** Vercel project id (prj_…) or name. */
  projectId: string;
  /** Vercel team id (team_…). Omitted for a personal account. */
  teamId?: string;
  /**
   * The project's owner, as the Vercel CLI's VERCEL_ORG_ID names it: the
   * project's `accountId`, which `init` reads from the project itself. It is
   * the team id for a team and the account's own id for a personal account.
   * Every `vercel` child is handed VERCEL_PROJECT_ID only together with it
   * (F-48). A config written before F-48 has none, and falls back to
   * `teamId`, or else to the checkout's `.vercel/project.json`, checked
   * against `projectId` (`lib/vercel-project.ts`).
   */
  orgId?: string;
  /** The production origin, e.g. https://demo.example.com. */
  origin: string;
  /** Product name for NEXT_PUBLIC_APP_NAME. */
  appName: string;
  /** SSO audience prefix (default devresponse-app). */
  audiencePrefix: string;
  /** This deployment's SSO application id (default portal). */
  applicationId: string;
  /** Absolute path to the devresponsekit checkout that owns the schema. */
  kitRoot: string;
  // There is deliberately no field naming the migration URL. One existed
  // (`migrationUrlEnvVar`), documented as a safeguard and read by nothing, so
  // a config carrying it still migrated whatever the shell's DATABASE_URL
  // said (F-47). The URL is named per run instead (`--database-url`, or
  // PRODUCTION_DIRECT_DATABASE_URL in the shell or the --from-env file) and
  // checked against production's own DATABASE_URL before anything migrates.
}

export { commandFor, configFileFrom, useConfigFile } from "./config-file.js";

export function configPath(cliRoot: string): string {
  return selectedConfigFile() ?? join(cliRoot, DEFAULT_CONFIG_FILE);
}

/**
 * The `init` that records THIS satellite again from another checkout, with
 * the deployment named in full from what the file records (F-50): its
 * project, domain, application id, option and database, and its cookie domain
 * for Option C. `appRoot` is the checkout as it is to be printed, a path or a
 * placeholder.
 *
 * A moved or re-cloned checkout is a new `--app-root`, and `init` treats a new
 * checkout as another deployment unless it is named in full, because another
 * folder is far more often another app. So the fix `deploy` prints for a
 * checkout that no longer exists is this command rather than a bare
 * `init --app-root`, which would be refused. The fleet's settings (the issuer,
 * the audience prefix, the team, the kit checkout) need no flag, and the
 * product name is kept because the project is the recorded one.
 */
export function sameDeploymentInit(
  config: Pick<ProjectConfig, "projectId" | "origin" | "applicationId"> & { satellite: SatelliteConfig },
  appRoot: string,
): string {
  const { satellite } = config;
  const database =
    satellite.option === "shared" ? [] : [satellite.database === "own" ? "--own-database" : "--kit-database"];
  return commandFor(
    [
      "init",
      `--project ${config.projectId}`,
      // init reads a bare host as https://, and takes any other origin whole.
      `--domain ${config.origin.replace(/^https:\/\//, "")}`,
      `--application-id ${config.applicationId}`,
      `--satellite ${satellite.option}`,
      `--app-root ${appRoot}`,
      ...database,
      ...(satellite.cookieDomain ? [`--cookie-domain ${satellite.cookieDomain}`] : []),
    ].join(" "),
  );
}

export function loadConfig(cliRoot: string): ProjectConfig | null {
  const file = configPath(cliRoot);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ProjectConfig;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`, {
      hint: `Delete it and re-run \`${commandFor("init")}\`.`,
    });
  }
}

export function requireConfig(cliRoot: string): ProjectConfig {
  const config = loadConfig(cliRoot);
  if (!config) {
    throw new CliError(`This deployment is not configured yet: there is no ${configPath(cliRoot)}.`, {
      hint: selectedConfigFile()
        ? `Run \`${commandFor("init")}\` first, or check which file --config or DRK_DEPLOY_CONFIG names.`
        : "Run `drk-deploy init` first.",
    });
  }
  return config;
}

export function saveConfig(cliRoot: string, config: ProjectConfig): void {
  writeFileSync(configPath(cliRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/*  Access token                                                       */
/* ------------------------------------------------------------------ */

function credentialsFile(): string {
  return join(homedir(), ".drk-deploy", "credentials.json");
}

/**
 * Resolution order: `VERCEL_TOKEN` (what CI sets) beats the stored token, so a
 * pipeline never accidentally uses a developer's saved credential.
 */
export function resolveToken(): string | null {
  const fromEnv = process.env.VERCEL_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const file = credentialsFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
    return parsed.token?.trim() || null;
  } catch {
    return null;
  }
}

export function requireToken(): string {
  const token = resolveToken();
  if (!token) {
    throw new CliError("No Vercel access token found.", {
      hint: "Run `drk-deploy login`, or set VERCEL_TOKEN. Create a token at https://vercel.com/account/tokens",
    });
  }
  return token;
}

export function saveToken(token: string): string {
  const file = credentialsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    // No-op on Windows, meaningful everywhere else.
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return file;
}

export function tokenSource(): "env" | "file" | "none" {
  if (process.env.VERCEL_TOKEN?.trim()) return "env";
  return existsSync(credentialsFile()) ? "file" : "none";
}

/** The kit checkout this CLI lives inside, unless configured otherwise. */
export function defaultKitRoot(cliRoot: string): string {
  return resolve(cliRoot, "..");
}

/* ------------------------------------------------------------------ */
/*  Target-aware views of the config                                   */
/* ------------------------------------------------------------------ */

/**
 * The checkout `vercel pull/build/deploy` runs in.
 *
 * For the kit that is the kit itself; for a satellite it is the satellite's
 * own app folder. The kit checkout stays recorded either way, because it is
 * still where migrations come from (the satellites' migration runners are
 * deliberately disabled) and it is what the "run it in the kit instead"
 * message points at.
 */
export function deployRoot(config: ProjectConfig): string {
  const profile = resolveProfile(config);
  if (profile.kind === "satellite") {
    // resolveProfile has already refused a satellite target with no block.
    return config.satellite!.appRoot;
  }
  return config.kitRoot;
}

/** Everything the environment contract needs to know about this deployment. */
export function deploymentContext(config: ProjectConfig): DeploymentContext {
  return {
    profile: resolveProfile(config),
    origin: config.origin,
    appName: config.appName,
    audiencePrefix: config.audiencePrefix,
    applicationId: config.applicationId,
  };
}
