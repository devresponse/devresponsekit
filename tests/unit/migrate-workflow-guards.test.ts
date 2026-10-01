import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_WAIT_MS } from "@/db/deploy-gate";
import { resolveMigrationLockWait } from "@/db/migration-lock";
import { invalidServerEnvKeys } from "@/lib/env";
// The placeholders drk-deploy hands the same runner (F-141). drk-deploy
// cannot import the kit across its package boundary, so both are held to the
// kit's env schema here.
import { AUTH_MIGRATION_PLACEHOLDERS } from "../../vercel-cli/src/lib/migration-env";

/**
 * The production migration workflow (DEP2, carrying DEPLOY-1 and review
 * 2026-09-04 #10 over from the retired deploy.yml).
 *
 * `.github/workflows/migrate-production.yml` is the only workflow that holds
 * production's OWNER database credential, and it runs unattended on every
 * push to `main`. A workflow file is never exercised by the test suite, so
 * every property that keeps that credential fenced, and the schema gate's
 * race safe, is pinned here from the parsed YAML:
 *
 * - triggers: exactly a push to `main` and a manual dispatch. No
 *   `pull_request`, `pull_request_target` or `workflow_run`, the triggers
 *   that run another ref's code or another workflow's result;
 * - `permissions: contents: read`, and a run in progress is never cancelled;
 * - both jobs name the `production-migrations` environment (an environment
 *   secret is invisible to a job that does not), and `migrate` restates the
 *   configured check and the main-ref guard in its own `if:`, never only
 *   through `needs:`;
 * - the secret appears only in the preflight check (as a presence boolean)
 *   and in the two migrate steps; no workflow or job `env:` holds it, no other
 *   workflow reads it, and no Vercel token appears at all;
 * - Better Auth's migrations run before the application's (F-26), the auth
 *   step's placeholders are exactly the kit's required keys less
 *   DATABASE_URL, and both steps bound the advisory-lock wait inside the
 *   gate's window;
 * - the checkout is the pushed commit, every action is pinned by SHA as
 *   ci.yml pins it, and no job may run longer than 15 minutes.
 *
 * docs/testing.md §9 has why workflow shape is pinned in unit tests.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const WORKFLOWS = ".github/workflows";
const SECRET = "PRODUCTION_DIRECT_DATABASE_URL";
const ENVIRONMENT = "production-migrations";
const AUTH_STEP = "Apply Better Auth migrations (production)";
const APP_STEP = "Apply application migrations (production)";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  environment?: string;
  outputs?: Record<string, string>;
  permissions?: unknown;
  env?: unknown;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  env?: unknown;
  jobs: Record<string, Job>;
}

const source = read(`${WORKFLOWS}/migrate-production.yml`);
/** Parsed the way dependency-governance.test.ts reads dependabot.yml: gray-matter's js-yaml. */
const parse = (yaml: string) => matter(`---\n${yaml}\n---\n`).data as Workflow;
const workflow = parse(source);
const preflight = workflow.jobs.preflight!;
const migrate = workflow.jobs.migrate!;

/** One step of a job by name (or id); throws when it is missing rather than testing nothing. */
function step(job: Job, nameOrId: string): Step {
  const found = job.steps.find((s) => s.name === nameOrId || s.id === nameOrId);
  if (!found) throw new Error(`migrate-production.yml has no step ${JSON.stringify(nameOrId)}`);
  return found;
}

/** Every string in `value`, with the path that reaches it. */
function strings(value: unknown, at: string): Array<[string, string]> {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => strings(item, `${at}.${key}`));
  }
  return [];
}

/** Full-line YAML comments removed: the header explains the guards by quoting them. */
const code = source
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("migrate-production workflow: triggers and run control (DEP2)", () => {
  it("replaces deploy.yml, which is gone", () => {
    expect(existsSync(path.join(ROOT, WORKFLOWS, "deploy.yml"))).toBe(false);
    expect(workflow.name).toBe("Migrate production database");
  });

  it("runs on a push to main and on a manual dispatch, and nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
    for (const trigger of ["pull_request", "pull_request_target", "workflow_run"]) {
      expect(code, trigger).not.toMatch(new RegExp(`^\\s*${trigger}:`, "m"));
    }
  });

  it("reads the repository only, and never cancels a run mid-migration", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(preflight.permissions).toBeUndefined();
    expect(migrate.permissions).toBeUndefined();
    expect(workflow.concurrency).toEqual({ group: ENVIRONMENT, "cancel-in-progress": false });
  });

  it("has a preflight and a migrate job, both in the production-migrations environment, each within 15 minutes", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["migrate", "preflight"]);
    for (const [label, job] of Object.entries(workflow.jobs)) {
      expect(job.environment, label).toBe(ENVIRONMENT);
      expect(job["timeout-minutes"], label).toBeGreaterThan(0);
      expect(job["timeout-minutes"], label).toBeLessThanOrEqual(15);
    }
  });
});

