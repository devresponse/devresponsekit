import { existsSync, readFileSync } from "node:fs";
import { deploymentContext, requireConfig, requireToken } from "../lib/config.js";
import {
  ALL_TARGETS,
  type DeploymentContext,
  type EnvTarget,
  type EnvVarSpec,
  FORBIDDEN_ON_VERCEL,
  derivedValuesFor,
  envSpecsFor,
  mayGenerateAuthSecret,
  refusedFor,
  vercelTypeFor,
} from "../lib/env-spec.js";
import {
  CONTAINMENT_DOC,
  type DeploymentProfile,
  containmentWarnings,
  describeProfile,
  migrationPolicy,
  satelliteConfigProblems,
} from "../lib/target.js";
import {
  CliError,
  blue,
  bold,
  dim,
  field,
  green,
  heading,
  info,
  mask,
  ok,
  red,
  step,
  warn,
  yellow,
} from "../lib/log.js";
import { generateAuthSecret, generateHandoffKeypair, generateOperatorSecret } from "../lib/secrets.js";
import { VercelClient } from "../lib/vercel-client.js";

/** Minimal .env reader: `KEY=value`, optional quotes, `#` comments, no interpolation. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Collects values the operator has supplied, from the shell and from a file.
 *
 * `alsoCollect` is how the must-not-be-set keys get seen at all. They are, by
 * definition, absent from the spec list, so a shell-exported
 * `SSO_HANDOFF_PRIVATE_KEY` was invisible to the refusal check while the
 * refusal's own hint told the operator to "drop them from any --from-env file
 * or shell environment" — a promise the code could not keep. Collected here,
 * never planned (the planner iterates the SPECS), so seeing one can only
 * abort the sync, never write it.
 */
