import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The production image's build arguments and the CI run that boots it (F-108).
 *
 * `next build` inlines every NEXT_PUBLIC_* variable set while it runs, and the
 * browser can read one no other way. The Dockerfile declared no build
 * arguments, so browser Sentry (errors, Web Vitals, replay) could never be
 * enabled in the image, and docs/docker.md sent operators to a
 * SENTRY_AUTH_TOKEN build arg the Dockerfile ignored. Separately,
 * docker-scan.yml built and scanned the image but never started it, so a file
 * the standalone trace dropped would ship green. Neither file is executed by
 * the suite, so what makes each fix hold is pinned here, in the style of
 * `dependency-governance.test.ts`:
 *
 * - the builder declares a build argument for exactly the NEXT_PUBLIC_* values
 *   the browser Sentry init reads, before the build, and so none for the
 *   public values the server reads at run time;
 * - no ENV defines a NEXT_PUBLIC_* (an ENV copied from an unpassed ARG is "",
 *   which Next would inline), and the build unsets one passed empty;
 * - SENTRY_AUTH_TOKEN arrives as a BuildKit secret, never an ARG or ENV;
 * - the required `trivy` job migrates a Postgres service from the builder
 *   stage, boots the image it scanned, and probes it.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const dockerfile = read("Dockerfile");
const dockerMd = read("docs/docker.md");
const workflow = read(".github/workflows/docker-scan.yml");

/**
 * The Dockerfile's instructions, comments dropped and `\` continuations
 * joined, so a multi-line RUN or ENV is one string and a comment that quotes
 * an instruction never counts as one.
 */
function instructions(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const builder = instructions(dockerfile.slice(0, dockerfile.indexOf(" AS runner")));
const all = instructions(dockerfile);
const argNames = builder.filter((i) => i.startsWith("ARG ")).map((i) => i.split(/[\s=]/)[1]!);
const buildRuns = builder.filter((i) => i.startsWith("RUN ") && /\bpnpm build\b/.test(i));
const buildRun = buildRuns[0] ?? "";

/** The NEXT_PUBLIC_* variables the browser Sentry init reads. */
const browserVars = [
  ...new Set(
    [...read("src/instrumentation-client.ts").matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)].map(
      (m) => m[1]!,
    ),
  ),
].sort();

describe("production image: browser values are build arguments (F-108)", () => {
  it("builds once, in the builder stage", () => {
    expect(buildRuns).toHaveLength(1);
  });

  it("declares an ARG for every NEXT_PUBLIC_* the browser Sentry init reads, before the build", () => {
    expect(browserVars).toContain("NEXT_PUBLIC_SENTRY_DSN");
    const buildAt = builder.indexOf(buildRun);
    for (const name of browserVars) {
      const argAt = builder.indexOf(`ARG ${name}`);
      expect(argAt, `ARG ${name}`).toBeGreaterThan(-1);
      expect(argAt, `ARG ${name} precedes the build`).toBeLessThan(buildAt);
      expect(dockerMd, `docs/docker.md documents ${name}`).toContain(name);
    }
  });

  it("bakes no other NEXT_PUBLIC_* value: the server reads the rest at run time", () => {
    // NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_APP_NAME and NEXT_PUBLIC_PRODUCTION_HOST
    // are read by the server, and a value present at build is inlined into the
    // server bundle too, freezing it and tying the image to one environment.
    const baked = argNames.filter((name) => name.startsWith("NEXT_PUBLIC_"));
    expect(baked.sort()).toEqual(browserVars);
  });

  it("sets no NEXT_PUBLIC_* with ENV, and unsets one passed empty before `pnpm build`", () => {
    // `ENV X=$X` from an ARG nobody passed is "", and Next inlines "" over
    // the value the server would otherwise read at run time.
    for (const env of all.filter((i) => i.startsWith("ENV "))) {
      expect(env).not.toContain("NEXT_PUBLIC_");
    }
    // `--build-arg X=` (a script's unset variable) sets X to "": the loop
    // matches only the empty ones (`=$`) and must run before the build.
    const loop = buildRun.search(
      /for name in \$\(env \| sed -n '[^']*NEXT_PUBLIC_[^']*\)=\$\/\\1\/p'\)/,
    );
    expect(loop).toBeGreaterThan(-1);
    const unset = buildRun.indexOf('do unset "$name"; done');
    expect(unset).toBeGreaterThan(loop);
    expect(buildRun.indexOf("&& pnpm build")).toBeGreaterThan(unset);
  });

  it("takes SENTRY_AUTH_TOKEN only as a BuildKit secret, and the upload's org/project as ARGs", () => {
    for (const i of all.filter((x) => x.startsWith("ARG ") || x.startsWith("ENV "))) {
      expect(i).not.toContain("SENTRY_AUTH_TOKEN");
    }
    expect(buildRun).toContain(
      "RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN ",
    );
    expect(argNames).toEqual(expect.arrayContaining(["SENTRY_ORG", "SENTRY_PROJECT"]));
    // The doc told operators to pass the token "as a build arg", which the
    // Dockerfile never declared (and which the image history would record).
    expect(dockerMd).not.toMatch(/`SENTRY_AUTH_TOKEN` as a\s+build\s+arg/);
    expect(dockerMd).toContain("--secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN");
  });
});

/** Full-line YAML comments removed, so a comment quoting a step never passes for it. */
const code = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Slice between markers that must exist, so a rename fails loudly. */
function sliceAt(haystack: string, from: string, to?: string): string {
  const start = haystack.indexOf(from);
  if (start === -1) throw new Error(`docker-scan.yml no longer contains ${JSON.stringify(from)}`);
  if (to === undefined) return haystack.slice(start);
  const end = haystack.indexOf(to, start + from.length);
  if (end === -1) throw new Error(`docker-scan.yml no longer contains ${JSON.stringify(to)}`);
  return haystack.slice(start, end);
}

