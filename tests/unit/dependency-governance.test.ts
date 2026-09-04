import { readFileSync } from "node:fs";
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

  it("every muted GHSA has an allowlist row with a review-by date", () => {
    for (const ghsa of pkg.pnpm.auditConfig.ignoreGhsas) {
      const row = securityMd.split("\n").find((line) => line.startsWith(`| \`${ghsa}\` |`));
      expect(row, `allowlist row for ${ghsa}`).toBeDefined();
      expect(row).toMatch(/\| \d{4}-\d{2}-\d{2} \|\s*$/);
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
});

describe("dependency governance: production image", () => {
  const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));

  it("both stages build from the same digest-pinned node:22-bookworm-slim image", () => {
    expect(fromLines).toHaveLength(2);
    const digests = fromLines.map((line) => {
      const m = line.match(
        /^FROM node:22-bookworm-slim@(sha256:[0-9a-f]{64}) AS (builder|runner)$/,
      );
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
