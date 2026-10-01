import { randomBytes } from "node:crypto";
import { type ProjectConfig, commandFor, requireConfig, requireToken } from "../lib/config.js";
import { type GateTarget, ownerMatchesGateTarget, parseGateTargetLine } from "../lib/gate-target.js";
import { describe, isHealthy, probe } from "../lib/health.js";
import {
  RUNTIME_LOGIN_SCRIPT,
  ensureKitDependencies,
  hasRuntimeLoginScript,
  runKitRuntimeLogin,
} from "../lib/kit.js";
import { CliError, dim, field, heading, info, ok, step, warn } from "../lib/log.js";
import { runtimeLoginEnv } from "../lib/migration-env.js";
import { DEFAULT_SCHEMA, databaseIdentity, parsePostgresUrl, redactUrl } from "../lib/migration-target.js";
import { type TreeState, describeCommit, inspectTree, shortSha, treeProblems } from "../lib/release-tree.js";
import { RUNTIME_ENDPOINTS, type RuntimeEndpoint, runtimeHost, runtimeUrl } from "../lib/runtime-url.js";
import { describeProfile, resolveProfile } from "../lib/target.js";
import type { EnvVarSummary, ProjectSummary, ServingDeployment } from "../lib/vercel-client.js";
import { ask } from "./init.js";
import {
  type MigrationUrl,
  type Verdict,
  type VercelInvocation,
  describeDeployment,
  releaseRunner,
  resolveMigrationUrl,
  rollbackCommand,
  runVercel,
  vercelInvocation,
} from "./release.js";

/**
 * `drk-deploy db:runtime-login` (DEP4): the operator's one command for
 * moving production onto a least-privilege database login, rotating it, and
 * retiring the old ones (docs/deployment.md §8).
 *
 *   1. config, token, the kit profile (a satellite is refused), the flags and
 *      the owner's DIRECT URL (PRODUCTION_DIRECT_DATABASE_URL only), all
 *      before anything is read;
 *   2. the kit checkout is a clean, pushed commit at origin's default branch,
 *      because the kit command reconciles the runtime role to the manifest in
 *      it;
 *   3. the project, read;
 *   4. the target: the serving deployment's build log names the database its
 *      schema gate connected to (`[deploy-gate] target …`, DEP1), which the
 *      owner URL must reach, in the same schema;
 *   5. a login `<schema>_app_<UTC yyyymmddhhmm>` and a password, both in
 *      memory only;
 *   6. the runtime URL (the pooled host unless --endpoint direct);
 *   7. `pnpm db:runtime-login` in the kit checkout creates the login with a
 *      client-side SCRAM verifier and verifies it THROUGH the runtime host;
 *   8. DATABASE_URL and DB_SEARCH_PATH_VIA_OPTIONS written to Production,
 *      `sensitive`, never printed;
 *   9. with --redeploy, the serving deployment redeployed, probed, and its
 *      gate line read back: it must name the new login, `runtime=non-owner`;
 *  10. what to do next: retire the old logins.
 *
 * A refusal exits 2 with nothing created or written. The kit command failing
 * exits 1 with nothing written to Vercel. A failure after a write exits 3
 * with the way back. The retire modes (--retire-except, --retire-all) run
 * steps 1 to 4, which say which login production connects as, then the kit's
 * own retire mode.
 *
 * Every step that reaches Vercel, the kit or the network goes through
 * {@link RuntimeLoginRunner}, so test/runtime-login.test.ts asserts the
 * order and that the password never reaches output or argv.
 */