const triggers = code(sliceAt(workflow, "\non:\n", "\nconcurrency:\n"));
const job = code(sliceAt(workflow, "\n  trivy:\n"));
const header = sliceAt(job, "\n  trivy:\n", "\n    steps:\n");
const steps = job.slice(job.indexOf("\n    steps:\n")).split("\n      - ").slice(1);

/** The one step whose text satisfies `test`, by position. */
function stepIndex(label: string, test: (step: string) => boolean): number {
  const matches = steps.flatMap((step, i) => (test(step) ? [i] : []));
  expect(matches, label).toHaveLength(1);
  return matches[0]!;
}

describe("docker-scan.yml: the required `trivy` job boots the image it scanned (F-108)", () => {
  it("keeps the required-check name, its triggers and the Trivy gate on the scanned image", () => {
    // Branch protection requires the job NAME; the smoke run is in this job
    // so that it is part of that required check.
    expect(header).toContain("\n  trivy:\n    name: trivy\n");
    expect(header).not.toMatch(/^ {4}(if|needs):/m);
    expect(triggers).toMatch(/^ {2}pull_request:\n {4}branches: \[main\]$/m);
    expect(triggers).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    const gate = steps[stepIndex("the Trivy gate", (s) => s.includes('exit-code: "1"'))]!;
    expect(gate).toContain("image-ref: devresponsekit:scan");
  });

  it("builds the migrator from the scanned build's cache, with the same build arguments", () => {
    const build =
      steps[stepIndex("the build step", (s) => s.startsWith("name: Build production image"))]!;
    const commands = build.split("\n").filter((line) => line.trim().startsWith("docker build "));
    expect(commands).toHaveLength(2);
    const [scan, migrator] = commands.map((c) => c.trim());
    expect(scan).toMatch(/ -t devresponsekit:scan \.$/);
    expect(migrator).toMatch(/ --target builder -t devresponsekit:builder \.$/);
    const args = (c: string) => c.replace(/ --target builder/, "").replace(/ -t \S+ \.$/, "");
    expect(args(migrator!)).toBe(args(scan!));
    // A public value whose arrival in the browser bundle the smoke run checks.
    expect(scan).toContain('--build-arg NEXT_PUBLIC_SENTRY_RELEASE="$GITHUB_SHA"');
  });

  it("migrates (auth, then app) and seeds a Postgres service, then starts the scanned image", () => {
    expect(header).toMatch(/\n {4}services:\n {6}postgres:\n {8}image: pgvector\/pgvector:pg17\n/);
    expect(header).toContain(
      "DATABASE_URL: postgresql://devresponse:devresponse@localhost:5444/devresponse_db",
    );
    const gate = stepIndex("the Trivy gate", (s) => s.includes('exit-code: "1"'));
    const migrate = stepIndex("the migrate step", (s) => s.includes("devresponsekit:builder \\"));
    expect(steps[migrate]).toContain(
      'sh -c "pnpm db:auth:migrate && pnpm db:app:migrate && pnpm db:seed"',
    );
    expect(steps[migrate]).toContain("docker run --rm --network host");
    // The admin's password is minted per run and handed to the probe step;
    // the documented seed default is fenced to other files by .gitleaks.toml.
    expect(steps[migrate]).toContain("SEED_ADMIN_PASSWORD=$(openssl rand -hex 24)");
    expect(steps[migrate]).toContain(
      'echo "SEED_ADMIN_PASSWORD=$SEED_ADMIN_PASSWORD" >> "$GITHUB_ENV"',
    );
    expect(steps[migrate]).toMatch(/-e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD \\/);
    const start = stepIndex("the start step", (s) => s.includes("docker run -d --name smoke"));
    expect(steps[start]).toMatch(/\n\s+devresponsekit:scan\n/);
    expect(steps[start]).toContain(
      "until curl -fsS http://localhost:3000/api/health/ready > /dev/null",
    );
    expect(gate).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(start);
  });

  it("probes liveness, sign-in, a wrong password, an authenticated docs page and the bundle", () => {
    const start = stepIndex("the start step", (s) => s.includes("docker run -d --name smoke"));
    const probe = stepIndex("the probe step", (s) =>
      s.startsWith("name: Smoke-test the running image"),
    );
    expect(probe).toBeGreaterThan(start);
    const body = steps[probe]!;
    expect(body).toContain('curl -fsS -o /dev/null "$base/api/health"');
    expect(body).toContain('curl -fsS -o /dev/null "$base/en/sign-in"');
    expect(body).toMatch(
      /password\\":\\"not-the-password\\"[^\n]*\n[^\n]*"\$base\/api\/auth\/sign-in\/email"/,
    );
    expect(body).toContain('if [ "$status" != 401 ]; then');
    expect(body).toContain('-c "$RUNNER_TEMP/cookies"');
    expect(body).toContain('-b "$RUNNER_TEMP/cookies" "$base/en/app/docs/docker"');
    expect(body).toContain(`grep -q 'data-language="bash"' "$RUNNER_TEMP/doc.html"`);
    expect(body).toContain('docker exec smoke grep -rqF "$GITHUB_SHA" /app/.next/static');
    // The docs probe needs its document to keep a bash block to highlight.
    expect(dockerMd).toMatch(/^```bash$/m);
  });

  it("prints the container log on failure, and uses no repository secret", () => {
    const log = steps[stepIndex("the log step", (s) => s.includes("docker logs smoke"))]!;
    expect(log).toContain("if: failure()");
    expect(workflow).not.toMatch(/\bsecrets\./);
  });
});
