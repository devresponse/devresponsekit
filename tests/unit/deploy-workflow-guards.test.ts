import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production deploy workflow guards (DEPLOY-1, review 2026-09-04 #10).
 *
 * `.github/workflows/deploy.yml` is the only workflow that can apply DDL to
 * the production database and promote a build onto the production alias. Two
 * invariants keep it honest, and until now both existed only as comments
 * asking a human not to break them:
 *
 * 1. **Three states, not two.** `deploy` runs only when `preflight` found all
 *    four credentials, and `preflight` FAILS the run on a partial set. Zero of
 *    four means nobody adopted this path, so the run skips green; one to three
 *    means somebody believes production deploys from here and got a secret
 *    name wrong, so the run must go red. Collapsing the partial case into the
 *    quiet skip would hide production having stopped deploying, on a repo that
 *    auto-merges on green.
 * 2. **The fork guard is stated on both jobs.** `deploy` checks out
 *    `workflow_run.head_sha`, runs `pnpm install` over that tree and hands it
 *    `PRODUCTION_DIRECT_DATABASE_URL` (owner-role DDL) and `VERCEL_TOKEN`, so
 *    the guard has to hold on that job itself rather than only through
 *    `needs:`. Dropping `needs: preflight`, or adding `always()` /
 *    `!cancelled()` so the job reports instead of skipping, are each one-line
 *    edits that would otherwise put fork code within reach of production
 *    credentials with every check still green.
 *
 * A workflow file is never exercised by the test suite, so a regression in
 * either invariant is invisible until it is an incident. This repo pins
 * workflow shape in unit tests for that reason — see
 * `dependency-governance.test.ts` and docs/testing.md §9.
 */

const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/deploy.yml"), "utf8");

/** The four secrets that must ALL be present before anything deploys. */
const CREDENTIALS = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "PRODUCTION_DIRECT_DATABASE_URL",
] as const;

/** Every clause of the fork/trigger guard, which each job restates in full. */
const FORK_GUARD = [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_repository.full_name == github.repository",
] as const;

/**
 * Slice between markers that must exist. A missing marker throws rather than
 * silently slicing from -1, which would hand every assertion below a haystack
 * that happens to contain what it looks for.
 */
function sliceAt(haystack: string, from: string, to?: string): string {
  const start = haystack.indexOf(from);
  if (start === -1) throw new Error(`deploy.yml no longer contains ${JSON.stringify(from)}`);
  if (to === undefined) return haystack.slice(start);
  const end = haystack.indexOf(to, start);
  if (end === -1) throw new Error(`deploy.yml no longer contains ${JSON.stringify(to)}`);
  return haystack.slice(start, end);
}

/**
 * Full-line YAML/shell comments removed. Both files explain these guards in
 * prose that quotes the very expressions asserted below, so matching raw text
 * would let a deleted guard pass on the strength of the comment describing it.
 */
const code = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const preflightJob = sliceAt(workflow, "\n  preflight:\n", "\n  deploy:\n");
const deployJob = sliceAt(workflow, "\n  deploy:\n");
/** Each job's header — everything above `steps:`, where `if:`/`needs:` live. */
const preflightHeader = code(sliceAt(preflightJob, "\n  preflight:\n", "\n    steps:\n"));
const deployHeader = code(sliceAt(deployJob, "\n  deploy:\n", "\n    steps:\n"));
/** The presence check itself, as a shell script. */
const credentialsStep = code(sliceAt(preflightJob, "\n      - id: credentials\n"));
/** The deploy job's steps, comments removed. */
const steps = code(deployJob);
/** One step, from its `- name:` line to the next step. */
const step = (name: string): string => {
  const start = steps.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`deploy.yml has no step named ${JSON.stringify(name)}`);
  const next = steps.indexOf("\n      - ", start + 1);
  return next === -1 ? steps.slice(start) : steps.slice(start, next);
};