/** The variables the command writes to Vercel, in the order it writes them. */
const ENV_KEYS = ["DATABASE_URL", "DB_SEARCH_PATH_VIA_OPTIONS"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** A schema name, as the kit's schema-config takes it. */
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i;

/** Postgres truncates identifiers past 63 bytes, so a longer name is not the role it names. */
const MAX_IDENTIFIER_BYTES = 63;

/** The highest `--connection-limit`, as the kit command takes it; -1 means none. */
const MAX_CONNECTION_LIMIT = 100_000;

export interface RuntimeLoginOptions {
  endpoint?: string;
  pooledHost?: string;
  connectionLimit?: string;
  redeploy?: boolean;
  plaintextPassword?: boolean;
  retireExcept?: string;
  retireAll?: boolean;
  force?: boolean;
  schema?: string;
  allowUnverifiedTarget?: boolean;
  fromEnv?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Every step that reaches Vercel, the kit checkout, a subprocess or the
 * network. {@link runtimeLoginRunner} is the real one.
 */
export interface RuntimeLoginRunner {
  /** The kit checkout's git state (`inspectTree`), read-only. */
  tree(root: string): Promise<TreeState>;
  /** The project, read once. */
  project(vercel: VercelInvocation): Promise<ProjectSummary>;
  /** The deployment the production origin serves, or null. */
  serving(vercel: VercelInvocation): Promise<ServingDeployment | null>;
  /** A deployment's build log, line by line (`getDeploymentEvents`). */
  events(vercel: VercelInvocation, deployment: ServingDeployment): Promise<string[]>;
  /** The project's env entries: names, targets, ids and types (`listEnv`). */
  listEnv(vercel: VercelInvocation): Promise<EnvVarSummary[]>;
  /** `pnpm install --frozen-lockfile` in the kit checkout when it lacks tsx. */
  ensureKit(kitRoot: string, dryRun: boolean): Promise<void>;
  /** `pnpm db:runtime-login <args>` in the kit checkout, with `env`: its exit code. */
  kit(kitRoot: string, args: string[], env: Record<string, string | undefined>): Promise<number>;
  /** Replaces one entry's value by id, keeping its targets. */
  editEnv(
    vercel: VercelInvocation,
    entry: { id: string; key: string },
    change: { value: string; type: "sensitive" },
  ): Promise<void>;
  /** Creates one entry, never overwriting one (no upsert). */
  createEnv(
    vercel: VercelInvocation,
    variable: { key: string; value: string; type: "sensitive"; target: ["production"] },
  ): Promise<void>;
  /** `vercel redeploy <deployment> --target=production`, waiting for it. A non-zero exit throws. */
  redeploy(vercel: VercelInvocation, from: ServingDeployment): Promise<void>;
  /** `/api/health`, `/api/health/ready` and the bad-credentials sign-in, as a verdict. */
  verify(config: ProjectConfig): Promise<Verdict>;
  /** One typed answer at the terminal. */
  confirm(question: string): Promise<string>;
}

async function client(config: ProjectConfig) {
  const { VercelClient } = await import("../lib/vercel-client.js");
  return new VercelClient(requireToken(), config.teamId);
}

/** The real steps. The command uses these unless a test passes its own. */
export const runtimeLoginRunner: RuntimeLoginRunner = {
  tree: (root) => inspectTree(root),
  project: releaseRunner.project,
  serving: releaseRunner.serving,
  events: async ({ config }, deployment) => (await client(config)).deploymentEvents(deployment.id),
  listEnv: async ({ config }) => (await client(config)).listEnv(config.projectId),
  ensureKit: ensureKitDependencies,
  kit: runKitRuntimeLogin,
  editEnv: async ({ config }, entry, change) =>
    (await client(config)).editEnv(config.projectId, entry, change),
  createEnv: async ({ config }, variable) =>
    (await client(config)).createEnv(config.projectId, variable, { upsert: false }),
  // The token goes to this child only, in its environment (`vercelEnvFor`).
  redeploy: (vercel, from) =>
    runVercel(vercel, redeployArgs(vercel, from), "vercel redeploy failed: its build was not promoted"),
  verify: verifyHealth,
  confirm: (question) => ask(question),
};

/**
 * `vercel redeploy <id> --target=production`: a new production build of the
 * deployment's own source, with the project's CURRENT environment, which is
 * the only way the new variables reach a deployment. It waits until Vercel
 * has built and aliased it, and exits non-zero when the build fails, the
 * schema gate included. Scoped to the owner, as `promote` is (`rollbackArgs`).
 */
function redeployArgs(vercel: Pick<VercelInvocation, "orgId">, from: ServingDeployment): string[] {
  return ["redeploy", from.id, "--target=production", ...(vercel.orgId ? [`--scope=${vercel.orgId}`] : [])];
}

/** The probe, as a verdict: `/api/health`, `/api/health/ready` and a refused sign-in. */
async function verifyHealth(config: ProjectConfig): Promise<Verdict> {
  heading("Verify");
  step(`Probing ${config.origin}`);
  const report = await probe(config.origin);
  for (const line of describe(report)) info(`  ${line}`);
  return isHealthy(report)
    ? { healthy: true, problems: [] }
    : { healthy: false, problems: ["its health probes fail (see above)"] };
}

/** A refusal: exit 2, and nothing was created or written. */
function refusal(message: string, hint?: string): CliError {
  return new CliError(message, { exitCode: 2, ...(hint ? { hint } : {}) });
}

/** A failure after something was written to Vercel: exit 3, with the way back. */
function afterWrite(message: string, hint: string): CliError {
  return new CliError(message, { exitCode: 3, hint });
}

/** The login the kit would accept for `schema`: `<schema>_app`, or `<schema>_app_` and 1 to 24 of a-z0-9 (the kit's `isKitLoginName`). */
export function isKitLogin(schema: string, name: string): boolean {
  const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`^${escaped}_app(?:_[a-z0-9]{1,24})?$`).test(name) &&
    Buffer.byteLength(name, "utf8") <= MAX_IDENTIFIER_BYTES
  );
}

