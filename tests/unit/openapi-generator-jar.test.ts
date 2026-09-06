import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureVerifiedJar,
  EXPECTED_JAR_SHA256,
  jarPathFor,
  jarUrl,
  readGeneratorConfig,
} from "../../scripts/verify-openapi-generator-jar";

/**
 * The admin-SDK generator supply chain (review #111/#197): the npm wrapper is
 * an exact-pinned devDependency run through `pnpm exec` (no floating `npx`),
 * the JAR version is pinned in openapitools.json, and the JAR's SHA-256 is
 * verified before the wrapper executes it. The first block pins the wiring
 * in the committed config; the second exercises the verifier against a
 * temp directory with a fake fetch, including the two failure modes that
 * matter (a bad download, a tampered cache).
 */
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const generateScript = pkg.scripts["sdk:admin:generate"]!;

describe("generator wiring is pinned end to end", () => {
  it("the wrapper is an exact-pinned devDependency resolved by the lockfile", () => {
    const pin = pkg.devDependencies["@openapitools/openapi-generator-cli"]!;
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain(
      `'@openapitools/openapi-generator-cli':\n        specifier: ${pin}\n`,
    );
    expect(lockfile).toContain(`\n  '@openapitools/openapi-generator-cli@${pin}':`);
  });

  it("sdk:admin:generate verifies the JAR, then runs the wrapper via pnpm exec — never npx", () => {
    expect(generateScript).not.toMatch(/\bnpx\b/);
    const verify = generateScript.indexOf("tsx scripts/verify-openapi-generator-jar.ts");
    const run = generateScript.indexOf("pnpm exec openapi-generator-cli generate");
    expect(verify).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(verify);
    // `&&` chaining: a failed verification must stop the generator.
    expect(generateScript.slice(verify, run)).toContain("&&");
  });

  it("openapitools.json pins a version that has a SHA-256 on file and a gitignored storageDir", async () => {
    const config = await readGeneratorConfig(root);
    expect(EXPECTED_JAR_SHA256[config.version]).toMatch(/^[0-9a-f]{64}$/);
    expect(config.storageDir.startsWith(".cache/")).toBe(true);
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
    expect(gitignore).toContain(".cache/");
    expect(jarPathFor(root, config)).toBe(
      path.resolve(root, config.storageDir, `${config.version}.jar`),
    );
    expect(jarUrl(config.version)).toBe(
      `https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/${config.version}/openapi-generator-cli-${config.version}.jar`,
    );
  });

  it("the ci.yml sdk-drift comment describes the verified pipeline, not just the version pin", () => {
    const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.slice(
      ci.indexOf("  sdk-drift:"),
      ci.indexOf("      - uses: actions/checkout", ci.indexOf("  sdk-drift:")),
    );
    expect(job).toContain("verify-openapi-generator-jar");
    expect(job).toContain("exact-pinned devDependency");
    expect(job).toContain("SHA-256");
    // The job runs the package script (whose own guard above forbids npx),
    // never an ad-hoc generator invocation.
    // The whole job: from its key to the next top-level (2-space) job key.
    const jobBlock = /^ {2}sdk-drift:[\s\S]*?(?=^ {2}[a-z]|(?![\s\S]))/m.exec(ci)![0];
    const runLines = jobBlock.split("\n").filter((line) => /^\s+run:/.test(line));
    expect(runLines.some((line) => line.includes("pnpm sdk:admin:generate"))).toBe(true);
    expect(runLines.some((line) => /\bnpx\b/.test(line))).toBe(false);
  });
});

describe("ensureVerifiedJar", () => {
  const VERSION = "9.9.9";
  const GOOD = Buffer.from("PK pretend this is the generator jar");
  const GOOD_SHA = createHash("sha256").update(GOOD).digest("hex");
  let dir: string;
  let fetches: string[];

  const fakeFetch = (bytes: Buffer | null) =>
    (async (url: string | URL | Request) => {
      fetches.push(String(url));
      return bytes
        ? new Response(new Uint8Array(bytes), { status: 200 })
        : new Response("nope", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "og-jar-"));
    fetches = [];
    await writeFile(
      path.join(dir, "openapitools.json"),
      JSON.stringify({ "generator-cli": { version: VERSION, storageDir: "cache/og" } }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads a missing JAR from Maven Central, verifies it, and then reuses the cache", async () => {
    const first = await ensureVerifiedJar({
      root: dir,
      expected: { [VERSION]: GOOD_SHA },
      fetchImpl: fakeFetch(GOOD),
    });
    expect(first).toEqual({
      path: path.resolve(dir, "cache/og", `${VERSION}.jar`),
      sha256: GOOD_SHA,
      downloaded: true,
    });
    expect(fetches).toEqual([jarUrl(VERSION)]);
    expect(await readFile(first.path)).toEqual(GOOD);
    expect(existsSync(`${first.path}.download`)).toBe(false);

    const second = await ensureVerifiedJar({
      root: dir,
      expected: { [VERSION]: GOOD_SHA },
      fetchImpl: fakeFetch(null), // would fail if it fetched again
    });
    expect(second.downloaded).toBe(false);
    expect(fetches).toHaveLength(1);
  });

  it("rejects a download whose hash does not match and leaves nothing behind", async () => {
    await expect(
      ensureVerifiedJar({
        root: dir,
        expected: { [VERSION]: GOOD_SHA },
        fetchImpl: fakeFetch(Buffer.from("evil bytes")),
      }),
    ).rejects.toThrow(/download hash mismatch: expected/);
    const jar = path.resolve(dir, "cache/og", `${VERSION}.jar`);
    expect(existsSync(jar)).toBe(false);
    expect(existsSync(`${jar}.download`)).toBe(false);
  });

  it("deletes a cached JAR that no longer matches and refuses to use it", async () => {
    const jar = path.resolve(dir, "cache/og", `${VERSION}.jar`);
    await ensureVerifiedJar({
      root: dir,
      expected: { [VERSION]: GOOD_SHA },
      fetchImpl: fakeFetch(GOOD),
    });
    await writeFile(jar, Buffer.concat([GOOD, Buffer.from(" tampered")]));
    await expect(
      ensureVerifiedJar({
        root: dir,
        expected: { [VERSION]: GOOD_SHA },
        fetchImpl: fakeFetch(null),
      }),
    ).rejects.toThrow(/hash mismatch: expected .* — removed/);
    expect(existsSync(jar)).toBe(false);
  });

  it("fails closed on a failed download or a version with no pinned hash", async () => {
    await expect(
      ensureVerifiedJar({
        root: dir,
        expected: { [VERSION]: GOOD_SHA },
        fetchImpl: fakeFetch(null),
      }),
    ).rejects.toThrow(/Download failed: 503/);
    await expect(
      ensureVerifiedJar({ root: dir, expected: {}, fetchImpl: fakeFetch(GOOD) }),
    ).rejects.toThrow(/No pinned SHA-256 for openapi-generator 9\.9\.9/);
    expect(fetches).toEqual([jarUrl(VERSION)]); // the unpinned case never fetched
  });

  it("refuses a config without an exact version pin or a storageDir", async () => {
    await writeFile(
      path.join(dir, "openapitools.json"),
      JSON.stringify({ "generator-cli": { version: "7.x", storageDir: "cache" } }),
    );
    await expect(readGeneratorConfig(dir)).rejects.toThrow(/exact x\.y\.z pin/);
    await writeFile(
      path.join(dir, "openapitools.json"),
      JSON.stringify({ "generator-cli": { version: "7.12.0" } }),
    );
    await expect(readGeneratorConfig(dir)).rejects.toThrow(/storageDir must be set/);
  });
});