describe("migrate-production workflow: the owner credential is fenced (DEPLOY-1, #10)", () => {
  it("gates migrate on preflight's verdict AND restates the main-ref guard in its own if:", () => {
    expect(migrate.needs).toBe("preflight");
    expect(preflight.outputs).toEqual({ configured: "${{ steps.check.outputs.configured }}" });
    const guard = migrate.if ?? "";
    expect(guard).toContain("needs.preflight.outputs.configured == 'true'");
    expect(guard).toContain("github.ref == 'refs/heads/main'");
    expect(guard).toContain(
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    // `always()` / `!cancelled()` / `failure()` override the implicit
    // `success()` over `needs:` that makes a skipped preflight skip migrate.
    expect(guard).not.toMatch(/\b(always|cancelled|failure|success)\s*\(\s*\)/);
  });

  it("reads the secret only as a presence boolean in preflight, which never fails the run", () => {
    const check = step(preflight, "check");
    expect(check.env).toEqual({ HAS_URL: `\${{ secrets.${SECRET} != '' }}` });
    const script = check.run ?? "";
    const configuredTrue = script.indexOf('echo "configured=true" >> "$GITHUB_OUTPUT"');
    const configuredFalse = script.indexOf('echo "configured=false" >> "$GITHUB_OUTPUT"');
    expect(script.indexOf('if [ "$HAS_URL" = "true" ]; then')).toBeGreaterThan(-1);
    expect(configuredTrue).toBeGreaterThan(script.indexOf('if [ "$HAS_URL" = "true" ]; then'));
    expect(configuredFalse).toBeGreaterThan(configuredTrue);
    // Unconfigured is a green skip with a notice and a summary, not a failure.
    expect(script).not.toMatch(/\bexit [1-9]/);
    expect(script.indexOf("::notice title=Production migrations not automated::")).toBeGreaterThan(
      configuredFalse,
    );
    expect(script).toContain(
      "migrations are not automated; docs/deployment.md §1.1 hand gate applies",
    );
    expect(script).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  it("names the secret only in the preflight check and the two migrate steps", () => {
    const where = strings(workflow, "workflow")
      .filter(([, value]) => value.includes(SECRET))
      .map(([at]) => at.replace(/\.(env|run)\..*$|\.(env|run)$/, ""));
    const checkIndex = preflight.steps.indexOf(step(preflight, "check"));
    const authIndex = migrate.steps.indexOf(step(migrate, AUTH_STEP));
    const appIndex = migrate.steps.indexOf(step(migrate, APP_STEP));
    expect(new Set(where)).toEqual(
      new Set([
        `workflow.jobs.preflight.steps[${checkIndex}]`,
        `workflow.jobs.migrate.steps[${authIndex}]`,
        `workflow.jobs.migrate.steps[${appIndex}]`,
      ]),
    );
    // As a secret expression: exactly these three reads, all of this one secret.
    expect(code.match(/\$\{\{\s*secrets\.\w+[^}]*\}\}/g)).toEqual([
      `\${{ secrets.${SECRET} != '' }}`,
      `\${{ secrets.${SECRET} }}`,
      `\${{ secrets.${SECRET} }}`,
    ]);
    expect(step(migrate, AUTH_STEP).env?.DATABASE_URL).toBe(`\${{ secrets.${SECRET} }}`);
    expect(step(migrate, APP_STEP).env?.DATABASE_URL).toBe(`\${{ secrets.${SECRET} }}`);
    // Never at workflow or job level, where every step (pnpm install's
    // lifecycle scripts included) would see it.
    expect(workflow.env).toBeUndefined();
    expect(preflight.env).toBeUndefined();
    expect(migrate.env).toBeUndefined();
  });

  it("is the only workflow that reads the secret or names the environment", () => {
    // An environment secret is readable by ANY job naming the environment, so
    // a second workflow naming it would widen the audience (I-09).
    const others = readdirSync(path.join(ROOT, WORKFLOWS)).filter(
      (file) => /\.ya?ml$/.test(file) && file !== "migrate-production.yml",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      const text = read(`${WORKFLOWS}/${file}`);
      expect(text, file).not.toContain(`secrets.${SECRET}`);
      expect(text, file).not.toMatch(new RegExp(`environment:\\s*${ENVIRONMENT}\\b`));
    }
  });

  it("carries no Vercel token, anywhere", () => {
    expect(source).not.toContain("VERCEL_TOKEN");
    expect(code).not.toMatch(/\bvercel\s+(?:pull|build|deploy|promote)\b/);
  });

  it("runs the pushed commit's code: the checkout is github.sha", () => {
    const checkout = migrate.steps[0]!;
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with).toEqual({ ref: "${{ github.sha }}" });
  });

  it("installs with no secret in reach", () => {
    const install = step(migrate, "Install dependencies");
    expect(install.run).toBe("pnpm install --frozen-lockfile");
    expect(install.env).toBeUndefined();
    expect(migrate.steps.indexOf(install)).toBeLessThan(
      migrate.steps.indexOf(step(migrate, AUTH_STEP)),
    );
  });

  it("pins every action by full commit SHA, to the same commits ci.yml uses", () => {
    const pins = (yaml: string) =>
      new Map(
        Object.values(parse(yaml).jobs)
          .flatMap((job) => job.steps ?? [])
          .flatMap((s) => (s.uses ? [s.uses.split("@") as [string, string]] : [])),
      );
    const ours = [...pins(source)];
    const ci = pins(read(`${WORKFLOWS}/ci.yml`));
    expect(ours.map(([action]) => action).sort()).toEqual([
      "actions/checkout",
      "actions/setup-node",
      "pnpm/action-setup",
    ]);
    for (const [action, ref] of ours) {
      expect(ref, action).toMatch(/^[0-9a-f]{40}$/);
      expect(ref, action).toBe(ci.get(action));
    }
  });
});

describe("migrate-production workflow: what the migrate steps run (F-26, F-141, DEP2)", () => {
  const auth = step(migrate, AUTH_STEP);
  const app = step(migrate, APP_STEP);

  it("applies Better Auth's migrations, then the application's, then writes a summary", () => {
    expect(auth.run).toBe("pnpm db:auth:migrate");
    expect(app.run).toBe("pnpm db:app:migrate");
    const order = [auth, app, step(migrate, "Summary")].map((s) => migrate.steps.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("hands the auth runner exactly the kit's required keys less DATABASE_URL, as CI placeholders", () => {
    const placeholders = Object.fromEntries(
      Object.entries(auth.env ?? {}).filter(
        ([key]) => !["DATABASE_URL", "DB_SCHEMA", "DB_MIGRATE_LOCK_WAIT_MS"].includes(key),
      ),
    );
    const required = invalidServerEnvKeys({ NODE_ENV: "production" }).filter(
      (key) => key !== "DATABASE_URL",
    );
    expect(Object.keys(placeholders).sort()).toEqual(required);
    // The values drk-deploy uses for the same runner, so the two cannot drift.
    expect(placeholders).toEqual(AUTH_MIGRATION_PLACEHOLDERS);
    expect(String(placeholders.BETTER_AUTH_SECRET)).toMatch(
      /^ci-only-[a-z0-9-]+-not-for-production$/,
    );
    // With a database URL they pass the schema the runner validates at load
    // (GitHub sets no NODE_ENV).
    const env = {
      ...placeholders,
      DATABASE_URL: "postgresql://owner:secret@db.example.com:5432/app",
    } as unknown as NodeJS.ProcessEnv;
    expect(invalidServerEnvKeys(env)).toEqual([]);
  });

  it("hands the application runner the URL, the schema and the lock wait only", () => {
    expect(Object.keys(app.env ?? {}).sort()).toEqual([
      "DATABASE_URL",
      "DB_MIGRATE_LOCK_WAIT_MS",
      "DB_SCHEMA",
    ]);
  });

  it("bounds both runners' advisory-lock wait well inside the schema gate's window", () => {
    for (const s of [auth, app]) {
      expect(s.env?.DB_SCHEMA, s.name).toBe("${{ vars.DB_SCHEMA || 'auth' }}");
      const wait = resolveMigrationLockWait({
        DB_MIGRATE_LOCK_WAIT_MS: String(s.env?.DB_MIGRATE_LOCK_WAIT_MS),
      });
      expect(wait, s.name).toBe(300_000);
      expect(wait!, s.name).toBeLessThan(DEFAULT_GATE_WAIT_MS);
    }
  });

  it("sets no search_path switch and no libpq fallback: the runners' own checks catch a wrong schema", () => {
    for (const s of migrate.steps) {
      for (const key of Object.keys(s.env ?? {})) {
        expect(key, s.name).not.toBe("DB_SEARCH_PATH_VIA_OPTIONS");
        expect(key, s.name).not.toMatch(/^PG/);
      }
    }
  });

  it("summarises the commit and never a URL", () => {
    const summary = step(migrate, "Summary");
    expect(summary.env).toBeUndefined();
    expect(summary.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(summary.run).toContain("$GITHUB_SHA");
    expect(summary.run).not.toMatch(/DATABASE_URL|secrets\.|postgres/i);
  });
});

describe("the settings no file can set are named where an operator looks (I-09)", () => {
  it("SECURITY.md lists SHA pinning and the production-migrations environment's branch policy", () => {
    const securityMd = read("SECURITY.md");
    const start = securityMd.indexOf("\n## Repository security settings\n");
    expect(start).toBeGreaterThan(-1);
    const end = securityMd.indexOf("\n## ", start + 1);
    const settings = securityMd.slice(start, end === -1 ? undefined : end);
    expect(settings).toContain("**Require actions to be pinned to a full-length commit SHA**");
    expect(settings).toContain("gh api repos/devresponse/devresponsekit/actions/permissions");
    expect(settings).toContain("-F sha_pinning_required=true");
    expect(settings).toContain(
      `**\`${ENVIRONMENT}\` environment: deployment branches** | \`main\` only`,
    );
    expect(settings).toContain(`environments/${ENVIRONMENT}/deployment-branch-policies`);
    expect(settings).toContain(`**\`${ENVIRONMENT}\` environment: required reviewers** | none`);
  });
});