/**
 * The login this run creates: `<schema>_app_` and the UTC minute,
 * `yyyymmddhhmm`, the kit's rotated form (`isRotatedLoginName`). A new name
 * every run is what makes a rotation safe: the deployment still serving keeps
 * its own login until the new one is live, and the old one is retired after.
 */
export function rotatedLoginName(schema: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}`;
  return `${schema}_app_${stamp}`;
}

/** What the flags settle, checked before anything is read. */
interface Plan {
  schema: string;
  endpoint: RuntimeEndpoint;
  pooledHost: string | undefined;
  connectionLimit: number | null;
  retire: { except: string | null } | null;
}

/** The flags, refused (exit 2) when they do not make one run. */
function readOptions(options: RuntimeLoginOptions): Plan {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) {
    throw refusal(`--schema ${JSON.stringify(schema)} is not a schema name (letters, digits and _).`);
  }
  if (options.retireExcept !== undefined && options.retireAll) {
    throw refusal("--retire-except and --retire-all exclude each other.");
  }
  const retire =
    options.retireExcept !== undefined
      ? { except: options.retireExcept }
      : options.retireAll
        ? { except: null }
        : null;
  if (retire) {
    if (retire.except !== null && !isKitLogin(schema, retire.except)) {
      throw refusal(
        `--retire-except ${retire.except} is not a kit login name: ${schema}_app, or ${schema}_app_ and 1 to 24 lower-case letters or digits.`,
        "While production connects as the owner, retire every rotated login with --retire-all instead.",
      );
    }
    const creating = [
      ["--endpoint", options.endpoint],
      ["--pooled-host", options.pooledHost],
      ["--connection-limit", options.connectionLimit],
      ["--redeploy", options.redeploy],
      ["--plaintext-password", options.plaintextPassword],
    ].filter(([, given]) => given !== undefined && given !== false);
    if (creating.length > 0) {
      throw refusal(`${creating.map(([flag]) => flag).join(", ")} cannot be combined with a retire mode.`);
    }
  } else if (options.force) {
    throw refusal("--force applies only to --retire-except and --retire-all.");
  }
  const endpoint = (options.endpoint ?? "pooled") as RuntimeEndpoint;
  if (!RUNTIME_ENDPOINTS.includes(endpoint)) {
    throw refusal(`--endpoint ${options.endpoint} is neither pooled nor direct.`);
  }
  let connectionLimit: number | null = null;
  if (options.connectionLimit !== undefined) {
    const n = /^-?\d+$/.test(options.connectionLimit) ? Number(options.connectionLimit) : NaN;
    if (!(n === -1 || (n >= 1 && n <= MAX_CONNECTION_LIMIT))) {
      throw refusal(`--connection-limit must be -1 (no limit) or 1 to ${MAX_CONNECTION_LIMIT}.`);
    }
    connectionLimit = n;
  }
  return { schema, endpoint, pooledHost: options.pooledHost, connectionLimit, retire };
}

/**
 * The owner's DIRECT URL: PRODUCTION_DIRECT_DATABASE_URL in the shell or the
 * --from-env file, never DATABASE_URL, and never a pooled or re-pointed one
 * (`resolveMigrationUrl`, F-47 and DEP2). Its refusals become exit 2.
 */
function ownerUrl(options: RuntimeLoginOptions): MigrationUrl {
  try {
    return resolveMigrationUrl({ ...(options.fromEnv !== undefined ? { fromEnv: options.fromEnv } : {}) });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // Its hint names `--database-url`, which this command does not take.
    if (err.message.startsWith("No database URL")) {
      throw refusal(
        "No owner URL: set PRODUCTION_DIRECT_DATABASE_URL to production's DIRECT owner connection string.",
        "Export it in the shell, or name a .env file holding it with --from-env. DATABASE_URL is never read: on this machine it is usually a local database.",
      );
    }
    throw refusal(err.message, err.hint);
  }
}

/**
 * The kit checkout must be a clean, pushed commit at origin's default branch
 * (`treeProblems`, F-49): the kit command reconciles the runtime role to the
 * privilege manifest it finds there, so it must be the reviewed one. A dry
 * run reports what a real run would refuse, and goes on.
 */
async function checkKitTree(runner: RuntimeLoginRunner, kitRoot: string, dryRun: boolean): Promise<void> {
  const tree = await runner.tree(kitRoot);
  heading("Release commit (kit checkout)");
  field("checkout", kitRoot);
  if (tree.notRepository === null) {
    field("commit", describeCommit(tree));
    field(
      "release ref",
      `${tree.release.ref} at ${shortSha(tree.release.commit)} ${dim("(as last fetched: nothing is fetched)")}`,
    );
  }
  const problems = treeProblems(tree, { label: "kit checkout", rule: "default-branch" });
  if (problems.length === 0) return;
  const message = `Refusing: ${problems.map((problem) => problem.what).join("; ")}. Nothing was changed.`;
  if (!dryRun) {
    throw refusal(
      message,
      "The kit command reconciles the runtime role to the privilege manifest in this checkout (src/db/runtime-privileges.ts), so it must be the reviewed one: a clean tree (untracked files count), pushed, at what origin's default branch holds. Commit and push, or check that out (`git pull --ff-only`).",
    );
  }
  for (const problem of problems) warn(`[dry-run] a real run would refuse: ${problem.what}.`);
}

/** Which deployment production serves, and what its gate line says about the database and the login. */
interface LiveTarget {
  serving: ServingDeployment;
  gate: GateTarget | null;
  /** The login production connects as, from the gate line; null when there is none. */
  liveUser: string | null;
}

/**
 * Step 4: the owner URL must reach the database production uses, in the
 * schema it uses. The reference is the serving deployment's own build log:
 * the LAST `[deploy-gate] target` line (DEP1's contract,
 * `parseGateTargetLine`), compared by `databaseIdentity`, which ignores
 * Neon's `-pooler`. A mismatch has no override. A log with no line (a
 * deployment built before the gate, or one `drk-deploy deploy` built locally
 * and promoted prebuilt, where the gate skips) is refused unless
 * --allow-unverified-target, and then the operator types the database name
 * unless --yes.
 */
async function targetIdentity(
  runner: RuntimeLoginRunner,
  vercel: VercelInvocation,
  owner: MigrationUrl,
  plan: Plan,
  options: RuntimeLoginOptions,
): Promise<LiveTarget> {
  heading("Production's database");
  const serving = await runner.serving(vercel);
  if (!serving) {
    throw refusal(
      `Refusing: ${vercel.config.origin} serves no deployment, so which database production uses cannot be read.`,
      `Deploy production first (\`${commandFor("deploy")}\`, or a push), then rerun.`,
    );
  }
  field("serving now", describeDeployment(serving));
  const gate = parseGateTargetLine(await runner.events(vercel, serving));
  const url = parsePostgresUrl(owner.url)!;
  if (gate) {
    field(
      "its schema gate",
      `host=${gate.host} port=${gate.port} database=${gate.database} schema=${gate.schema} user=${gate.user} runtime=${gate.runtime}`,
    );
    if (!ownerMatchesGateTarget(url, gate)) {
      throw refusal(
        "Refusing: the owner URL is not the database production uses. Nothing was changed.",
        [
          `owner: ${redactUrl(owner.url)} (${owner.source})`,
          `production: host=${gate.host} port=${gate.port} database=${gate.database}, from the [deploy-gate] target line in ${describeDeployment(serving)}'s build log`,
          "The host (with Neon's `-pooler` removed), the port (5432 when none is given) and the database name must match. Point PRODUCTION_DIRECT_DATABASE_URL at production's DIRECT owner endpoint. There is no override for a mismatch.",
        ].join("\n  "),
      );
    }
    if (gate.schema !== plan.schema) {
      throw refusal(
        `Refusing: production's schema gate checked schema \`${gate.schema}\`, and this run would use \`${plan.schema}\`. Nothing was changed.`,
        `Pass --schema ${gate.schema}: a login for another schema holds nothing production reads.`,
      );
    }
    ok("The owner URL reaches the database production uses, in the same schema");
    return { serving, gate, liveUser: gate.user };
  }

  const database = databaseIdentity(url).database;
  if (!options.allowUnverifiedTarget) {
    throw refusal(
      `Refusing: the build log of ${describeDeployment(serving)} has no \`[deploy-gate] target\` line, so which database production uses cannot be read. Nothing was changed.`,
      "Only a build that runs the schema gate on Vercel prints one. A deployment built before the gate (DEP1) prints none, and neither does one `drk-deploy deploy` or `up` built on this machine and promoted prebuilt: the gate skips there, and that build log never reaches Vercel. A production build by Vercel's git integration prints one: push to the production branch, and rerun once that build serves production. Or, once you have checked the owner URL above yourself, rerun with --allow-unverified-target.",
    );
  }
  warn("--allow-unverified-target: the owner URL was NOT checked against the database production uses.");
  field("host", url.hostname);
  field("database", database);
  if (!options.yes) {
    if (options.dryRun) {
      step("[dry-run] a real run asks you to type the database name here (or takes --yes)");
    } else if (
      (await runner.confirm(`Type the database name (${database}) to confirm it is production's`)).trim() !==
      database
    ) {
      throw refusal("Refusing: the name typed is not the owner URL's database. Nothing was changed.");
    }
  }
  return { serving, gate: null, liveUser: null };
}

