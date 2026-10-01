import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { LOGIN_PASSWORD_RE } from "@/db/runtime-login";
import { isKitLoginName } from "@/db/runtime-privileges";

/**
 * The CI proof of the least-privilege runtime (DEP3): ci.yml's browser job
 * runs the app, the schema gate and the runtime jobs as a non-owner LOGIN that
 * `pnpm db:runtime-login` made, in production's pooled shape, against an
 * owner shaped like Neon's (a non-superuser with CREATEROLE). A code path
 * that needs more than the privilege manifest grants then fails E2E, or the
 * server-log grep, instead of production. A workflow file is never run by
 * the suite, so what makes the job that proof is pinned here, from the parsed
 * YAML (comments cannot satisfy an assertion) and from the job's text with
 * its comments stripped, in the style of vercel-cli-ci.test.ts and
 * migrate-workflow-guards.test.ts.
 */

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  name: string;
  env: Record<string, string>;
  steps: Step[];
}

const raw = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const ci = matter(`---\n${raw}\n---\n`).data as { jobs: Record<string, Job> };
const job = ci.jobs.browser!;
const OWNER_URL = "${{ env.CI_OWNER_DATABASE_URL }}";

/** The browser job's text, full-line comments removed. */
const jobCode = (() => {
  const start = raw.indexOf("\n  browser:\n");
  const next = /\n {2}[\w-]+:\n/g;
  next.lastIndex = start + 1;
  const end = next.exec(raw)?.index ?? raw.length;
  return raw
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
})();

function stepIndex(match: (step: Step) => boolean, what: string): number {
  const i = job.steps.findIndex(match);
  if (i === -1) throw new Error(`the browser job has no step that ${what}`);
  return i;
}
const runs = (command: string) => (step: Step) => (step.run ?? "").includes(command);
const named = (name: string) => (step: Step) => step.name === name;

const OWNER_CREATE = stepIndex(runs("create role app_owner"), "creates app_owner");
const MIGRATE = stepIndex(runs("pnpm db:app:migrate"), "runs db:app:migrate");
const LOGIN = stepIndex(runs("pnpm db:runtime-login"), "runs db:runtime-login");
const SEED = stepIndex(runs("pnpm db:seed"), "runs db:seed");
const GATE = stepIndex(runs("pnpm deploy:gate"), "runs the schema gate");
const START = stepIndex(runs("pnpm start"), "starts the server");
const E2E = stepIndex(runs("pnpm test:e2e"), "runs the e2e suite");
const A11Y = stepIndex(runs("pnpm test:a11y"), "runs the accessibility suite");
const JOBS = stepIndex(runs("pnpm db:prune"), "runs the runtime jobs");
const GREP = stepIndex(runs("permission denied"), "greps the server log");
const UPLOAD = stepIndex(named("Upload Playwright traces"), "uploads the traces");

