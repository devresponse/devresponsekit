import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandFor } from "./config-file.js";
import type { ProjectConfig } from "./config.js";
import { CliError } from "./log.js";
import { type DeploymentProfile, originOf } from "./target.js";
import type { EnvVarSummary, ProjectSummary, VercelClient } from "./vercel-client.js";

/**
 * Which Vercel project the pinned Vercel CLI acts on (F-48).
 *
 * `vercel link`, `pull`, `build` and `deploy` take their project from one of
 * two places (vercel 59.x, `getLinkedProject`): VERCEL_ORG_ID together with
 * VERCEL_PROJECT_ID in their environment, or, when neither is set, the
 * checkout's `.vercel/project.json`. One of the pair set alone is not a
 * fallback. The CLI exits 1 with "You specified `VERCEL_PROJECT_ID` but you
 * forgot to specify `VERCEL_ORG_ID`".
 *
 * This CLI used to set VERCEL_PROJECT_ID always and VERCEL_ORG_ID only for a
 * team, so every deploy from a personal account failed at `vercel pull`, and
 * `build` and `deploy` would have failed the same way. Each child's
 * environment is now built here, and nowhere else: the pair together, or
 * neither.
 */

/**
 * Every variable the pinned Vercel CLI picks its project from. Its
 * `getPlatformEnv` reads `VERCEL_<name>` and falls back to the legacy
 * `NOW_<name>`, so a shell's NOW_PROJECT_ID would pick a project too.
 */
export const PROJECT_SELECTORS = [
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "NOW_ORG_ID",
  "NOW_PROJECT_ID",
] as const;

/**
 * The project's owner, as the Vercel CLI names it: the id `init` recorded from
 * the project itself, or, for a config written before it did, the team id.
 * Null for a personal-account config written before F-48, which then has
 * nothing to put in VERCEL_ORG_ID.
 */
export function projectOwner(config: Pick<ProjectConfig, "orgId" | "teamId">): string | null {
  return config.orgId?.trim() || config.teamId?.trim() || null;
}

/** What {@link vercelEnvFor} hands every `vercel` child. */
export interface VercelEnv {
  /**
   * Layered over the shell's environment for the child (`RunOptions.env`).
   * An `undefined` value removes the shell's variable from the child.
   */
  env: Record<string, string | undefined>;
  /** The owner the environment names, or null when the checkout's link decides. */
  orgId: string | null;
  /** Shell variables that pick a project, are not passed on, and could not be checked. */
  ignored: string[];
}

/**
 * The environment every `vercel` child runs with: the token, and the project
 * named by the pair VERCEL_ORG_ID + VERCEL_PROJECT_ID, or by neither.
 *
 * With an owner recorded, both are set from the config, so the checkout's link
 * cannot pick another project. Without one, both are REMOVED, so the Vercel
 * CLI reads `.vercel/project.json`, which {@link assertCheckoutLink} checks
 * against the config before and after linking.
 *
 * The shell's own values are never passed on, however they are spelled: the
 * child used to inherit them (`run` layers its env over `process.env`), so an
 * exported VERCEL_PROJECT_ID could point a personal-account deploy at another
 * project. A shell value that disagrees with the config is refused rather
 * than ignored. Whoever exported it meant that project, so deploying the
 * config's one instead deploys something nobody asked for. A shell VERCEL_ORG_ID
 * that a config with no owner cannot check is dropped, and reported in
 * `ignored`.
 *
 * Names are scrubbed case-insensitively, as `migrationEnv` does for PG*: on
 * Windows `vercel_project_id` IS VERCEL_PROJECT_ID to the child. They are
 * checked only as the Vercel CLI reads them, though: elsewhere a
 * differently-cased name is another variable, which no `vercel` reads and
 * which is no reason to refuse a deploy. A blank value is unset, as the
 * Vercel CLI reads it.
 */