/**
 * Step 11: the retire modes. `--retire-except <login>` keeps the login
 * production connects as, so it is refused for any other unless --force.
 * `--retire-all` is the break-glass back to the owner, refused while
 * production still connects as a kit login, unless --force. Then the kit's
 * own retire mode runs, with the owner's environment and no password.
 */
async function retire(
  runner: RuntimeLoginRunner,
  config: ProjectConfig,
  owner: MigrationUrl,
  plan: Plan & { retire: { except: string | null } },
  live: LiveTarget,
  options: RuntimeLoginOptions,
): Promise<void> {
  const { except } = plan.retire;
  heading("Retire");
  const production = live.liveUser
    ? `production connects as ${live.liveUser}`
    : "which login production connects as is unknown (its build log has no gate line)";
  if (except !== null) {
    field("keep", except);
    if (except !== live.liveUser) {
      if (!options.force) {
        throw refusal(
          `Refusing to retire every login but ${except}: ${production}. Nothing was changed.`,
          live.liveUser !== null && !isKitLogin(plan.schema, live.liveUser)
            ? `Production connects as ${live.liveUser}, not a kit login, so no rotated login is in use: retire them all with \`${commandFor("db:runtime-login --retire-all")}\` instead.`
            : "Retiring the login production uses cuts it off. Name the one the serving deployment's gate line names, or pass --force.",
        );
      }
      warn(`--force: keeping ${except} although ${production}.`);
    }
  } else if (live.liveUser !== null && isKitLogin(plan.schema, live.liveUser)) {
    if (!options.force) {
      throw refusal(
        `Refusing to retire every rotated login: ${production}, a kit login. Nothing was changed.`,
        "Retiring the login production connects as cuts it off. To go back to the owner (docs/deployment.md §8.5): if a deployment that connects as the owner is recent enough to roll back to (one built before the first switch; after a rotation the recent ones all connect as a login), roll back to it and rerun. Otherwise set Vercel's DATABASE_URL to the owner's URL, rerun with --force, which cuts production off until the next step is live, and redeploy at once. A build that connects as the owner fails the schema gate while any rotated login exists, so the retire has to come before that redeploy.",
      );
    }
    warn(`--force: retiring every rotated login although ${production}.`);
  }
  const args = [
    ...(except !== null ? ["--retire-except", except] : ["--retire-all"]),
    "--allow-remote",
    ...(options.force ? ["--force"] : []),
  ];
  field("kit command", `pnpm ${RUNTIME_LOGIN_SCRIPT} ${args.join(" ")}`);
  await runner.ensureKit(config.kitRoot, Boolean(options.dryRun));
  if (options.dryRun) {
    step("[dry-run] would run the kit command above. Nothing was retired.");
    return;
  }
  const code = await runner.kit(config.kitRoot, args, runtimeLoginEnv(owner.url, plan.schema, undefined));
  if (code !== 0) {
    throw new CliError(`pnpm ${RUNTIME_LOGIN_SCRIPT} exited ${code}: see its lines above.`, {
      hint: "A login kept for its open sessions goes on a later run: rerun once the pooler has closed its idle connections, or pass --force.",
    });
  }
  ok("Retired");
}

