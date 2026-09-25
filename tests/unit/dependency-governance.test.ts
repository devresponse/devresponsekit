import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dependency-governance guards (review #8, #9, #26, #114).
 *
 * The two required supply-chain gates (`pnpm audit --audit-level high` and
 * the Trivy image scan) went red on `main` because override floors rotted
 * below the patched lines and the runtime image carried npm's vendored
 * dependency tree. These tests pin the repair so it cannot silently regress:
 *
 * - every `pnpm.overrides` entry and every `ignoreGhsas` mute is documented
 *   in SECURITY.md (an undocumented override is how `jsdom>undici` drifted);
 * - the lockfile resolves each package the sweep fixed at or above the
 *   patched version (deterministic, unlike the advisory DB behind `pnpm
 *   audit`);
 * - the Dockerfile keeps both stages on ONE digest-pinned base image, deletes
 *   the package-manager CLIs from the runner, and stays non-root with its
 *   health check intact;
 * - `.trivyignore` carries no npm-CLI mutes (they are moot once npm is gone)
 *   and Dependabot tracks the base-image digest.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Slice between markers that must exist. A missing marker throws rather than
 * silently slicing from -1, which would hand every assertion a haystack that
 * happens to contain what it looks for (as in deploy-workflow-guards.test.ts).
 * `to` is searched for AFTER `from`, so the two may share a prefix (`\n## `).
 */
function sliceAt(haystack: string, from: string, to?: string): string {
  const start = haystack.indexOf(from);
  if (start === -1) throw new Error(`marker not found: ${JSON.stringify(from)}`);
  if (to === undefined) return haystack.slice(start);
  const end = haystack.indexOf(to, start + from.length);
  if (end === -1) throw new Error(`marker not found: ${JSON.stringify(to)}`);
  return haystack.slice(start, end);
}

/**
 * Full-line YAML comments removed. The workflows explain their guards in
 * prose that quotes the very commands asserted below, so matching raw text
 * would let a deleted step pass on the strength of the comment describing it.
 */
const code = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const pkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  pnpm: { overrides: Record<string, string>; auditConfig: { ignoreGhsas: string[] } };
};
const securityMd = read("SECURITY.md");
const lockfile = read("pnpm-lock.yaml");
const dockerfile = read("Dockerfile");

/** Numeric `major.minor.patch` comparison (pre-release tags ignored). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Repo-relative directories holding a lockfile ("" = the root), sorted. Found
 * by walking the repository rather than listed, so a new package with its own
 * lockfile is held to every rule below without anyone editing this file.
 */
function lockfileDirs(): { pnpm: string[]; other: string[] } {
  const pnpm: string[] = [];
  const other: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir))) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const rel = dir === "" ? entry : `${dir}/${entry}`;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (entry === "pnpm-lock.yaml") pnpm.push(dir);
      else if (entry === "package-lock.json" || entry === "yarn.lock") other.push(rel);
    }
  };
  walk("");
  return { pnpm: pnpm.sort(), other };
}
const lockfiles = lockfileDirs();

/** The advisories a lockfile's own package.json mutes. Each lockfile has its own. */
function mutedGhsas(dir: string): string[] {
  const manifest = JSON.parse(read(dir === "" ? "package.json" : `${dir}/package.json`)) as {
    pnpm?: { auditConfig?: { ignoreGhsas?: string[] } };
  };
  return manifest.pnpm?.auditConfig?.ignoreGhsas ?? [];
}

/** Every `<name>@<version>` resolved in the lockfile's `packages:` section. */
function resolvedVersions(name: string): string[] {
  const packagesSection = lockfile.slice(
    lockfile.indexOf("\npackages:\n"),
    lockfile.indexOf("\nsnapshots:\n"),
  );
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`^  ${escaped}@(\\d+\\.\\d+\\.\\d+[^:(]*)`, "gm");
  return [...packagesSection.matchAll(re)].map((m) => m[1]!);
}

