import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import {
  type ProjectConfig,
  defaultKitRoot,
  loadConfig,
  requireToken,
  saveConfig,
  saveToken,
  tokenSource,
} from "../lib/config.js";
import { assertKitRoot } from "../lib/kit.js";
import { CliError, bold, dim, field, heading, info, mask, ok, step, warn } from "../lib/log.js";
import { VercelClient } from "../lib/vercel-client.js";

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

/**
 * `drk-deploy init` — links this checkout to a Vercel project and records the
 * handful of settings every other command needs.
 *
 * Nothing here touches the deployment: it writes one gitignored JSON file.
 */
export async function init(
  cliRoot: string,
  options: {
    project?: string;
    team?: string;
    domain?: string;
    appName?: string;
    kitRoot?: string;
    create?: boolean;
    yes?: boolean;
  },
): Promise<void> {
  heading("Link a Vercel project");

  if (tokenSource() === "none") {
    throw new CliError("No Vercel access token found.", { hint: "Run `drk-deploy login` first." });
  }
  const token = requireToken();
  const existing = loadConfig(cliRoot);

  const teamId = options.team ?? existing?.teamId;
  const client = new VercelClient(token, teamId);

  let projectRef = options.project ?? existing?.projectId;
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

  const inferredDomain = project.aliases.find((a) => !a.endsWith(".vercel.app")) ?? project.aliases[0];
  const domain =
    options.domain ??
    existing?.origin?.replace(/^https?:\/\//, "") ??
    (options.yes ? inferredDomain : await ask("Production domain", inferredDomain));
  if (!domain) {
    throw new CliError("No production domain known for this project.", {
      hint: "Pass --domain <host>. Every URL the app mints (auth callbacks, the SSO issuer) is built from it.",
    });
  }
  const origin = domain.startsWith("http") ? domain.replace(/\/$/, "") : `https://${domain}`;

  const kitRoot = options.kitRoot ?? existing?.kitRoot ?? defaultKitRoot(cliRoot);
  if (!existsSync(kitRoot)) throw new CliError(`Kit checkout not found at ${kitRoot}`);
  assertKitRoot(kitRoot);

  const config: ProjectConfig = {
    projectId: project.id,
    ...(teamId ? { teamId } : {}),
    origin,
    appName: options.appName ?? existing?.appName ?? project.name,
    audiencePrefix: existing?.audiencePrefix ?? "devresponse-app",
    applicationId: existing?.applicationId ?? "portal",
    kitRoot,
  };
  saveConfig(cliRoot, config);

  heading("Saved");
  field("project", `${project.name} ${dim(config.projectId)}`);
  field("team", config.teamId ?? dim("(personal account)"));
  field("origin", config.origin);
  field("kit checkout", config.kitRoot);
  field("token", mask(token));
  info("");
  info(`Next: ${bold("drk-deploy env:check")} to see what the deployment still needs.`);
}