export function vercelEnvFor(
  config: ProjectConfig,
  token: string,
  shell: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): VercelEnv {
  const orgId = projectOwner(config);
  const spelled: string[] = [];
  const conflicts: string[] = [];
  const ignored: string[] = [];

  for (const [key, raw] of Object.entries(shell)) {
    const name = key.toUpperCase();
    if (!(PROJECT_SELECTORS as readonly string[]).includes(name)) continue;
    spelled.push(key);
    if (key !== name && platform !== "win32") continue;
    const value = raw?.trim();
    if (!value) continue;
    const expected = name.endsWith("PROJECT_ID") ? config.projectId : orgId;
    if (expected === null) ignored.push(key);
    else if (value !== expected) conflicts.push(`${key}=${value}, where this config has ${expected}`);
  }

  if (conflicts.length > 0) {
    throw new CliError("The shell names a different Vercel project than this config. Nothing was run.", {
      exitCode: 2,
      hint: [
        `${conflicts.join("; ")}.`,
        "drk-deploy acts only on the project recorded in its config file (.drk-deploy.json, or the one --config names) and never passes these variables to `vercel`, so whoever exported them would get a deploy of a project they did not name.",
        "Unset them (drk-deploy does not need them), or run with the config (--config) whose deployment names that project.",
      ].join(" "),
    });
  }

  const env: Record<string, string | undefined> = {
    ...Object.fromEntries([...PROJECT_SELECTORS, ...spelled].map((key) => [key, undefined])),
    // The token travels in the environment, never in argv: an argument list
    // is visible to other processes and lands in shell history.
    VERCEL_TOKEN: token,
    ...(orgId ? { VERCEL_ORG_ID: orgId, VERCEL_PROJECT_ID: config.projectId } : {}),
  };
  return { env, orgId, ignored };
}

/** Where `vercel link` records the project a checkout is linked to. */
export function projectLinkFile(root: string): string {
  return join(root, ".vercel", "project.json");
}

/**
 * Refuses a checkout whose `.vercel/project.json` names a project other than
 * the configured one (F-48). `required` also refuses a checkout with no link
 * file: after `vercel link` ran for a config with no recorded owner, that file
 * is the only thing telling `pull`, `build` and `deploy` which project to act
 * on.
 *
 * A mismatch is refused, never re-linked over. The two disagree because one
 * of them is wrong, and when it is the config (a satellite's config carrying
 * the kit's project id), re-linking would point the satellite's build at the
 * kit's project. With an owner recorded the environment would override the
 * file anyway, but the disagreement is still the operator's to resolve.
 *
 * `projectName` counts as well as `projectId`, as it does for the Vercel CLI
 * (`getProjectLink`), because a hand-written config may name the project.
 */
export function assertCheckoutLink(
  root: string,
  config: ProjectConfig,
  options: { required: boolean },
): void {
  const file = projectLinkFile(root);
  if (!existsSync(file)) {
    if (!options.required) return;
    throw new CliError(
      `vercel link wrote no ${file}, so nothing names the project to pull. Nothing was pulled.`,
      {
        exitCode: 2,
        hint: `This config records no project owner, so \`vercel\` finds its project through that file. Re-run \`${commandFor("init")}\` to record the owner (a personal account needs no --team), then re-run.`,
      },
    );
  }

  let link: { projectId?: unknown; projectName?: unknown } = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") link = parsed as typeof link;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`, {
      exitCode: 2,
      hint: `Delete it and re-run: drk-deploy links the checkout to ${config.projectId} itself.`,
    });
  }

  if (link.projectId === config.projectId || link.projectName === config.projectId) return;
  const named = typeof link.projectId === "string" ? link.projectId : "no project id";
  throw new CliError(
    `This checkout is linked to another Vercel project: ${file} names ${named}, and this config deploys ${config.projectId}. Nothing was linked, pulled or deployed.`,
    {
      exitCode: 2,
      hint: [
        "One of the two is wrong, and drk-deploy will not guess which: a satellite checkout linked to the kit's project, or a config carrying another deployment's project id, would build and promote into the wrong project.",
        `If the config is right, delete ${file} and re-run: drk-deploy links the checkout to ${config.projectId}.`,
        `If the checkout is right, re-run \`${commandFor("init")}\` so the config names its project.`,
      ].join(" "),
    },
  );
}

/* ------------------------------------------------------------------ */
/*  F-50: a satellite config never acts on the SSO issuer's project    */
/* ------------------------------------------------------------------ */

/** A host as a Vercel alias names it: lower-case, with no scheme, port, path or trailing dot. */
function aliasHost(alias: string): string {
  const bare = alias
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  return (bare.split("/")[0] ?? "").replace(/:\d*$/, "").replace(/\.$/, "");
}

/** The variables whose value is the origin a deployment serves, when stored readable. */
const SERVED_ORIGIN_KEYS: readonly string[] = ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"];

/**
 * What {@link issuerProjectProblem} judges a project by: the project as
 * `getProject` reports it, and its environment when the command has listed it
 * anyway.
 */