describe("dependency governance: overrides and mutes are documented", () => {
  it("every pnpm override has a row in the SECURITY.md override-floors table", () => {
    const undocumented = Object.keys(pkg.pnpm.overrides).filter(
      (key) => !securityMd.includes(`| \`${key}\` |`),
    );
    expect(undocumented).toEqual([]);
  });

  it("every SECURITY.md override row matches the floor declared in package.json", () => {
    for (const [key, floor] of Object.entries(pkg.pnpm.overrides)) {
      expect(securityMd, `override ${key}`).toContain(`| \`${key}\` | \`${floor}\` |`);
    }
  });

  it("every muted GHSA, in every lockfile's allowlist, has a row naming that lockfile and a review-by date", () => {
    // `pnpm --dir vercel-cli audit` reads vercel-cli/package.json's
    // ignoreGhsas and never the root's, so a mute there is just as real — and
    // walking only the root manifest let it skip the row and the review date.
    const rows = sliceAt(securityMd, "\n## Dependency advisory allowlist\n", "\n### ").split("\n");
    for (const dir of lockfiles.pnpm) {
      const lock = `\`${dir === "" ? "" : `${dir}/`}pnpm-lock.yaml\``;
      for (const ghsa of mutedGhsas(dir)) {
        const row = rows.find((line) => line.startsWith(`| \`${ghsa}\` | ${lock} |`));
        expect(row, `allowlist row for ${ghsa} in ${lock}`).toBeDefined();
        expect(row).toMatch(/\| \d{4}-\d{2}-\d{2} \|\s*$/);
      }
    }
  });

  it("SECURITY.md and the package's README say where each lockfile's allowlist lives", () => {
    const allowlist = sliceAt(securityMd, "\n## Dependency advisory allowlist\n", "\n### ");
    expect(allowlist).toContain("| GHSA | Lockfile |");
    for (const dir of lockfiles.pnpm.filter((d) => d !== "")) {
      expect(allowlist, dir).toContain(
        `\`${dir}/package.json\` → \`pnpm.auditConfig.ignoreGhsas\``,
      );
      expect(read(`${dir}/README.md`), dir).toContain("`pnpm.auditConfig.ignoreGhsas`");
    }
  });

  it("the lockfile carries exactly the overrides declared in package.json", () => {
    const block = lockfile.slice(
      lockfile.indexOf("\noverrides:\n") + 1,
      lockfile.indexOf("\nimporters:\n"),
    );
    const inLock = Object.fromEntries(
      block
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith("  "))
        .map((line) => {
          const [k, v] = line.trim().split(": ");
          return [k!.replace(/^'|'$/g, ""), v!];
        }),
    );
    expect(inLock).toEqual(pkg.pnpm.overrides);
  });
});

