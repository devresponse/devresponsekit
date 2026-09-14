import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./log.js";

/**
 * Project settings live in the repo (`vercel-cli/.drk-deploy.json`, gitignored);
 * the access token lives in the user profile, never in the repo, so a stray
 * `git add -A` can never commit it.
 */

export interface ProjectConfig {
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
  /**
   * The DIRECT (non-pooled) connection string used for MIGRATIONS ONLY, if it
   * differs from the pooled runtime DATABASE_URL. Stored as a reference to an
   * env var name, never the value.
   */
  migrationUrlEnvVar?: string;
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
