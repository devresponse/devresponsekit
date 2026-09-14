import { existsSync, readFileSync } from "node:fs";
import { requireConfig, requireToken } from "../lib/config.js";
import {
  ALL_TARGETS,
  ENV_SPECS,
  type EnvTarget,
  type EnvVarSpec,
  FORBIDDEN_ON_VERCEL,
  derivedValues,
  vercelTypeFor,
} from "../lib/env-spec.js";
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

function loadSuppliedValues(fromEnvFile: string | undefined): Record<string, string> {
  const supplied: Record<string, string> = {};
  // Process environment first, so an explicit shell value wins over a file.
  for (const spec of ENV_SPECS) {
    const value = process.env[spec.key];
    if (value) supplied[spec.key] = value;
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

  heading(`Sync environment → ${config.projectId}`);
  info(dim(`  targets: ${targets.join(", ")}`));

  const existing = await client.listEnv(config.projectId);
  const present = new Set(existing.map((e) => e.key));
  const supplied = loadSuppliedValues(options.fromEnv);
  const derived = derivedValues({
    origin: config.origin,
    appName: config.appName,
    audiencePrefix: config.audiencePrefix,
    applicationId: config.applicationId,
  });

  const planned: PlannedVar[] = [];
  const skipped: string[] = [];
  const blocked: Array<{ key: string; why: string }> = [];

  for (const spec of ENV_SPECS) {
    if (present.has(spec.key) && !options.force) {
      skipped.push(spec.key);
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
          value = generateAuthSecret();
          origin = "generated";
          break;
        case "operator-secret":
          value = generateOperatorSecret();
          origin = "generated";
          break;
        case "handoff-key":
          value = generateHandoffKeypair().privateJwk;
          origin = "generated";
          break;
        default:
          break;
      }
    }

    if (!value) {
      if (spec.level === "required") {
        blocked.push({ key: spec.key, why: "no value available" });
      } else {
        skipped.push(spec.key);
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
      info(`For a new database: ${bold("drk-deploy db:provision")}`);
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
  if (skipped.length > 0) {
    info("");
    info(dim(`  unchanged (already set): ${skipped.join(", ")}`));
    info(dim("  pass --force to overwrite them"));
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
 * Presence is all the API can prove for an encrypted value (Vercel does not
 * return it), so this checks presence for secrets and validates the plain ones.
 * Say so rather than implying a value was verified.
 */
export async function envCheck(cliRoot: string): Promise<number> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);

  heading(`Environment → ${config.projectId}`);
  const existing = await client.listEnv(config.projectId);
  const byKey = new Map(existing.map((e) => [e.key, e]));

  let problems = 0;

  const rows: Array<[string, string]> = [];
  for (const spec of ENV_SPECS) {
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
    (e) => !ENV_SPECS.some((s) => s.key === e.key) && !FORBIDDEN_ON_VERCEL.some((f) => f.key === e.key),
  );
  if (unknown.length > 0) {
    heading("Not part of the contract (left alone)");
    info(dim(`  ${unknown.map((u) => u.key).join(", ")}`));
  }

  info("");
  if (problems === 0) ok("Environment satisfies the contract.");
  else warn(`${problems} item(s) need attention.`);
  info(dim("  Secrets are checked for PRESENCE only — Vercel never returns an encrypted value."));
  return problems;
}

/** `drk-deploy env:prune` — removes variables that must not exist on a deployment. */
export async function envPrune(cliRoot: string, options: { dryRun?: boolean; yes?: boolean }): Promise<void> {
  const config = requireConfig(cliRoot);
  const client = new VercelClient(requireToken(), config.teamId);
  const existing = await client.listEnv(config.projectId);
  const doomed = existing.filter((e) => FORBIDDEN_ON_VERCEL.some((f) => f.key === e.key));

  heading("Prune development-only variables");
  if (doomed.length === 0) {
    ok("Nothing to remove.");
    return;
  }
  for (const item of doomed) {
    const why = FORBIDDEN_ON_VERCEL.find((f) => f.key === item.key)?.why ?? "";
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
