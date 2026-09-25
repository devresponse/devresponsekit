import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, deployRoot, loadConfig, resolveToken, tokenSource } from "../lib/config.js";
import { pnpmCommand, run } from "../lib/exec.js";
import { coreMigrations } from "../lib/kit.js";
import { CliError, dim, field, green, heading, info, ok, red, warn, yellow } from "../lib/log.js";
import {
  type DeploymentProfile,
  describeProfile,
  migrationPolicy,
  resolveProfile,
  satelliteConfigProblems,
} from "../lib/target.js";
import { VercelClient } from "../lib/vercel-client.js";
import { assertCheckoutLink, projectLinkFile, projectOwner, vercelEnvFor } from "../lib/vercel-project.js";
import { reportContainment } from "./env.js";

const PASS = green("ok");
const FAIL = red("missing");

/**
 * Resolves the target, turning a refusal into a counted problem.
 *
 * `resolveProfile` throws for a config that half-describes a satellite — which
 * is right everywhere else, because guessing which half is correct is how a
 * migration reaches the wrong database. Here it would only rob the operator of
 * the rest of the report.
 */
function readProfile(config: ProjectConfig, bad: (message: string) => string): DeploymentProfile | null {
  try {
    return resolveProfile(config);
  } catch (err) {
    field("config", bad(`${red("unreadable")} — ${(err as Error).message}`));
    if (err instanceof CliError && err.hint) info(`    ${dim(err.hint)}`);
    return null;
  }
}

/**
 * `drk-deploy doctor` — checks the machine and the link before anything is
 * changed, so a deploy fails here (cheaply, with a fix) rather than halfway
 * through a promotion.
 */