export function loadSuppliedValues(
  specs: readonly EnvVarSpec[],
  fromEnvFile: string | undefined,
  alsoCollect: readonly string[] = [],
): Record<string, string> {
  const supplied: Record<string, string> = {};
  const keys = [...specs.map((s) => s.key), ...alsoCollect];
  // Process environment first, so an explicit shell value wins over a file.
  for (const key of keys) {
    const value = process.env[key];
    if (value) supplied[key] = value;
  }
  if (fromEnvFile) {
    if (!existsSync(fromEnvFile)) throw new CliError(`No such file: ${fromEnvFile}`);
    const parsed = parseEnvFile(readFileSync(fromEnvFile, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (value && supplied[key] === undefined) supplied[key] = value;
    }
  }
  return supplied;
}

interface PlannedVar {
  spec: EnvVarSpec;
  value: string;
  origin: "generated" | "derived" | "supplied";
}

/**
 * `drk-deploy env:sync` — brings the project's environment up to the contract.
 *
 * Idempotent by construction: every write is an upsert, and a variable that
 * already exists on Vercel is left alone unless `--force` is given. That
 * matters for secrets — re-running this must never silently rotate
 * BETTER_AUTH_SECRET and sign every user out.
 */
export async function envSync(
  cliRoot: string,
  options: { fromEnv?: string; target?: string; force?: boolean; dryRun?: boolean; yes?: boolean },
): Promise<void> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const targets = parseTargets(options.target);
  const context = deploymentContext(config);
  const specs = envSpecsFor(context);
  const refused = refusedFor(context.profile);

  heading(`Sync environment → ${config.projectId}`);
  info(dim(`  target:  ${describeProfile(context.profile)}`));
  info(dim(`  targets: ${targets.join(", ")}`));

  const existing = await client.listEnv(config.projectId);
  const present = new Set(existing.map((e) => e.key));
  const supplied = loadSuppliedValues(
    specs,
    options.fromEnv,
    refused.map((f) => f.key),
  );
  const derived = derivedValuesFor(context);

  // Refusals come first, before anything is planned. A satellite holding a
  // signing key is not a deployment to top up with a few more variables — it
  // is a consumer that can forge tokens, and syncing it would leave that
  // property in place while printing a page of green ticks.
  assertNoRefusedVariables(refused, present, supplied);

  const planned: PlannedVar[] = [];
  /** Already on the project: left alone unless --force. */
  const unchanged: string[] = [];
  /** Nothing to set them from — reported separately, because "already set" and
   *  "there was no value" are different facts and only one of them is fixed by
   *  --force. */
  const noValue: string[] = [];
  const blocked: Array<{ key: string; why: string }> = [];

  for (const spec of specs) {
    if (present.has(spec.key) && !options.force) {
      unchanged.push(spec.key);
      continue;
    }

    let value = supplied[spec.key];
    let origin: PlannedVar["origin"] = "supplied";

    if (!value && derived[spec.key]) {
      value = derived[spec.key];
      origin = "derived";
    }
    if (!value) {
      switch (spec.source) {
        case "auth-secret":
          // Belt and braces. The Option C spec already declares this value
          // "supplied" so we never reach here for it, but this is the rule
          // that must not be lost to a refactor: generating a session secret
          // for a satellite that shares the kit's session breaks the shared
          // session silently, and silently is the whole problem.
          if (mayGenerateAuthSecret(context.profile)) {
            value = generateAuthSecret();
            origin = "generated";
          }
          break;
        case "operator-secret":
          value = generateOperatorSecret();
          origin = "generated";
          break;
        case "handoff-key":
          // A consumer must never be handed signing material, whatever a spec
          // list says.
          if (context.profile.kind !== "satellite") {
            value = generateHandoffKeypair().privateJwk;
            origin = "generated";
          }
          break;
        default:
          break;
      }
    }

    if (!value) {
      if (spec.level === "required") {
        // `noValueHint` exists for the values that are deliberately not
        // generatable — an Option C satellite's shared session secret, its
        // cookie domain — where "no value available" would read like a bug in
        // this CLI rather than a decision it is holding to.
        blocked.push({ key: spec.key, why: spec.noValueHint ?? "no value available" });
      } else {
        noValue.push(spec.key);
      }
      continue;
    }

    const invalid = spec.validate?.(value);
    if (invalid) {
      blocked.push({ key: spec.key, why: invalid });
      continue;
    }
    planned.push({ spec, value, origin });
  }

  if (blocked.length > 0) {
    heading("Cannot continue");
    for (const b of blocked) field(b.key, red(b.why), 32);
    info("");
    info(`Supply them with ${bold("--from-env <file>")} or as shell variables, then re-run.`);
    if (blocked.some((b) => b.key === "DATABASE_URL")) {
      // `db:provision` refuses for a deployment that does not own a schema, so
      // recommending it there would send the operator at a command that says
      // no — and, if it did not, at an empty database. Same policy, one source.
      info(
        migrationPolicy(context.profile).allowed
          ? `For a new database: ${bold("drk-deploy db:provision")}`
          : `This deployment runs against the ${bold("KIT's")} database — supply the kit's DATABASE_URL (and matching DB_SCHEMA). ${dim("db:provision is refused here.")}`,
      );
    }
    if (blocked.some((b) => b.key === "COOKIE_DOMAIN")) {
      info(`Record the cookie domain: ${bold("drk-deploy init --cookie-domain .example.com")}`);
    }
    throw new CliError(`${blocked.length} required variable(s) unresolved.`);
  }

  heading("Plan");
  for (const item of planned) {
    const note =
      item.origin === "generated"
        ? green("generate")
        : item.origin === "derived"
          ? blue("derive")
          : dim("supplied");
    field(item.spec.key, `${note} ${item.spec.secret ? mask(item.value) : item.value}`, 32);
  }
  if (unchanged.length > 0) {
    info("");
    info(dim(`  unchanged (already set): ${unchanged.join(", ")}`));
    info(dim("  pass --force to overwrite them"));
  }
  if (noValue.length > 0) {
    info("");
    info(dim(`  not set (no value supplied, and not required): ${noValue.join(", ")}`));
    info(dim("  supply them with --from-env or as shell variables if the feature is wanted"));
  }

  if (planned.length === 0) {
    info("");
    ok("Nothing to do — the environment already matches the contract.");
    return;
  }

  if (options.dryRun) {
    info("");
    warn("--dry-run: nothing was written.");
    return;
  }

  const rotating = planned.filter((p) => p.spec.secret && present.has(p.spec.key));
  if (rotating.length > 0 && !options.yes) {
    warn(`--force will ROTATE ${rotating.map((r) => r.spec.key).join(", ")}.`);
    warn("Rotating BETTER_AUTH_SECRET signs out every active session. Re-run with --yes to confirm.");
    throw new CliError("Refusing to rotate secrets without --yes.");
  }

  heading("Writing");
  for (const item of planned) {
    await client.upsertEnv(config.projectId, {
      key: item.spec.key,
      value: item.value,
      type: vercelTypeFor(item.spec),
      target: targets,
      comment: item.spec.comment,
    });
    ok(`${item.spec.key} ${item.spec.secret ? mask(item.value) : dim(item.value)}`);
  }

  const handoff = planned.find((p) => p.spec.key === "SSO_HANDOFF_PRIVATE_KEY" && p.origin === "generated");
  if (handoff) {
    info("");
    info(bold("A new SSO signing key was generated."));
    info("Satellites verify against this deployment's /api/sso/jwks.json — no key is distributed to them.");
    info("It takes effect on the next deployment.");
  }

  info("");
  info(`${bold("NEXT_PUBLIC_*")} values are inlined at build time — redeploy for them to take effect.`);
}