describe("ci.yml browser job: the app runs as a non-owner login (DEP3)", () => {
  it("keeps the required check's name", () => {
    expect(job.name).toBe("E2E + accessibility (Playwright)");
  });

  it("connects as a kit login by default, and names a different user as the owner", () => {
    const runtime = new URL(job.env.DATABASE_URL!);
    const owner = new URL(job.env.CI_OWNER_DATABASE_URL!);
    expect(runtime.username).not.toBe(owner.username);
    expect(isKitLoginName("auth", runtime.username)).toBe(true);
    expect(owner.username).toBe("app_owner");
    expect([runtime.host, runtime.pathname]).toEqual([owner.host, owner.pathname]);
    expect(job.env.DB_SCHEMA).toBe("auth");
    // Both literals fall under the gitleaks allowlist for CI-only values
    // (.gitleaks.toml), and the login's password passes the command's rule.
    for (const password of [runtime.password, owner.password]) {
      expect(password).toMatch(/^ci-only-[a-z0-9-]+-not-for-production$/);
    }
    expect(runtime.password).toMatch(LOGIN_PASSWORD_RE);
  });

  it("creates the non-superuser owner first, as the service's superuser, and makes it own the database", () => {
    expect(OWNER_CREATE).toBeLessThan(MIGRATE);
    const run = job.steps[OWNER_CREATE]!.run!;
    expect(run).toContain("docker exec ${{ job.services.postgres.id }} psql -v ON_ERROR_STOP=1");
    expect(run).toContain("create role app_owner login createrole password");
    expect(run).not.toMatch(/superuser/i);
    expect(run).toContain("alter database devresponse_db owner to app_owner");
  });

  it("migrates, creates the login and seeds as the owner", () => {
    for (const i of [MIGRATE, LOGIN, SEED]) {
      expect(job.steps[i]!.env?.DATABASE_URL, job.steps[i]!.name).toBe(OWNER_URL);
    }
    expect(job.steps[MIGRATE]!.run).toMatch(/pnpm db:auth:migrate && pnpm db:app:migrate/);
  });

  it("creates the login after the migration and before the seed, the gate and the server", () => {
    expect(MIGRATE).toBeLessThan(LOGIN);
    expect(LOGIN).toBeLessThan(SEED);
    expect(LOGIN).toBeLessThan(GATE);
    expect(LOGIN).toBeLessThan(START);
    const step = job.steps[LOGIN]!;
    const login = /--login (\S+)/.exec(step.run!)?.[1];
    expect(login).toBe(new URL(job.env.DATABASE_URL!).username);
    expect(step.env?.DB_RUNTIME_LOGIN_PASSWORD).toBe(new URL(job.env.DATABASE_URL!).password);
  });

  it("runs the gate as a production build in the pooled shape, and requires runtime=non-owner", () => {
    const step = job.steps[GATE]!;
    expect(step.env).toMatchObject({ VERCEL_ENV: "production", DB_SEARCH_PATH_VIA_OPTIONS: "0" });
    expect(step.env?.DATABASE_URL).toBeUndefined();
    expect(step.run).toMatch(/set -o pipefail/);
    expect(step.run).toMatch(/pnpm deploy:gate \| tee "\$RUNNER_TEMP\/gate\.log"/);
    expect(step.run).toMatch(/grep -q 'runtime=non-owner' "\$RUNNER_TEMP\/gate\.log"/);
    expect(GATE).toBeGreaterThan(SEED);
  });

  it("starts the server as the login, logs to a file, and waits on readiness", () => {
    const step = job.steps[START]!;
    expect(step.env).toEqual({ DB_SEARCH_PATH_VIA_OPTIONS: "0" });
    expect(step.run).toContain('pnpm start > "$RUNNER_TEMP/server.log" 2>&1 &');
    expect(step.run).toContain("http://localhost:3000/api/health/ready");
    expect(START).toBeGreaterThan(GATE);
    expect(START).toBeLessThan(E2E);
  });

  it("runs the runtime jobs as the login, then greps the server log, after E2E and a11y", () => {
    expect(job.steps[JOBS]!.env).toEqual({ DB_SEARCH_PATH_VIA_OPTIONS: "0" });
    expect(job.steps[JOBS]!.run).toMatch(/pnpm db:prune && pnpm mcp:reap/);
    const grep = job.steps[GREP]!;
    expect(GREP).toBeGreaterThan(E2E);
    expect(GREP).toBeGreaterThan(A11Y);
    expect(GREP).toBeGreaterThan(JOBS);
    expect(grep.if).toBe("${{ !cancelled() }}");
    expect(grep.run!.trim()).toBe(
      `! grep -nE 'permission denied|must be owner of' "$RUNNER_TEMP/server.log"`,
    );
  });

  it("uploads the server and gate logs with the traces on failure", () => {
    const upload = job.steps[UPLOAD]!;
    expect(upload.if).toBe("failure()");
    expect(upload.with?.path).toContain("${{ runner.temp }}/server.log");
    expect(upload.with?.path).toContain("${{ runner.temp }}/gate.log");
    expect(UPLOAD).toBeGreaterThan(GREP);
  });

  it("sets DB_SEARCH_PATH_VIA_OPTIONS only on the gate, the server and the runtime jobs, never for the job", () => {
    expect(job.env).not.toHaveProperty("DB_SEARCH_PATH_VIA_OPTIONS");
    const withFlag = job.steps.flatMap((step, i) =>
      step.env && "DB_SEARCH_PATH_VIA_OPTIONS" in step.env ? [i] : [],
    );
    expect(withFlag).toEqual([GATE, START, JOBS]);
    expect(jobCode.match(/DB_SEARCH_PATH_VIA_OPTIONS/g)).toHaveLength(3);
    // The old shape, the app and the e2e run as the superuser, is gone.
    expect(jobCode).not.toContain("postgresql://devresponse:devresponse@");
  });

  it("runs on Node 24", () => {
    const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(String(setup?.with?.["node-version"])).toBe("24");
  });
});