/**
 * What to do about `login` when this run created it and production does not
 * use it (a kit failure after the create, or a failed first write). It is a
 * LOGIN member of `<schema>_runtime`, so while production connects as the
 * owner the schema gate's ratchet fails every production build that still
 * connects as the owner, until a rerun switches production or `--retire-all`
 * drops it (`--retire-except` takes a kit login, never the owner). While
 * production connects as another login, it harms nothing.
 */
function strayLoginRemedy(schema: string, login: string, live: Pick<LiveTarget, "gate">): string {
  const { gate } = live;
  // Without a gate line, a retire run needs --allow-unverified-target again.
  const unverified = gate ? "" : " --allow-unverified-target";
  const retireAll = `\`${commandFor(`db:runtime-login --retire-all${unverified}`)}\``;
  const ratchet = `every production build that connects as the owner fails the schema gate's ratchet ("a least-privilege login … exists"), a push to the production branch included, until a rerun succeeds or ${retireAll} retires ${login}`;
  if (!gate) {
    return `Which login production connects as is unknown (its build log has no gate line). If it is the owner, ${ratchet}. If it is a kit login, \`${commandFor(`db:runtime-login --retire-except <that login> --force${unverified}`)}\` retires ${login}.`;
  }
  if (gate.runtime === "owner") return `While ${login} exists, ${ratchet}.`;
  const retireIt = isKitLogin(schema, gate.user)
    ? `\`${commandFor(`db:runtime-login --retire-except ${gate.user}`)}\``
    : retireAll;
  return `${login} does not affect production, which connects as ${gate.user}: ${retireIt} retires it.`;
}