export interface IssuerProjectEvidence {
  project: Pick<ProjectSummary, "id" | "name" | "aliases">;
  env?: ReadonlyArray<Pick<EnvVarSummary, "key" | "value">>;
}

/**
 * Why a SATELLITE config must not act on this Vercel project, or null (F-50).
 *
 * A satellite config names the kit only by its origin (`issuerOrigin`), never
 * by its project id, so the kit's project is recognised by what it serves:
 * one whose production aliases include the issuer's host IS the issuer's. No
 * satellite project may serve that host, because `init` refuses an issuer
 * equal to the satellite's own origin. A listing the command made anyway says
 * the same thing when it stores BETTER_AUTH_URL or NEXT_PUBLIC_APP_URL
 * readable as the issuer's origin, at no extra call, which covers a project
 * whose aliases the API left out.
 *
 * A satellite config carrying the kit's project id is the costliest mistake
 * this CLI can make. Before this check, `deploy --yes` or `--skip-checks`
 * (past the env preflight) built the satellite and promoted it over the
 * primary, `env:sync` wrote the satellite's environment into the kit's, and
 * `env:prune` deleted the issuer's SSO_HANDOFF_PRIVATE_KEY and
 * SSO_ALLOWED_ORIGIN_SUFFIXES, after which the kit published an empty key set
 * and every handoff failed. `init` could produce such a config: re-run with
 * `--project <the kit's>` on a satellite config, it stayed a satellite.
 *
 * The kit is never refused: it IS the issuer.
 */
export function issuerProjectProblem(
  profile: DeploymentProfile,
  evidence: IssuerProjectEvidence,
): string | null {
  if (profile.kind !== "satellite") return null;
  const issuer = originOf(profile.issuerOrigin);
  if (issuer === null) return null;
  const host = new URL(issuer).hostname;
  const { project } = evidence;
  const named = `${project.name} (${project.id})`;
  if (project.aliases.some((alias) => aliasHost(alias) === host)) {
    return `${named} serves ${host}, the SSO issuer's host, so it is the kit's project`;
  }
  const served = evidence.env?.find(
    (entry) =>
      SERVED_ORIGIN_KEYS.includes(entry.key) &&
      entry.value !== undefined &&
      originOf(entry.value.trim()) === issuer,
  );
  if (served) {
    return `${named} stores ${served.key} as ${issuer}, the SSO issuer's origin, so it is the kit's project`;
  }
  return null;
}

/**
 * Refuses a satellite config that points at the SSO issuer's project (F-50),
 * with exit code 2 and nothing changed. No flag overrides it: `--yes` and
 * `--skip-checks` skip the environment preflight, and this is not part of it.
 */
export function assertNotIssuerProject(profile: DeploymentProfile, evidence: IssuerProjectEvidence): void {
  const problem = issuerProjectProblem(profile, evidence);
  if (problem === null) return;
  throw new CliError(
    `This satellite config points at the SSO issuer's own Vercel project: ${problem}. Nothing was changed.`,
    {
      exitCode: 2,
      hint: [
        "A satellite is its own Vercel project, never the kit's. Acting on this one would promote the satellite's build over the primary, write the satellite's environment into the kit's, or remove the issuer's signing key, after which every handoff fails. No flag overrides this, not --yes and not --skip-checks.",
        // Built with the file (F-50): printed bare under --config, this ran on
        // the default file, the KIT's in the recommended layout, and saved the
        // kit's config on the satellite's project.
        `Point this config at the satellite's own project: \`${commandFor("init --project <its project> --domain <its host> --application-id <its id>")}\`. To act on the kit, use a config whose target is the kit, one file per deployment (\`drk-deploy --config <file>\`).`,
      ].join(" "),
    },
  );
}

/**
 * {@link assertNotIssuerProject} for a command with no project read of its
 * own: `env:sync`, `env:check`, `env:prune` and `db:provision` (F-50). It
 * reads the project for a satellite, and nothing for the kit. `env` is the
 * listing the command has already made, when it made one. Call it after the
 * reads and before anything is written or removed.
 */
export async function refuseIssuerProject(
  client: Pick<VercelClient, "getProject">,
  config: Pick<ProjectConfig, "projectId">,
  profile: DeploymentProfile,
  env?: ReadonlyArray<Pick<EnvVarSummary, "key" | "value">>,
): Promise<void> {
  if (profile.kind !== "satellite") return;
  const project = await client.getProject(config.projectId);
  assertNotIssuerProject(profile, { project, ...(env ? { env } : {}) });
}