export async function doctor(cliRoot: string): Promise<number> {
  let problems = 0;
  const bad = (message: string): string => {
    problems += 1;
    return message;
  };

  heading("Toolchain");
  const node = process.versions.node;
  const nodeMajor = Number(node.split(".")[0]);
  field(
    "node",
    nodeMajor >= 24 ? `${PASS} ${dim(`v${node}`)}` : bad(`${red(`v${node}`)} — the kit needs Node 24+`),
  );

  const pnpm = pnpmCommand();
  const pnpmResult = await run(pnpm.command, [...pnpm.prefix, "--version"], { cwd: cliRoot, capture: true });
  field(
    "pnpm",
    pnpmResult.code === 0
      ? `${PASS} ${dim(pnpmResult.stdout.trim())}`
      : bad(`${FAIL} — needed to run migrations`),
  );

  const vercelBin = join(
    cliRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vercel.cmd" : "vercel",
  );
  field("vercel cli", existsSync(vercelBin) ? PASS : bad(`${FAIL} — run \`pnpm install\` in vercel-cli`));

  heading("Credentials");
  const source = tokenSource();
  field(
    "token",
    source === "none"
      ? bad(`${FAIL} — run \`drk-deploy login\``)
      : `${PASS} ${dim(source === "env" ? "from VERCEL_TOKEN" : "from the user profile")}`,
  );

  if (source !== "none") {
    try {
      await new VercelClient(resolveToken()!).whoami();
      field("api reachable", PASS);
    } catch (err) {
      field("api reachable", bad(`${red("failed")} — ${(err as Error).message}`));
    }
  }

  heading("Project link");
  // Unparseable JSON gets the same treatment as an unresolvable target, for the
  // same reason: `doctor` exists to list what is wrong, so it must survive
  // finding something wrong.
  let config: ProjectConfig | null = null;
  let unreadable = false;
  try {
    config = loadConfig(cliRoot);
  } catch (err) {
    unreadable = true;
    field("config", bad(`${red("unreadable")} — ${(err as Error).message}`));
    if (err instanceof CliError && err.hint) info(`    ${dim(err.hint)}`);
  }
  if (!config) {
    // Absent and unreadable are different facts, and only one of them is fixed
    // by running `init` — so only one of them says to.
    if (!unreadable) field("config", bad(`${FAIL} — run \`drk-deploy init\``));
  } else {
    field("project", `${PASS} ${dim(config.projectId)}`);
    // Not a counted problem: such a config still deploys, through the
    // checkout's link, which is checked against it (F-48).
    const owner = projectOwner(config);
    field(
      "owner",
      owner
        ? `${PASS} ${dim(owner)}`
        : `${yellow("not recorded")} ${dim("— re-run `drk-deploy init`; until then .vercel/project.json decides")}`,
    );
    // `doctor` is the command you run when something is already wrong, so a
    // config it cannot parse must be REPORTED as a problem, not thrown as one:
    // throwing here abandons the toolchain, credential and kit-checkout
    // results the operator came for, and exits 1 for the whole run without
    // saying what else is fine. Every other check in this file counts.
    const profile = readProfile(config, bad);
    field("target", profile ? describeProfile(profile) : red("unreadable"));
    field("origin", config.origin);
    // The refusals `deploy`, `up` and `migrate` stop on before running
    // anything, reported here first (F-48). Without this, `doctor` says
    // "Ready to deploy." to a shell that names another Vercel project, and
    // every one of them then exits 2.
    try {
      const { ignored } = vercelEnvFor(config, resolveToken() ?? "");
      field(
        "shell project ids",
        ignored.length === 0
          ? `${PASS} ${dim("none name another project")}`
          : `${yellow("ignored")} ${dim(`${ignored.join(", ")} — not passed to vercel: no owner recorded to check it against`)}`,
      );
    } catch (err) {
      field("shell project ids", bad(`${red("wrong")} — ${(err as Error).message}`));
      if (err instanceof CliError && err.hint) info(`    ${dim(err.hint)}`);
    }
    if (profile) {
      // The refusal `deploy` would stop on, reported here first (F-48).
      const root = deployRoot(config);
      try {
        assertCheckoutLink(root, config, { required: false });
        field(
          "checkout link",
          existsSync(projectLinkFile(root))
            ? `${PASS} ${dim(projectLinkFile(root))}`
            : dim("not linked yet (linked on the first deploy)"),
        );
      } catch (err) {
        field("checkout link", bad(`${red("wrong")} — ${(err as Error).message}`));
        if (err instanceof CliError && err.hint) info(`    ${dim(err.hint)}`);
      }
    }

    if (profile?.kind === "satellite") {
      const appRoot = deployRoot(config);
      const appOk = existsSync(join(appRoot, "package.json"));
      field("app checkout", appOk ? `${PASS} ${dim(appRoot)}` : bad(`${red("not found")} ${appRoot}`));
      field("sso issuer", profile.issuerOrigin);
      field(
        "migrations",
        migrationPolicy(profile).allowed
          ? `${yellow("allowed")} ${dim("(this satellite owns its database)")}`
          : `${PASS} ${dim("refused — the kit owns this schema")}`,
      );
      // A satellite that is misconfigured in these ways deploys, serves, and
      // then fails on the first handoff. Say so here, where it costs nothing.
      for (const problem of satelliteConfigProblems({
        profile,
        origin: config.origin,
        applicationId: config.applicationId,
        audiencePrefix: config.audiencePrefix,
      })) {
        field(problem.what, bad(`${red("wrong")} — ${problem.why}`), 26);
      }
    }

    const kitOk = existsSync(join(config.kitRoot, "package.json"));
    field(
      "kit checkout",
      kitOk ? `${PASS} ${dim(config.kitRoot)}` : bad(`${red("not found")} ${config.kitRoot}`),
    );
    if (kitOk) {
      const migrations = coreMigrations(config.kitRoot);
      field("core migrations", `${migrations.length} ${dim(migrations.at(-1) ?? "")}`);
      const deps = existsSync(join(config.kitRoot, "node_modules", "tsx"));
      field("kit deps", deps ? PASS : `${yellow("not installed")} ${dim("(installed on demand)")}`);
    }

    // Printed, never passed to `bad`: an uncontained satellite is a topology
    // the operator chose, not a broken one, and `doctor` exiting 1 for it
    // would train people to ignore this command (F-24).
    if (profile) reportContainment(profile, config.origin);
  }

  info("");
  if (problems === 0) ok("Ready to deploy.");
  else warn(`${problems} problem(s) to fix first.`);
  return problems;
}