/** One write step 8 makes: an existing entry edited by id, keeping its targets, or a new one for Production. */
export interface EnvWrite {
  key: EnvKey;
  /** The entry edited, or null when one is created. */
  id: string | null;
  target: string[];
}

/**
 * Step 8's plan, from the listing (names, targets, ids and types, never
 * values), made BEFORE the login is created so that a listing this run
 * cannot write through stops it with nothing created. For each key, the one
 * entry that covers Production is edited by id, keeping its targets; with
 * none, one is created for Production. Refused: two entries covering
 * Production (which one the app reads is not this run's to guess), and an
 * entry that also covers Development, which Vercel stores no `sensitive`
 * value for (F-138).
 */
export function planEnvWrites(listing: readonly EnvVarSummary[]): EnvWrite[] {
  return ENV_KEYS.map((key) => {
    const covering = listing.filter((entry) => entry.key === key && entry.target.includes("production"));
    if (covering.length > 1) {
      throw refusal(
        `Refusing: ${covering.length} ${key} entries cover Production. Nothing was changed.`,
        `Keep one (Vercel → Project → Settings → Environment Variables), then rerun.`,
      );
    }
    const entry = covering[0];
    if (!entry) return { key, id: null, target: ["production"] };
    if (!entry.id)
      throw refusal(
        `Refusing: Vercel listed ${key} without an id, so it cannot be edited. Nothing was changed.`,
      );
    if (entry.target.includes("development")) {
      throw refusal(
        `Refusing: the ${key} entry that covers Production also covers Development, which takes no sensitive value. Nothing was changed.`,
        `Split it: give Development its own entry (local work uses its own .env anyway), then rerun.`,
      );
    }
    return { key, id: entry.id, target: entry.target };
  });
}

/**
 * `drk-deploy db:runtime-login`. `now` names the login; a test passes its own.
 */
