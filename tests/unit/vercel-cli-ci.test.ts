import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The deploy CLI's CI job (F-45, review #123 / #164 / #189).
 *
 * `vercel-cli/` (drk-deploy) is the only tool that applies production
 * migrations BEFORE it promotes a build. It is its own pnpm package with its
 * own toolchain, which the kit's typecheck, lint and format skip, and until
 * F-45 no workflow built or tested it: a Dependabot bump that broke it, or a
 * refactor that promoted before migrating, merged green. ci.yml now runs its
 * checks in a job of its own. A workflow file is never executed by the test
 * suite, so what makes that job a gate is pinned here, in the style of
 * `dependency-governance.test.ts` and `deploy-workflow-guards.test.ts`:
 *
 * - the job `name` branch protection requires, named in the docs that tell
 *   the operator to require it;
 * - triggers with no path filter, and no `if:` or `needs:` that could skip
 *   it. A required check skipped by a workflow path filter never reports and
 *   blocks every merge; a job skipped by `if:` or a failed `needs:` reports
 *   "skipped", which branch protection accepts as passing;
 * - install, typecheck, test (which builds) and format check, in that order.
 *
 * The CLI's lockfile audit is deliberately NOT here: the required
 * `Dependency audit` job runs it (F-28, pinned by dependency-governance).
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const ci = read(".github/workflows/ci.yml");

/** The required-check context: the job's `name`. */
const CHECK_NAME = "Deploy CLI (drk-deploy)";

/** What the job must run, in this order. */
const COMMANDS = [
  "pnpm --dir vercel-cli install --frozen-lockfile",
  "pnpm --dir vercel-cli typecheck",
  "pnpm --dir vercel-cli test",
  "pnpm --dir vercel-cli format:check",
];

/**
 * Full-line YAML comments removed. The job's comments quote the very things
 * asserted below (`paths:`, `if:`), so matching raw text would let a deleted
 * guard pass on the strength of the comment describing it.
 */
const code = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Slice between markers that must exist, so a rename fails loudly. */
function sliceAt(haystack: string, from: string, to: string): string {
  const start = haystack.indexOf(from);
  if (start === -1) throw new Error(`ci.yml no longer contains ${JSON.stringify(from)}`);
  const end = haystack.indexOf(to, start + from.length);
  if (end === -1) throw new Error(`ci.yml no longer contains ${JSON.stringify(to)}`);
  return haystack.slice(start, end);
}

/** One job's text: from its key to the next job key (or the end of the file). */
function jobBlock(workflow: string, id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`ci.yml has no \`${id}\` job`);
  const next = /\n {2}[\w-]+:\n/g;
  next.lastIndex = start + 1;
  const end = next.exec(workflow)?.index ?? workflow.length;
  return workflow.slice(start, end);
}

const triggers = code(sliceAt(ci, "\non:\n", "\npermissions:\n"));
const job = code(jobBlock(ci, "vercel-cli"));
const header = sliceAt(job, "\n  vercel-cli:\n", "\n    steps:\n");
const steps = job.slice(job.indexOf("\n    steps:\n")).split("\n      - ").slice(1);

describe("vercel-cli CI job: a gate that can be required (F-45)", () => {
  it(`is named \`${CHECK_NAME}\`, the context branch protection requires`, () => {
    expect(header).toContain(`\n    name: ${CHECK_NAME}\n`);
    expect(ci.split(`name: ${CHECK_NAME}\n`), "exactly one job carries the name").toHaveLength(2);
  });

  it("runs on every pull request and every push to main, with no path filter", () => {
    expect(triggers).toMatch(/^ {2}pull_request:\s*$/m);
    expect(triggers).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    // A `paths:` / `paths-ignore:` on either trigger would leave the required
    // check pending forever on every PR that does not touch vercel-cli/.
    expect(triggers).not.toMatch(/paths/);
  });

  it("cannot be skipped: no `if:`, no `needs:`, no `continue-on-error`", () => {
    expect(job).not.toMatch(/^\s*if:/m);
    expect(job).not.toMatch(/^\s*needs:/m);
    expect(job).not.toMatch(/continue-on-error/);
  });

  it("installs from the frozen lockfile, then typechecks, tests and format-checks, in that order", () => {
    const runs = steps.flatMap((step) => {
      const command = /^\s*run: (.+)$/m.exec(step)?.[1];
      return command === undefined ? [] : [command.trim()];
    });
    expect(runs).toEqual(COMMANDS);
  });

  it("the package's scripts are the checks the job believes it runs", () => {
    const { scripts } = JSON.parse(read("vercel-cli/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(scripts.typecheck).toMatch(/^tsc -p tsconfig\.json --noEmit$/);
    // The suite imports ../dist, so `test` must build first: without the build
    // it would run against a stale dist locally, and fail to import in CI.
    expect(scripts.test).toMatch(/^pnpm build && node --test .*test\/\*\.test\.ts$/);
    expect(scripts.build).toMatch(/^tsc -p tsconfig\.json$/);
    expect(scripts["format:check"]).toMatch(
      /^prettier --check .*"src\/\*\*\/\*\.ts" "test\/\*\*\/\*\.ts"/,
    );
  });

  it("pins every action by commit SHA with a version comment, on the CLI's own lockfile cache", () => {
    const uses = [...job.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.map(([, ref]) => ref!.split("@")[0])).toEqual([
      "actions/checkout",
      "pnpm/action-setup",
      "actions/setup-node",
    ]);
    for (const [line, ref, rest] of uses) {
      expect(ref, line).toMatch(/@[0-9a-f]{40}$/);
      expect(rest, line).toMatch(/# v\d+\.\d+\.\d+$/);
    }
    expect(job).toContain("cache-dependency-path: vercel-cli/pnpm-lock.yaml");
  });

  it("the docs tell the operator the exact check name to require", () => {
    for (const doc of ["docs/testing.md", "vercel-cli/README.md"]) {
      expect(read(doc), doc).toContain(`\`${CHECK_NAME}\``);
    }
    expect(read("docs/testing.md")).toContain(
      `| [\`ci.yml\`](../.github/workflows/ci.yml) | \`${CHECK_NAME}\` |`,
    );
  });
});