describe("dependency governance: lockfile floors from the 2026-09 sweep", () => {
  // [package, major line (undefined = every line), minimum patched version]
  const floors: Array<[name: string, major: number | undefined, min: string]> = [
    ["next", undefined, "16.2.11"], // GHSA-6gpp-xcg3-4w24, -m99w-x7hq-7vfj, -89xv-2m56-2m9x, -p9j2-gv94-2wf4
    ["eslint-config-next", undefined, "16.2.11"],
    ["sharp", undefined, "0.35.0"], // GHSA-f88m-g3jw-g9cj
    // undici 7.x left the tree when jsdom 30 (undici ^8.9.0) replaced jsdom 29;
    // the `jsdom>undici` override now floors the 8.x line instead.
    ["undici", 8, "8.9.0"], // GHSA-4cwx-7wf7-3272
    ["postcss", undefined, "8.5.23"], // GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp
    ["nanoid", 3, "3.3.18"], // GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8
    ["fast-uri", undefined, "3.1.6"],
    ["browserslist", undefined, "4.28.7"], // GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g
    ["brace-expansion", 1, "1.1.18"], // GHSA-rgw5-rvv9-x895 et al.
    ["brace-expansion", 5, "5.0.9"],
    ["js-yaml", 3, "3.15.2"], // GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-h67p-54hq-rp68
    ["js-yaml", 4, "4.3.1"],
    ["dompurify", undefined, "3.4.13"], // GHSA-55q2-fjhq-7xh7
    ["qs", undefined, "6.16.0"], // GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g
  ];

  it.each(floors)("%s (major %s) resolves at or above %s", (name, major, min) => {
    const versions = resolvedVersions(name).filter(
      (v) => major === undefined || Number(v.split(".")[0]) === major,
    );
    expect(versions.length, `${name} is present in the lockfile`).toBeGreaterThan(0);
    for (const v of versions) {
      expect(compareVersions(v, min), `${name}@${v} >= ${min}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("no unpatched js-yaml line remains anywhere in the tree", () => {
    // Both majors are floored; anything else (e.g. a 2.x) would be unreviewed.
    for (const v of resolvedVersions("js-yaml")) {
      expect([3, 4]).toContain(Number(v.split(".")[0]));
    }
  });

  it("the direct next / eslint-config-next pins agree", () => {
    expect(pkg.devDependencies["eslint-config-next"]).toBe(pkg.dependencies["next"]);
  });

  it("Dependabot proposes next and eslint-config-next in ONE group, so the pin above can hold", () => {
    // Otherwise the prod and dev groups split every Next bump into two PRs
    // that each fail the pin above (#478 + #479). Groups are assigned
    // first-match-wins, so the pair's group must precede both of them, and it
    // must carry no dependency-type (next is prod, eslint-config-next is dev).
    const dependabot = read(".github/dependabot.yml");
    const start = dependabot.indexOf("- package-ecosystem: npm\n    directory: /\n");
    expect(start, "dependabot.yml has the root npm entry").toBeGreaterThan(-1);
    const end = dependabot.indexOf("\n  - package-ecosystem:", start);
    const rootNpm = dependabot.slice(start, end === -1 ? undefined : end);
    const groups = rootNpm.slice(rootNpm.indexOf("\n    groups:\n"));
    const names = [...groups.matchAll(/^ {6}([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(names[0], "the next group is listed first").toBe("next");
    expect(names).toEqual(expect.arrayContaining(["dev-minor-patch", "prod-minor-patch"]));
    const nextGroup = groups.slice(
      groups.indexOf("\n      next:\n"),
      groups.indexOf("\n      dev-minor-patch:\n"),
    );
    expect(nextGroup).toContain('patterns: ["next", "eslint-config-next"]');
    expect(nextGroup).toContain('update-types: ["major", "minor", "patch"]');
    expect(nextGroup).toContain("applies-to: version-updates");
    expect(nextGroup).not.toContain("dependency-type");
  });
});

/**
 * The Node major every runtime must agree on. `.nvmrc` is the source of
 * truth; CI, the Docker image and `engines.node` (which is what Vercel reads
 * to pick production's runtime) are asserted against it. `engines.node` must
 * name the EXACT major (`24.x`): an open range such as `>=24` lets Vercel move
 * production to the next major the day it offers one, while CI and the image
 * stay behind (F-25). #397 shipped a bug
 * that fails only inside the Next runtime on Node >= 24 while CI ran 22 —
 * every check stayed green and production auth went down (#400/#401).
 */
const nodeMajor = read(".nvmrc").trim();

describe("dependency governance: Node runtime major", () => {
  it(".nvmrc pins a bare major", () => {
    expect(nodeMajor).toMatch(/^\d+$/);
  });

  it("every workflow's node-version equals .nvmrc", () => {
    for (const wf of ["ci.yml", "deploy.yml", "mutation.yml", "dependency-audit.yml"]) {
      const versions = [...read(`.github/workflows/${wf}`).matchAll(/node-version:\s*(\S+)/g)].map(
        (m) => m[1],
      );
      expect(versions.length, wf).toBeGreaterThan(0);
      expect(new Set(versions), wf).toEqual(new Set([nodeMajor]));
    }
  });

  it("engines.node pins the same major exactly (Vercel runs production on what this names)", () => {
    const engines = (JSON.parse(read("package.json")) as { engines?: { node?: string } }).engines;
    expect(engines?.node).toBe(`${nodeMajor}.x`);
  });
});

describe("dependency governance: production image", () => {
  const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));

  it(`both stages build from the same digest-pinned node:${nodeMajor}-bookworm-slim image`, () => {
    expect(fromLines).toHaveLength(2);
    const re = new RegExp(
      `^FROM node:${nodeMajor}-bookworm-slim@(sha256:[0-9a-f]{64}) AS (builder|runner)$`,
    );
    const digests = fromLines.map((line) => {
      const m = line.match(re);
      expect(m, line).not.toBeNull();
      return m![1];
    });
    expect(new Set(digests).size).toBe(1);
  });

  it("the runner stage deletes the bundled npm/npx/corepack CLIs before dropping privileges", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    const rm = runner.indexOf("RUN rm -rf /usr/local/lib/node_modules/npm");
    const user = runner.indexOf("\nUSER nextjs");
    expect(rm).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(rm);
    for (const p of [
      "/usr/local/lib/node_modules/npm",
      "/usr/local/lib/node_modules/corepack",
      "/usr/local/bin/npm",
      "/usr/local/bin/npx",
      "/usr/local/bin/corepack",
    ]) {
      expect(runner.slice(rm, user), p).toContain(p);
    }
  });

  it("keeps the non-root user, health check, and standalone entrypoint", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toContain("\nUSER nextjs\n");
    expect(runner).toMatch(/\nHEALTHCHECK [^\n]*\n\s+CMD node -e "fetch\('http:\/\/127\.0\.0\.1:'/);
    expect(runner.trimEnd().endsWith('CMD ["node", "server.js"]')).toBe(true);
    // The builder stage still needs corepack (pnpm); only the runner strips it.
    const builder = dockerfile.slice(0, dockerfile.indexOf("AS runner"));
    expect(builder).toContain("RUN corepack enable");
    expect(builder).not.toContain("rm -rf /usr/local/lib/node_modules/npm");
  });

  it(".trivyignore has no npm-CLI mutes and every entry carries a review-by date", () => {
    const lines = read(".trivyignore").split("\n");
    const cves = lines.filter((line) => /^CVE-\d{4}-\d+/.test(line));
    // The two npm-CLI mutes are moot now that npm is not in the image.
    expect(cves).not.toContain("CVE-2026-33671");
    expect(cves).not.toContain("CVE-2026-48815");
    for (const cve of cves) {
      const idx = lines.indexOf(cve);
      const preamble = lines.slice(Math.max(0, idx - 12), idx).join("\n");
      expect(preamble, `rationale for ${cve}`).toMatch(/Review by \d{4}-\d{2}-\d{2}/);
    }
    // Anything that is not a CVE id must be a comment or blank.
    for (const line of lines) {
      expect(line === "" || line.startsWith("#") || /^CVE-\d{4}-\d+$/.test(line), line).toBe(true);
    }
  });

  it("Dependabot tracks the base-image digest via the docker ecosystem", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toMatch(/- package-ecosystem: docker\n\s+directory: \/\n/);
  });
});

/**
 * Install-time supply chain (review #226).
 *
 * A hijacked publish is usually caught within hours, so refusing to RESOLVE
 * anything younger than a day closes most of the window; pinning pnpm itself
 * by hash means Corepack rejects a tampered package manager before it runs.
 * Neither control may drift silently, and both are documented in SECURITY.md.
 */
describe("dependency governance: install-time supply chain", () => {
  const npmrc = read(".npmrc");
  const dependabot = read(".github/dependabot.yml");
  const packageManager = (JSON.parse(read("package.json")) as { packageManager: string })
    .packageManager;

  it(".npmrc sets a release cooldown of at least 24 hours", () => {
    const match = /^minimum-release-age=(\d+)$/m.exec(npmrc);
    expect(match, ".npmrc must set minimum-release-age (minutes)").not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1440);
  });

  it("Dependabot npm updates carry a cooldown so proposals survive that floor", () => {
    const npmBlock = dependabot.slice(dependabot.indexOf("- package-ecosystem: npm"));
    expect(npmBlock).toMatch(/\n\s+cooldown:\n\s+default-days: [1-9]\d*\n/);
  });

  it("packageManager pins pnpm WITH its sha512 integrity hash", () => {
    // `corepack use pnpm@<version>` writes exactly this shape; Corepack
    // verifies the downloaded tarball against the hash before executing it.
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });

  it("the pinned pnpm version still matches engines and the onboarding doc", () => {
    const version = packageManager.slice("pnpm@".length).split("+")[0]!;
    expect(read("docs/developer-onboarding.md")).toContain(`| **pnpm** | ${version} |`);
    expect(version.split(".")[0]).toBe("10"); // package.json engines: pnpm >=10
  });

  it("SECURITY.md documents both controls", () => {
    expect(securityMd).toContain("## Install-time supply chain");
    expect(securityMd).toContain("minimum-release-age=1440");
    expect(securityMd).toContain("cooldown.default-days");
    expect(securityMd).toContain("+sha512.<hash>");
  });
});

/**
 * The dependency audit is its own workflow (review #227). Inside ci.yml it
 * only ran when a commit landed, so an idle `main` was never re-audited and
 * went red silently (last main run 2026-07-13; 28 high advisories found weeks
 * later). These pin the split: the job name branch protection requires, the
 * pull_request trigger that makes it report, the weekly cron, the unchanged
 * gate command, SHA-pinned actions, and a notify job that can only touch
 * issues and only after a scheduled failure.
 */
describe("dependency governance: the audit workflow runs on a schedule", () => {
  const audit = read(".github/workflows/dependency-audit.yml");
  const ci = read(".github/workflows/ci.yml");
  const triggers = audit.slice(audit.indexOf("\non:\n"), audit.indexOf("\nconcurrency:\n"));
  // The audit job ends where the Dependabot alerts job (F-28) begins; slicing
  // to `notify:` would hand the audit-job assertions the alerts job's text.
  const auditJob = sliceAt(audit, "\njobs:\n", "\n  dependabot-alerts:\n");
  const notifyJob = sliceAt(audit, "\n  notify:\n");

  it("keeps the required-check context `Dependency audit` and moves it out of ci.yml", () => {
    // Branch protection requires the job NAME; the check stops reporting if
    // either the name or the pull_request trigger goes.
    expect(auditJob).toContain("\n  audit:\n    name: Dependency audit\n");
    expect(ci).not.toContain("name: Dependency audit");
    expect(ci).not.toContain("pnpm audit");
  });

  it("runs on pull_request, push to main, a weekly cron, and manual dispatch", () => {
    expect(triggers).toMatch(/^  pull_request:\s*$/m);
    expect(triggers).toMatch(/^  push:\n    branches: \[main\]$/m);
    expect(triggers).toMatch(/^  workflow_dispatch:\s*$/m);
    const cron = triggers.match(/- cron: "([^"]+)"/)?.[1];
    expect(cron, "a schedule trigger").toBeDefined();
    // Weekly: day-of-week fixed, day-of-month/month wildcards.
    const [minute, hour, dom, month, dow] = cron!.split(" ");
    expect(dom).toBe("*");
    expect(month).toBe("*");
    expect(dow).toMatch(/^[0-6]$/);
    // The three weekly security workflows must not share a runner window.
    // Read the sibling crons from their files rather than hard-coding their
    // current values: a literal "4:27" here stayed green while codeql.yml
    // itself drifted onto the audit's slot (must-fix review of #227).
    const slot = (file: string) => {
      const expr = read(file).match(/- cron: "([^"]+)"/)?.[1];
      expect(expr, `${file} has a cron`).toBeDefined();
      const [m, h] = expr!.split(" ");
      return `${h}:${m}`;
    };
    const slots = [
      ["dependency-audit.yml", `${hour}:${minute}`],
      ["codeql.yml", slot(".github/workflows/codeql.yml")],
      ["docker-scan.yml", slot(".github/workflows/docker-scan.yml")],
    ] as const;
    for (const [a, aSlot] of slots) {
      for (const [b, bSlot] of slots) {
        if (a === b) continue;
        expect(aSlot, `${a} and ${b} share the ${aSlot} cron slot`).not.toBe(bSlot);
      }
    }
  });

  it("gates with the same command and allowlist as before the split", () => {
    expect(auditJob).toContain("run: pnpm audit --audit-level high");
    expect(auditJob).toContain("run: pnpm install --frozen-lockfile");
    expect(auditJob).toContain("pnpm.auditConfig.ignoreGhsas");
  });

  it("pins every action by commit SHA with a version comment", () => {
    const uses = [...audit.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const [line, ref, rest] of uses) {
      expect(ref, line).toMatch(/@[0-9a-f]{40}$/);
      expect(rest, line).toMatch(/# v\d+\.\d+\.\d+$/);
    }
  });

  it("notifies only on a failed SCHEDULED run, with issues: write scoped to that job", () => {
    // The WHOLE workflow-level permissions block must be `contents: read`.
    // Anchoring only its first two lines let an `issues: write` appended
    // there slip through — granted to the audit job that runs `pnpm install`
    // of the entire tree, exactly what least-privilege #113 fences — because
    // `auditJob` is sliced from `jobs:` and never sees the top-level block
    // (must-fix review of #227).
    const workflowPermissions = audit.slice(
      audit.indexOf("\npermissions:\n"),
      audit.indexOf("\njobs:\n"),
    );
    expect(workflowPermissions).toBe("\npermissions:\n  contents: read\n");
    expect(notifyJob).toContain("needs: [audit, dependabot-alerts]");
    expect(notifyJob).toContain("if: failure() && github.event_name == 'schedule'");
    expect(notifyJob).toMatch(/permissions:\n      issues: write\n    steps:/);
    expect(auditJob).not.toContain("issues: write");
    // The issue title is the dedupe key — documented in SECURITY.md and
    // docs/testing.md, so a rename here must update both.
    expect(notifyJob).toContain('const title = "Dependency audit failing on main";');
    expect(read("SECURITY.md")).toContain('"Dependency audit failing on main"');
    expect(read("docs/testing.md")).toContain('"Dependency audit failing on main"');
    expect(notifyJob).toContain("github.rest.issues.createComment");
    expect(notifyJob).toContain("github.rest.issues.create(");
  });
});

/**
 * Every lockfile is audited, and the docs stop promising what a repository
 * setting decides (F-28).
 *
 * The deploy CLI in `vercel-cli/` is its own pnpm package with its own
 * lockfile, so the root `pnpm audit` never saw it — although it handles
 * `VERCEL_TOKEN` and the production direct database URL. Its advisories
 * surfaced only as Dependabot alerts in the Security tab, which nothing turned
 * into a red run. Meanwhile dependabot.yml and SECURITY.md said security
 * advisories "arrive immediately" as PRs, which is true only while the
 * repository's "Dependabot security updates" setting is on — and it was off.
 *
 * The lockfiles are FOUND by walking the repository rather than listed here,
 * so a third package with its own lockfile fails this suite until the audit
 * job, the notify job and dependabot.yml are wired for it too. The notify
 * job's script is EXECUTED against fakes, so "wired" means the tracking issue
 * names the lockfile when its audit fails and when a setup fault skips it,
 * not merely that an env var exists. The alerts job
 * is pinned as read-only and kept off the pull_request path; the setting
 * itself cannot be read by `GITHUB_TOKEN` (the endpoint needs administration
 * access), so SECURITY.md carries it as an operator check instead.
 */
describe("dependency governance: every lockfile is audited (F-28)", () => {
  const workflow = read(".github/workflows/dependency-audit.yml");
  const dependabot = read(".github/dependabot.yml");
  const auditJob = code(sliceAt(workflow, "\n  audit:\n", "\n  dependabot-alerts:\n"));
  const alertsJob = code(sliceAt(workflow, "\n  dependabot-alerts:\n", "\n  notify:\n"));
  const notifyJob = code(sliceAt(workflow, "\n  notify:\n"));
  const auditSteps = auditJob.split("\n      - ").slice(1);

  /** The one audit-job step whose `run:` is exactly `command`. */
  function stepRunning(command: string): string {
    const matches = auditSteps.filter((step) => step.includes(`\n        run: ${command}\n`));
    expect(matches, `exactly one audit step runs \`${command}\``).toHaveLength(1);
    return matches[0]!;
  }

  const auditCommand = (dir: string) =>
    dir === "" ? "pnpm audit --audit-level high" : `pnpm --dir ${dir} audit --audit-level high`;

  it("finds the app's and the deploy CLI's lockfiles, and no non-pnpm lockfile", () => {
    // A package-lock.json or yarn.lock would be a tree `pnpm audit` cannot read.
    expect(lockfiles.other).toEqual([]);
    expect(lockfiles.pnpm).toEqual(expect.arrayContaining(["", "vercel-cli"]));
  });

  it("the required audit job audits every lockfile at the high threshold", () => {
    for (const dir of lockfiles.pnpm) stepRunning(auditCommand(dir));
  });

  /** The `id:` of the one audit-job step that uses `action`. */
  function idOfStepUsing(action: string): string {
    const steps = auditSteps.filter((step) => step.startsWith(`uses: ${action}@`));
    expect(steps, `exactly one audit step uses ${action}`).toHaveLength(1);
    const id = /^\s*id: (\w+)$/m.exec(steps[0]!)?.[1];
    expect(id, `the ${action} step has an id`).toBeDefined();
    return id!;
  }

  /** The audit-job output that carries `dir`'s audit step outcome. */
  function outputFor(dir: string): string {
    const step = stepRunning(auditCommand(dir));
    const id = /^\s*id: (\w+)$/m.exec(step)?.[1];
    expect(id, `the \`${auditCommand(dir)}\` step has an id`).toBeDefined();
    const output = auditJob
      .split("\n")
      .find((line) => line.endsWith(`: \${{ steps.${id}.outcome }}`))
      ?.trim()
      .split(":")[0];
    expect(output, `a job output carries steps.${id}.outcome`).toBeDefined();
    return output!;
  }

  it("each extra lockfile's audit runs after an earlier install or audit failed, but only with a checkout and pnpm", () => {
    // Without `!cancelled()` a red app audit would skip the CLI's, and a run
    // would report one tree while hiding the other. With `!cancelled()` ALONE
    // it also ran after a failed checkout or pnpm setup, failed on a missing
    // directory or "pnpm: command not found", and the tracking issue blamed
    // this lockfile for a setup fault. It must NOT wait on the install: the
    // audit reads only the lockfile.
    const guard =
      `\${{ !cancelled() && steps.${idOfStepUsing("actions/checkout")}.outcome == 'success'` +
      ` && steps.${idOfStepUsing("pnpm/action-setup")}.outcome == 'success' }}`;
    for (const dir of lockfiles.pnpm.filter((d) => d !== "")) {
      expect(stepRunning(auditCommand(dir)), dir).toContain(`\n        if: ${guard}\n`);
    }
  });

  it("every audit step's outcome is exported, and the notify job names each one", () => {
    for (const dir of lockfiles.pnpm) {
      expect(notifyJob).toContain(`\${{ needs.audit.outputs.${outputFor(dir)} }}`);
    }
    expect(notifyJob).toContain("${{ needs.dependabot-alerts.result }}");
  });

  it("a push to main cannot cancel the scheduled run, whose alerts check runs on the schedule alone", () => {
    // One group per ref let a push landing during the Monday run cancel it,
    // and with it that week's `Dependabot alerts` job and tracking issue.
    const group = /^concurrency:\n {2}group: (.+)$/m.exec(code(workflow))?.[1];
    expect(group, "a workflow-level concurrency group").toBeDefined();
    expect(group).toContain("${{ github.ref }}");
    expect(group).toContain("${{ github.event_name }}");
  });

  /**
   * The notify job's github-script, EXECUTED against fakes. Checking only that
   * the env mapping exists let the message code drift from it (a lockfile
   * wired into `env:` but never named, or a skipped audit read as a pass).
   */
  describe("the tracking issue names what failed", () => {
    const script = (() => {
      const lines = sliceAt(sliceAt(workflow, "\n  notify:\n"), "\n          script: |\n")
        .split("\n")
        .slice(2);
      const body: string[] = [];
      for (const line of lines) {
        if (line.trim() !== "" && !line.startsWith(" ".repeat(12))) break;
        body.push(line.slice(12));
      }
      return body.join("\n");
    })();
    // `NAME: ${{ expression }}` in the step's env block, keyed by expression.
    const envByExpression = new Map(
      [...notifyJob.matchAll(/^ {10}(\w+): \$\{\{ (.+) \}\}$/gm)].map((m) => [m[2]!, m[1]!]),
    );
    const envVar = (expression: string) => {
      const name = envByExpression.get(expression);
      expect(name, `the notify step maps \${{ ${expression} }}`).toBeDefined();
      return name!;
    };
    const label = (dir: string) => (dir === "" ? "the app's lockfile" : `\`${dir}/\``);
    const advisoryText = "a new high/critical advisory landed";
    /** The issue's "Failing:" list items naming `dir`, split by kind. */
    const itemsFor = (body: string, dir: string) => {
      const items = body.split("\n").filter((l) => l.startsWith("- ") && l.includes(label(dir)));
      return {
        failing: items.filter((l) => !l.startsWith("- NOT AUDITED: ")),
        unaudited: items.filter((l) => l.startsWith("- NOT AUDITED: ")),
      };
    };

    type Issue = { number: number; title: string; pull_request?: object };
    type ScriptFn = (...args: unknown[]) => Promise<void>;
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...params: string[]
    ) => ScriptFn;

    /** Runs the script; `outcomes` maps a lockfile dir to its audit step's outcome. */
    async function notify(
      outcomes: Record<string, string>,
      alerts: [result: string, state: string] = ["success", "clean"],
      open: Issue[] = [],
      auditResult?: string,
    ) {
      const env: Record<string, string> = {
        [envVar("needs.audit.result")]:
          auditResult ??
          (lockfiles.pnpm.every((d) => (outcomes[d] ?? "success") === "success")
            ? "success"
            : "failure"),
        [envVar("needs.dependabot-alerts.result")]: alerts[0],
        [envVar("needs.dependabot-alerts.outputs.state")]: alerts[1],
      };
      for (const dir of lockfiles.pnpm) {
        env[envVar(`needs.audit.outputs.${outputFor(dir)}`)] = outcomes[dir] ?? "success";
      }
      const created: string[] = [];
      const comments: string[] = [];
      const github = {
        rest: {
          issues: {
            listForRepo: async () => ({ data: open }),
            create: async ({ body }: { body: string }) => {
              created.push(body);
              return { data: { number: 99 } };
            },
            createComment: async ({ body }: { body: string }) => {
              comments.push(body);
              return { data: {} };
            },
          },
        },
      };
      const context = {
        serverUrl: "https://github.example",
        repo: { owner: "o", repo: "r" },
        runId: 1,
      };
      const core = { info: () => {} };
      await new AsyncFunction("github", "context", "core", "process", script)(
        github,
        context,
        core,
        { env },
      );
      return { created, comments, body: created[0] ?? "" };
    }

    it("a checkout or pnpm-setup failure is NOT AUDITED for every lockfile, never an advisory", async () => {
      const { body } = await notify(Object.fromEntries(lockfiles.pnpm.map((d) => [d, "skipped"])));
      for (const dir of lockfiles.pnpm) {
        expect(itemsFor(body, dir), dir).toEqual({ failing: [], unaudited: [expect.any(String)] });
      }
      expect(body).toContain("setup fault, not an advisory");
      expect(body).not.toContain(advisoryText);
    });

    it("an install failure next to a red CLI audit names both: the CLI as failing, the app as not audited", async () => {
      const { body } = await notify({ "": "skipped", "vercel-cli": "failure" });
      expect(body).toContain("- NOT AUDITED: the app's lockfile");
      expect(body).toContain("\n- the deploy CLI's lockfile, `vercel-cli/`");
      expect(body).toContain(advisoryText);
      expect(body).toContain("setup fault, not an advisory");
    });

    it("an install failure with a clean CLI audit does not claim that no audit ran", async () => {
      const { body } = await notify({ "": "skipped", "vercel-cli": "success" });
      expect(body).toContain("- NOT AUDITED: the app's lockfile");
      expect(body).not.toContain("`vercel-cli/`");
      expect(body).not.toContain("before either audit ran");
      expect(body).not.toContain(advisoryText);
    });

    it("every lockfile's red audit, and every lockfile's skipped audit, is named", async () => {
      for (const dir of lockfiles.pnpm) {
        const red = (await notify({ [dir]: "failure" })).body;
        expect(itemsFor(red, dir), dir).toEqual({ failing: [expect.any(String)], unaudited: [] });
        expect(red, dir).toContain(advisoryText);
        expect(red, dir).not.toContain("NOT AUDITED");
        const skipped = (await notify({ [dir]: "skipped" })).body;
        expect(itemsFor(skipped, dir), dir).toEqual({
          failing: [],
          unaudited: [expect.any(String)],
        });
        expect(skipped, dir).not.toContain(advisoryText);
      }
    });

    it("an open alert reads as an advisory; an unreadable alerts API as a configuration fault", async () => {
      const found = (await notify({}, ["failure", "alerts"])).body;
      expect(found).toContain("- GitHub's Dependabot alerts: an open high/critical alert");
      expect(found).toContain(advisoryText);
      expect(found).not.toContain("NOT AUDITED");
      const broken = (await notify({}, ["failure", "unreadable"])).body;
      expect(broken).toContain("- the Dependabot alerts check, without a result");
      expect(broken).toContain("configuration fault");
      expect(broken).not.toContain(advisoryText);
    });

    it("never posts an empty list", async () => {
      // Both audits passed but the job still failed (a later step).
      const { body } = await notify({}, ["success", "clean"], [], "failure");
      expect(body).toMatch(
        /Failing:\n- the audit job \(result: failure\), after both audits passed/,
      );
    });

    it("a red streak comments on the open issue (not a PR of the same title) instead of opening another", async () => {
      const title = "Dependency audit failing on main";
      const bumped = await notify({ "": "skipped", "vercel-cli": "failure" }, undefined, [
        { number: 3, title, pull_request: {} },
        { number: 7, title },
      ]);
      expect(bumped.created).toEqual([]);
      expect(bumped.comments).toHaveLength(1);
      expect(bumped.comments[0]).toContain("Still failing (");
      expect(bumped.comments[0]).toContain("NOT AUDITED: the app's lockfile");
      expect(bumped.comments[0]).toContain("`vercel-cli/`");
      const opened = await notify({ "vercel-cli": "failure" }, undefined, [
        { number: 3, title, pull_request: {} },
      ]);
      expect(opened.created).toHaveLength(1);
      expect(opened.comments).toEqual([]);
    });
  });

  it("the audit job gets no permission beyond the workflow's `contents: read`", () => {
    // It runs `pnpm install` over pull-request code (review #113).
    expect(auditJob).not.toMatch(/\n    permissions:/);
    expect(auditJob).not.toContain("vulnerability-alerts");
  });

  it("the Dependabot alerts job is read-only, off the pull_request path, and fails on an open high+ alert", () => {
    expect(alertsJob).toContain("\n    name: Dependabot alerts\n");
    // Alerts describe `main`: on a PR, the PR that fixes one would stay red.
    expect(alertsJob).toContain(
      "\n    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n",
    );
    // Exactly one permission, read-only.
    expect(alertsJob).toMatch(
      /\n    permissions:\n      vulnerability-alerts: read\n    outputs:\n/,
    );
    expect(alertsJob).toContain("github.paginate(github.rest.dependabot.listAlertsForRepo");
    expect(alertsJob).toContain('state: "open"');
    expect(alertsJob).toContain('severity: "high,critical"');
    // Both an open alert and an unreadable API must fail the job.
    expect(alertsJob.match(/core\.setFailed\(/g)).toHaveLength(2);
    expect(alertsJob).toMatch(/uses: actions\/github-script@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
  });

  it("the notify job waits for both jobs and still fires only on a scheduled failure", () => {
    expect(notifyJob).toContain("\n    needs: [audit, dependabot-alerts]\n");
    expect(notifyJob).toContain("\n    if: failure() && github.event_name == 'schedule'\n");
  });

  it("dependabot.yml proposes npm version updates for every lockfile directory, with a cooldown", () => {
    for (const dir of lockfiles.pnpm) {
      const start = dependabot.indexOf(`- package-ecosystem: npm\n    directory: /${dir}\n`);
      expect(start, `dependabot.yml has an npm entry for /${dir}`).toBeGreaterThan(-1);
      const next = dependabot.indexOf("\n  - package-ecosystem:", start);
      const block = dependabot.slice(start, next === -1 ? undefined : next);
      expect(block, `npm entry for /${dir}`).toMatch(
        /\n    cooldown:\n      default-days: [1-9]\d*\n/,
      );
    }
  });

  it("no document promises security-update PRs without naming the repository setting", () => {
    // The two unconditional claims F-28 found.
    expect(securityMd).not.toContain("still arrive immediately");
    expect(dependabot).not.toContain("Dependabot always opens those immediately");
    expect(dependabot).not.toContain("security advisories still open as individual PRs");
    // The setting is named, with how to check and enable it, where an
    // operator will look for it.
    const settings = sliceAt(securityMd, "\n## Repository security settings\n", "\n## ");
    expect(settings).toContain("**Dependabot security updates**");
    expect(settings).toContain("gh api repos/devresponse/devresponsekit/automated-security-fixes");
    expect(settings).toContain(
      "gh api -X PUT repos/devresponse/devresponsekit/automated-security-fixes",
    );
    expect(settings).toContain("**Dependabot alerts**");
    // dependabot.yml's header states the condition every "still arrives" relies on.
    const header = dependabot.slice(0, dependabot.indexOf("\nversion: 2\n"));
    expect(header).toContain('"Dependabot security updates"');
    expect(header).toContain("automated-security-fixes");
  });
});