/**
 * `drk-deploy env:check` — reports what the deployment is missing, and what it
 * has that it should not.
 *
 * It checks PRESENCE only, for every variable: `listEnv` does not fetch
 * values, and Vercel never returns an encrypted or sensitive one anyway. The
 * `validate` rules run in `env:sync`, and only on a value it is about to
 * write. Say so rather than implying a value was verified.
 */
export async function envCheck(cliRoot: string): Promise<number> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const context = deploymentContext(config);
  const specs = envSpecsFor(context);
  const refused = refusedFor(context.profile);

  heading(`Environment → ${config.projectId}`);
  info(dim(`  ${describeProfile(context.profile)}`));
  const existing = await client.listEnv(config.projectId);
  const byKey = new Map(existing.map((e) => [e.key, e]));

  let problems = 0;

  // Configuration errors first: they are cheaper to read than a wall of
  // variables, and a satellite that names itself as its own SSO issuer will
  // show every variable "set" while no handoff can ever succeed.
  problems += reportConfigProblems(context);

  const rows: Array<[string, string]> = [];
  for (const spec of specs) {
    const found = byKey.get(spec.key);
    if (found) {
      const scope = found.target.length ? dim(found.target.join(",")) : dim("(no target)");
      rows.push([spec.key, `${green("set")} ${scope}`]);
      continue;
    }
    if (spec.level === "required") {
      rows.push([spec.key, `${red("MISSING")} — ${spec.consequence}`]);
      problems += 1;
    } else if (spec.level === "recommended") {
      rows.push([spec.key, `${yellow("missing")} — ${spec.consequence}`]);
      problems += 1;
    } else {
      rows.push([spec.key, dim("unset (has a default)")]);
    }
  }
  for (const [key, value] of rows) field(key, value, 32);

  const presentRefused = refused.filter((f) => byKey.has(f.key));
  if (presentRefused.length > 0) {
    heading(`Must NOT be set on this ${context.profile.kind === "satellite" ? "satellite" : "deployment"}`);
    for (const f of presentRefused) {
      field(f.key, `${red("present")} — ${f.why}`, 32);
      problems += 1;
    }
    info("");
    info(`Remove with: ${bold("drk-deploy env:prune")}`);
  }

  const forbidden = FORBIDDEN_ON_VERCEL.filter((f) => byKey.has(f.key));
  if (forbidden.length > 0) {
    heading("Should not be set on a deployment");
    for (const f of forbidden) {
      field(f.key, `${red("present")} — ${f.why}`, 32);
      problems += 1;
    }
    info("");
    info(`Remove with: ${bold("drk-deploy env:prune")}`);
  }

  const unknown = existing.filter(
    (e) =>
      !specs.some((s) => s.key === e.key) &&
      !FORBIDDEN_ON_VERCEL.some((f) => f.key === e.key) &&
      !refused.some((f) => f.key === e.key),
  );
  if (unknown.length > 0) {
    heading("Not part of the contract (left alone)");
    info(dim(`  ${unknown.map((u) => u.key).join(", ")}`));
  }

  info("");
  if (problems === 0) ok("Environment satisfies the contract.");
  else warn(`${problems} item(s) need attention.`);
  info(dim("  Variables are checked for PRESENCE only — values are not read, so none is validated."));

  // After the verdict, and not counted in it: a satellite on the kit's
  // database satisfies the contract and still is not contained (F-24).
  reportContainment(context.profile, context.origin);
  return problems;
}

/**
 * Says when an A or B satellite is NOT contained (F-24), every time the
 * deployment is checked or shipped.
 *
 * Returns how many warnings it printed, and never adds them to a problem
 * count: `deploy` refuses on problems, and the satellites deployed so far all
 * run on the kit's database. They must keep deploying. What must stop is an
 * operator reading "handoff consumer" and concluding that a compromise of this
 * app ends here. `warn` rather than `info`, so `--quiet` does not hide it.
 */