describe("deploy workflow: unconfigured skips green, half-configured fails red (DEPLOY-1)", () => {
  it("gates `deploy` on preflight's verdict, through `needs:`", () => {
    expect(deployHeader).toContain("needs: preflight");
    expect(deployHeader).toContain("needs.preflight.outputs.configured == 'true'");
    expect(preflightHeader).toContain("configured: ${{ steps.credentials.outputs.configured }}");
  });

  it("reads all four credentials, and only into the step's own `env:`", () => {
    for (const name of CREDENTIALS) {
      expect(credentialsStep, name).toContain(`${name}: \${{ secrets.${name} }}`);
      // Counted in the loop as well, or a renamed secret would read as absent
      // from `env:` and present in the verdict.
      expect(credentialsStep, `${name} is counted`).toMatch(
        new RegExp(`^\\s*for name in .*\\b${name}\\b`, "m"),
      );
    }
  });

  it("reports configured=true only when nothing is missing", () => {
    const allPresent = credentialsStep.indexOf('if [ "$missing_count" -eq 0 ]; then');
    const configuredTrue = credentialsStep.indexOf('echo "configured=true"');
    expect(allPresent).toBeGreaterThan(-1);
    expect(configuredTrue).toBeGreaterThan(allPresent);
    // Exactly one place writes the go-ahead.
    expect(credentialsStep.split('echo "configured=true"')).toHaveLength(2);
  });

  it("FAILS the run when only some credentials are set, before it can skip green", () => {
    // The regression this pins: `if [ -z "$missing" ]` treated "some present"
    // and "none present" alike, so deleting or mistyping one secret in an
    // adopted repo silently stopped deploying production inside a green run.
    const partial = credentialsStep.indexOf('if [ "$present_count" -gt 0 ]; then');
    const error = credentialsStep.indexOf("::error title=Production deploy misconfigured::");
    const exit = credentialsStep.indexOf("exit 1", partial);
    const configuredFalse = credentialsStep.indexOf('echo "configured=false"');
    expect(partial).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(partial);
    expect(exit).toBeGreaterThan(error);
    // The skip path is reachable only after the partial path has bailed out.
    expect(configuredFalse).toBeGreaterThan(exit);
  });

  it("still skips green, with a notice, when NO credential is set", () => {
    const configuredFalse = credentialsStep.indexOf('echo "configured=false"');
    const notice = credentialsStep.indexOf("::notice title=Production deploy skipped::");
    expect(configuredFalse).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(configuredFalse);
    // Nothing after the skip may fail the job — that is the whole point of it.
    expect(credentialsStep.slice(configuredFalse)).not.toContain("exit 1");
  });
});

describe("deploy workflow: the fork guard is restated where the credentials are (#10)", () => {
  it("both jobs carry every clause of the guard in their own `if:`", () => {
    for (const clause of FORK_GUARD) {
      expect(preflightHeader, `preflight: ${clause}`).toContain(clause);
      expect(deployHeader, `deploy: ${clause}`).toContain(clause);
    }
  });

  it("neither job's `if:` uses a status function that would defeat the skip", () => {
    // `always()` / `!cancelled()` / `failure()` override GitHub's implicit
    // `success()` over `needs:`, which is what makes a skipped `preflight`
    // skip `deploy`. Adding one to "make the job report instead of skipping"
    // is the ordinary edit that would un-gate the credentials.
    for (const [label, header] of [
      ["preflight", preflightHeader],
      ["deploy", deployHeader],
    ] as const) {
      expect(header, label).not.toMatch(/\b(always|cancelled|failure)\s*\(\s*\)/);
    }
  });

  it("deploy still checks out the triggering sha and holds the production credentials", () => {
    // The premise of the guard above. If a later edit moves the checkout or
    // the secrets elsewhere, the reasoning has to be re-examined rather than
    // inherited, so assert what makes this job the dangerous one.
    expect(deployJob).toContain("ref: ${{ github.event.workflow_run.head_sha || github.ref }}");
    expect(deployJob).toContain("run: pnpm install --frozen-lockfile");
    expect(deployJob).toContain("DATABASE_URL: ${{ secrets.PRODUCTION_DIRECT_DATABASE_URL }}");
    // Migrations first: the build is promoted only after they succeed.
    const migrate = deployJob.indexOf("run: pnpm db:app:migrate");
    const promote = deployJob.indexOf("run: vercel deploy --prebuilt --prod");
    expect(migrate).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(migrate);
  });
});

