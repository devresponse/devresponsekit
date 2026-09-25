import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DeploymentContext } from "./env-spec.js";
import { CliError } from "./log.js";
import { type DeployTarget, type SatelliteConfig, resolveProfile } from "./target.js";

/**
 * Project settings live in the repo (`vercel-cli/.drk-deploy.json`, gitignored);
 * the access token lives in the user profile, never in the repo, so a stray
 * `git add -A` can never commit it.
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

const CONFIG_FILE = ".drk-deploy.json";

export function configPath(cliRoot: string): string {
  return join(cliRoot, CONFIG_FILE);
}

export function loadConfig(cliRoot: string): ProjectConfig | null {
  const file = configPath(cliRoot);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ProjectConfig;
  } catch (err) {
    throw new CliError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`, {
      hint: "Delete it and re-run `drk-deploy init`.",
    });
  }
}

export function requireConfig(cliRoot: string): ProjectConfig {
  const config = loadConfig(cliRoot);
  if (!config) {
    throw new CliError("This deployment is not configured yet.", {
      hint: "Run `drk-deploy init` first.",
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