export async function runtimeLogin(
  cliRoot: string,
  options: RuntimeLoginOptions,
  runner: RuntimeLoginRunner = runtimeLoginRunner,
  now: () => Date = () => new Date(),
): Promise<void> {
  const config = requireConfig(cliRoot);
  const profile = resolveProfile(config);
  if (profile.kind === "satellite") {
    throw refusal(
      "Refusing: db:runtime-login is for the kit's own production. A satellite has no kit command, and its database login is a follow-up (docs/integration-satellite-apps.md).",
    );
  }
  const plan = readOptions(options);
  const owner = ownerUrl(options);
  if (!hasRuntimeLoginScript(config.kitRoot)) {
    throw refusal(
      `The kit checkout at ${config.kitRoot} has no \`pnpm ${RUNTIME_LOGIN_SCRIPT}\` script: it predates the least-privilege login (DEP3).`,
      "Update the kit checkout to origin's default branch, then rerun.",
    );
  }
  const vercel = vercelInvocation(cliRoot, config, profile);
  const dryRun = Boolean(options.dryRun);

  heading(plan.retire ? "Retire least-privilege logins" : "Least-privilege database login");
  field("target", describeProfile(profile));
  field("owner (direct)", `${redactUrl(owner.url)} ${dim(`(${owner.source})`)}`);
  field("schema", plan.schema);

  await checkKitTree(runner, config.kitRoot, dryRun);
  heading("Vercel project");
  const project = await runner.project(vercel);
  field("project", `${project.name} ${dim(project.id)}`);
  const live = await targetIdentity(runner, vercel, owner, plan, options);
  if (plan.retire) {
    await retire(runner, config, owner, { ...plan, retire: plan.retire }, live, options);
    return;
  }

  // 5. The login, and (below, past the dry run) the password: in memory only.
  const login = rotatedLoginName(plan.schema, now());
  if (Buffer.byteLength(login, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw refusal(
      `Refusing: the login name ${login} is longer than Postgres' 63 bytes. Nothing was changed.`,
    );
  }
  if (login === live.liveUser) {
    throw refusal(
      `Refusing: production already connects as ${login}, the name this run would mint. Nothing was changed.`,
      "Logins are named by the minute: wait for the next one and rerun.",
    );
  }
  // 6. Where the runtime connects. The host is checked here, before anything
  // is created; the URL itself is built once the password exists.
  const host = runtimeHost(owner.url, plan);
  const kitArgs = [
    "--login",
    login,
    "--allow-remote",
    "--verify-host",
    host,
    ...(plan.connectionLimit !== null ? ["--connection-limit", String(plan.connectionLimit)] : []),
    ...(options.plaintextPassword ? ["--plaintext-password"] : []),
  ];
  heading("The new login");
  field("login", login);
  field("runtime endpoint", `${plan.endpoint}: ${host}`);
  field("kit command", `pnpm ${RUNTIME_LOGIN_SCRIPT} ${kitArgs.join(" ")}`);

  // 8, planned: refused here, with nothing created, when it cannot be written.
  const writes = planEnvWrites(await runner.listEnv(vercel));
  heading("Vercel environment");
  for (const write of writes) {
    field(
      write.key,
      `${write.id ? `edit ${write.id}, targets kept (${write.target.join(", ")})` : "create for production"}, sensitive`,
    );
  }

  if (dryRun) {
    await runner.ensureKit(config.kitRoot, true);
    heading("Plan");
    step(
      `[dry-run] would: generate the password in memory → run the kit command above (create ${login}, verify it through ${host}) → write the variables above → ${
        options.redeploy
          ? `redeploy ${describeDeployment(live.serving)} to production → probe it → check its gate line names ${login}, runtime=non-owner`
          : "print the redeploy step"
      }`,
    );
    step("[dry-run] nothing was created or written");
    return;
  }

  const password = randomBytes(32).toString("base64url");
  const values: Record<EnvKey, string> = {
    DATABASE_URL: runtimeUrl(owner.url, { ...plan, login, password }),
    DB_SEARCH_PATH_VIA_OPTIONS: plan.endpoint === "pooled" ? "0" : "1",
  };

  // 7. The kit creates and verifies; a non-zero exit writes nothing.
  await runner.ensureKit(config.kitRoot, false);
  heading(`Create and verify (pnpm ${RUNTIME_LOGIN_SCRIPT})`);
  const code = await runner.kit(config.kitRoot, kitArgs, runtimeLoginEnv(owner.url, plan.schema, password));
  if (code !== 0) {
    throw new CliError(
      `pnpm ${RUNTIME_LOGIN_SCRIPT} exited ${code}: nothing was written to Vercel, and production is unchanged.`,
      {
        hint: `Its last line above says why and what to do: --plaintext-password if the server refuses the SCRAM verifier, a grant of ADMIN OPTION, or as the owner \`revoke create on database <db> from public\` (an operator decision) when PUBLIC holds CREATE. Then rerun: each run mints a new login. If that line says ${login} exists but failed verification, it is left behind, unused. ${strayLoginRemedy(plan.schema, login, live)}`,
      },
    );
  }

  // 8. The writes. Production does not change yet: a deployment keeps the
  // environment it was built with.
  heading("Write the Vercel environment");
  for (const write of writes) {
    try {
      if (write.id) {
        await runner.editEnv(
          vercel,
          { id: write.id, key: write.key },
          { value: values[write.key], type: "sensitive" },
        );
      } else {
        await runner.createEnv(vercel, {
          key: write.key,
          value: values[write.key],
          type: "sensitive",
          target: ["production"],
        });
      }
    } catch (err) {
      // DATABASE_URL is written first: until it is, the project still names
      // the login production uses, and the new one is a stray.
      const stray =
        write.key === "DATABASE_URL"
          ? `${login} exists, unused. ${strayLoginRemedy(plan.schema, login, live)}`
          : `${login} exists, and DATABASE_URL already names it, so do not retire it: the --retire-except a successful rerun prints retires it.`;
      throw afterWrite(
        `Writing ${write.key} failed: ${(err as Error).message}`,
        `Production is unchanged: every deployment keeps the environment it was built with. The next production build would read what was written so far, so rerun this command (it mints a new login and writes both variables again). ${stray}`,
      );
    }
    ok(`${write.key} ${write.target.join(",")} sensitive written`);
  }

  // 9. The redeploy, and the proof that it connects as the login.
  if (!options.redeploy) {
    heading("Next");
    info(
      `  The new values take effect only on a new deployment. Redeploy production: \`vercel ${redeployArgs(vercel, live.serving).join(" ")}\` (or push to the production branch).`,
    );
    info(
      `  Its build log must show \`[deploy-gate] target … user=${login} runtime=non-owner\`, and ${vercel.config.origin}/api/health/ready answer 200.`,
    );
    nextRetire(login);
    return;
  }

  heading("Redeploy");
  step(`Redeploying ${describeDeployment(live.serving)} to production with the new environment`);
  const stillServing = `Production still serves ${describeDeployment(live.serving)}, which was built with the old DATABASE_URL.`;
  const breakGlass = "To go back to the owner instead, follow the break-glass in docs/deployment.md §8.5.";
  try {
    await runner.redeploy(vercel, live.serving);
  } catch (err) {
    throw afterWrite(
      `The redeploy failed: ${(err as Error).message}`,
      `${stillServing} New production builds read ${login} from now on, so if this one failed at its schema gate they will too until the cause is fixed: read its [deploy-gate] lines (docs/troubleshooting.md), fix, and rerun this command. ${breakGlass}`,
    );
  }
  const rollBack = `Roll back with \`${rollbackCommand(vercel, live.serving)}\` (Instant Rollback to the deployment built with the old DATABASE_URL), then investigate. The project's DATABASE_URL still names ${login} for the next build: if the login is at fault, follow the break-glass in docs/deployment.md §8.5.`;
  let current: ServingDeployment;
  let verdict: Verdict;
  let gate: GateTarget | null;
  try {
    const serving = await runner.serving(vercel);
    if (!serving || serving.id === live.serving.id) {
      throw afterWrite(
        `The redeploy finished, but ${vercel.config.origin} still serves ${describeDeployment(live.serving)}.`,
        `Vercel did not assign the production domain to the new build (after an Instant Rollback it stays off until a deployment is promoted). Find the redeploy in the project's Deployments page, check that its build log shows \`[deploy-gate] target … user=${login} runtime=non-owner\`, and promote it. ${stillServing}`,
      );
    }
    current = serving;
    field("serving now", describeDeployment(current));
    verdict = await runner.verify(config);
    gate = parseGateTargetLine(await runner.events(vercel, current));
  } catch (err) {
    if (err instanceof CliError && err.exitCode === 3) throw err;
    throw afterWrite(`Could not check the redeployed production: ${(err as Error).message}`, rollBack);
  }
  if (!verdict.healthy) {
    throw afterWrite(
      `${describeDeployment(current)} serves production but is not healthy: ${verdict.problems.join("; ")}.`,
      rollBack,
    );
  }
  if (!gate || gate.runtime !== "non-owner" || gate.user !== login) {
    const found = gate ? `user=${gate.user} runtime=${gate.runtime}` : "no [deploy-gate] target line";
    throw afterWrite(
      `${describeDeployment(current)} serves production, but its schema gate shows ${found}, not user=${login} runtime=non-owner.`,
      rollBack,
    );
  }
  ok(`Production connects as ${login} (runtime=non-owner), and is healthy`);
  heading("Next");
  nextRetire(login);
}

/** Step 10: the old logins go once the new deployment has proved itself. */
function nextRetire(login: string): void {
  info(
    `  After the new deployment is live and healthy: \`${commandFor(`db:runtime-login --retire-except ${login}`)}\``,
  );
}