describe("deploy workflow: both migrators run before anything is built (F-26)", () => {
  it("applies the Better Auth migrations, then the app's, then builds", () => {
    // The step used to run only db:app:migrate, so a release that changed
    // better-auth-schema.sql (#199's `rateLimit`) went live with every auth
    // call answering 500 until someone migrated by hand.
    const auth = steps.indexOf("run: pnpm db:auth:migrate");
    const app = steps.indexOf("run: pnpm db:app:migrate");
    const build = steps.indexOf("run: vercel build --prod");
    expect(auth).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(auth);
    expect(build).toBeGreaterThan(app);
  });

  it("points the auth migrator at the same direct endpoint and schema, with no other production secret", () => {
    const authStep = step("Apply Better Auth migrations (production)");
    expect(authStep).toContain("run: pnpm db:auth:migrate");
    expect(authStep).toContain("DATABASE_URL: ${{ secrets.PRODUCTION_DIRECT_DATABASE_URL }}");
    expect(authStep).toContain("DB_SCHEMA: ${{ vars.DB_SCHEMA || 'auth' }}");
    // It loads @/lib/auth only for the schema-shaping options, so the values
    // the env schema demands are CI placeholders: the database URL is the
    // only secret this step may read, and the Vercel token never reaches it.
    expect(authStep.match(/\$\{\{\s*secrets\.\w+/g)).toEqual([
      "${{ secrets.PRODUCTION_DIRECT_DATABASE_URL",
    ]);
    expect(authStep).toMatch(/BETTER_AUTH_SECRET: ci-only-[a-z0-9-]+-not-for-production\n/);
  });
});

describe("deploy workflow: the Vercel CLI comes from vercel-cli's lockfile (I-09)", () => {
  const INSTALL = "Install Vercel CLI (from vercel-cli's lockfile)";
  /**
   * A global install however it is spelled: the flag before or after the
   * verb, yarn's `global` subcommand, npm's `--location=global`.
   */
  const GLOBAL_INSTALL = /\b(?:pnpm|npm|yarn)\b[^\n]*[\s=](?:-g|--global|global)\b/;

  it("recognises a global install in each spelling the guard below must refuse", () => {
    for (const line of [
      "run: pnpm add -g vercel@54.14.5",
      "run: pnpm -g add vercel",
      "run: npm i --global vercel",
      "run: npm install --location=global vercel",
      "run: yarn global add vercel",
    ]) {
      expect(line).toMatch(GLOBAL_INSTALL);
    }
  });

  it("resolves nothing afresh: no global add, no npx, no version pinned in the workflow", () => {
    // The regression this pins: `pnpm add -g vercel@54.14.5` ran five majors
    // behind drk-deploy, and a global add ignores vercel-cli's
    // pnpm.overrides, so the job holding VERCEL_TOKEN installed the exact
    // tar/undici/path-to-regexp versions those floors replace, unaudited.
    expect(steps).not.toMatch(GLOBAL_INSTALL);
    expect(steps).not.toMatch(/\b(?:npx|pnpx|dlx|bunx)\b[^\n]*\bvercel\b/);
    expect(steps).not.toMatch(/\bvercel@/);
    expect(step(INSTALL)).toMatch(/^\s*pnpm --dir vercel-cli install --frozen-lockfile --prod$/m);
  });

  it("puts that CLI on PATH before the first `vercel` step, which still runs from the repository root", () => {
    const install = steps.indexOf(`- name: ${INSTALL}\n`);
    expect(step(INSTALL)).toContain(
      'echo "$GITHUB_WORKSPACE/vercel-cli/node_modules/.bin" >> "$GITHUB_PATH"',
    );
    expect(steps.indexOf("run: vercel pull ")).toBeGreaterThan(install);
    // `vercel pull` writes .vercel/ where it runs and `vercel build` builds
    // what it finds there: run from vercel-cli/, they would build drk-deploy.
    expect(steps).not.toContain("working-directory:");
    expect(steps).not.toMatch(/--dir vercel-cli exec/);
  });

  it("never hands VERCEL_TOKEN to the install, which runs the CLI's dependency tree (#113)", () => {
    expect(deployHeader).not.toContain("secrets.VERCEL_TOKEN");
    expect(step(INSTALL)).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("names the settings no file can set where an operator looks, with how to check and set them", () => {
    // SHA pinning and the environment's branch policy are repository
    // settings, so the checklist in SECURITY.md is the whole control.
    const securityMd = readFileSync(path.join(process.cwd(), "SECURITY.md"), "utf8");
    const start = securityMd.indexOf("\n## Repository security settings\n");
    expect(start).toBeGreaterThan(-1);
    const end = securityMd.indexOf("\n## ", start + 1);
    const settings = securityMd.slice(start, end === -1 ? undefined : end);
    expect(settings).toContain("**Require actions to be pinned to a full-length commit SHA**");
    expect(settings).toContain("gh api repos/devresponse/devresponsekit/actions/permissions");
    expect(settings).toContain("-F sha_pinning_required=true");
    expect(settings).toContain("**`production` environment: deployment branches** | `main` only");
    expect(settings).toContain("environments/production/deployment-branch-policies");
    expect(settings).toContain("**`production` environment: required reviewers**");
  });
});