export function reportContainment(profile: DeploymentProfile, origin: string): number {
  if (profile.kind !== "satellite") return 0;
  const warnings = containmentWarnings({ profile, origin });
  if (warnings.length === 0) return 0;

  heading("Containment (a warning, not a failed check)");
  for (const warning of warnings) {
    warn(`Not contained (${warning.what}): ${warning.why}.`);
    info(`    ${dim(warning.hint)}`);
  }
  warn(`What containment takes, and why: ${CONTAINMENT_DOC} (in the kit checkout)`);
  return warnings.length;
}

/** `drk-deploy env:prune` — removes variables that must not exist on a deployment. */
export async function envPrune(cliRoot: string, options: { dryRun?: boolean; yes?: boolean }): Promise<void> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const context = deploymentContext(config);
  // On a satellite this is the command that removes a stray signing key, so it
  // prunes the target-specific refusals as well as the development-only ones.
  const removable = [...refusedFor(context.profile), ...FORBIDDEN_ON_VERCEL];
  const existing = await client.listEnv(config.projectId);
  const doomed = existing.filter((e) => removable.some((f) => f.key === e.key));

  heading("Prune variables that must not be set here");
  info(dim(`  ${describeProfile(context.profile)}`));
  if (doomed.length === 0) {
    ok("Nothing to remove.");
    return;
  }
  for (const item of doomed) {
    const why = removable.find((f) => f.key === item.key)?.why ?? "";
    field(item.key, dim(why), 32);
  }
  if (options.dryRun) {
    info("");
    warn("--dry-run: nothing was removed.");
    return;
  }
  if (!options.yes) throw new CliError("Re-run with --yes to remove these.");
  for (const item of doomed) {
    await client.removeEnv(config.projectId, item.id);
    ok(`removed ${item.key}`);
  }
}

/**
 * Refuses to sync when a must-not-be-set variable is already on the project,
 * or is about to be supplied to one.
 *
 * `env:sync` only ever writes variables that are in the active spec list, so a
 * refused key could not be written by accident — but "could not be written" is
 * not the same as "is not there". A satellite that already holds
 * SSO_HANDOFF_PRIVATE_KEY can mint handoff tokens the whole fleet trusts, and
 * topping up its other variables would leave that in place while reporting
 * success. Fail closed, name the variable, point at the one command that
 * removes it.
 *
 * `supplied` covers the shell and the --from-env file (see
 * `loadSuppliedValues`), which is what lets the hint below honestly tell the
 * operator to clear both.
 */
function assertNoRefusedVariables(
  refused: ReadonlyArray<{ key: string; why: string }>,
  present: ReadonlySet<string>,
  supplied: Readonly<Record<string, string>>,
): void {
  const offenders = refused.filter((f) => present.has(f.key) || supplied[f.key] !== undefined);
  if (offenders.length === 0) return;

  heading("Refusing to sync");
  for (const f of offenders) {
    const where = present.has(f.key) ? "set on this project" : "supplied to this run";
    field(f.key, `${red(where)} — ${f.why}`, 32);
  }
  info("");
  throw new CliError(`${offenders.length} variable(s) must not exist on this deployment target.`, {
    hint: "Remove them with `drk-deploy env:prune`, and drop them from any --from-env file or shell environment, then re-run.",
  });
}

/** Config-level mistakes that no amount of correctly-set variables can fix. */
function reportConfigProblems(context: DeploymentContext): number {
  if (context.profile.kind !== "satellite") return 0;
  const problems = satelliteConfigProblems({
    profile: context.profile,
    origin: context.origin,
    applicationId: context.applicationId,
    audiencePrefix: context.audiencePrefix,
  });
  if (problems.length === 0) return 0;

  heading("Configuration");
  for (const problem of problems) {
    field(problem.what, `${red("wrong")} — ${problem.why}`, 32);
    if (problem.hint) info(`  ${dim(`  ${problem.hint}`)}`);
  }
  return problems.length;
}

function parseTargets(value: string | undefined): EnvTarget[] {
  if (!value) return ["production"];
  if (value === "all") return [...ALL_TARGETS];
  const parts = value.split(",").map((s) => s.trim());
  for (const part of parts) {
    if (!ALL_TARGETS.includes(part as EnvTarget)) {
      throw new CliError(`Unknown target \`${part}\`.`, {
        hint: `Use one of: ${ALL_TARGETS.join(", ")}, or "all".`,
      });
    }
  }
  return parts as EnvTarget[];
}
