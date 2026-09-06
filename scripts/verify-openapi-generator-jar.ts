import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Supply-chain pre-step for `pnpm sdk:admin:generate` (review #111/#197).
 *
 * The admin SDK is produced by openapi-generator, a 30 MB JAR that the
 * `@openapitools/openapi-generator-cli` npm wrapper downloads from Maven
 * Central on first use and then RUNS on every generate. The wrapper pins the
 * JAR *version* (openapitools.json) but never checks *what it downloaded* —
 * and the wrapper itself used to float through `npx --yes`. Since the
 * `OpenAPI + admin SDK drift` job is a required check, that was an unpinned,
 * unverified executable on the merge path.
 *
 * This script runs BEFORE the generator: it makes sure the JAR the wrapper
 * will pick up (`<storageDir>/<version>.jar`, both read from
 * openapitools.json) exists and has the pinned SHA-256 — downloading it from
 * Maven Central itself when absent, and deleting + failing on any mismatch so
 * a poisoned cache can never be executed. The wrapper package is an
 * exact-pinned devDependency run via `pnpm exec` (lockfile-resolved).
 *
 * Pin provenance: the 7.12.0 hash was computed from a fresh Maven Central
 * download whose SHA-1 matched the repository's published `.sha1`
 * (2c7d5141384d2caaa2d11d370ed172525855c157). Bumping the generator means
 * bumping BOTH `generator-cli.version` and this table
 * (`tests/unit/openapi-generator-jar.test.ts` guards that).
 *
 *   tsx scripts/verify-openapi-generator-jar.ts
 */

/** Pinned SHA-256 per generator version — extend when bumping openapitools.json. */
export const EXPECTED_JAR_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "7.12.0": "33e7dfa7a1f04d58405ee12ae19e2c6fc2a91497cf2e56fa68f1875a95cbf220",
});

export const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";

export function jarUrl(version: string): string {
  return `${MAVEN_CENTRAL}/org/openapitools/openapi-generator-cli/${version}/openapi-generator-cli-${version}.jar`;
}

export interface GeneratorConfig {
  version: string;
  storageDir: string;
}

/** Reads `generator-cli.version` and `generator-cli.storageDir` from openapitools.json. */
export async function readGeneratorConfig(root: string): Promise<GeneratorConfig> {
  const raw = await readFile(path.join(root, "openapitools.json"), "utf8");
  const parsed = JSON.parse(raw) as { "generator-cli"?: Record<string, unknown> };
  const config = parsed["generator-cli"] ?? {};
  const version = config.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("openapitools.json: generator-cli.version must be an exact x.y.z pin");
  }
  const storageDir = config.storageDir;
  if (typeof storageDir !== "string" || storageDir.length === 0) {
    // Without storageDir the wrapper writes into its own node_modules folder,
    // whose path depends on the package manager's layout — pin it so this
    // script and the wrapper agree on ONE location.
    throw new Error(
      "openapitools.json: generator-cli.storageDir must be set (repo-local, gitignored)",
    );
  }
  return { version, storageDir };
}

/** Mirrors the wrapper's own resolution: `<cwd>/<storageDir>/<version>.jar`. */
export function jarPathFor(root: string, { version, storageDir }: GeneratorConfig): string {
  return path.resolve(root, storageDir, `${version}.jar`);
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface EnsureOptions {
  root: string;
  expected?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface VerifiedJar {
  path: string;
  sha256: string;
  downloaded: boolean;
}

/**
 * Ensures the pinned JAR is present and verified. Throws (after removing the
 * offending file) on a hash mismatch or a missing pin.
 */
export async function ensureVerifiedJar({
  root,
  expected = EXPECTED_JAR_SHA256,
  fetchImpl = globalThis.fetch,
  log = () => {},
}: EnsureOptions): Promise<VerifiedJar> {
  const config = await readGeneratorConfig(root);
  const pinned = expected[config.version];
  if (!pinned) {
    throw new Error(
      `No pinned SHA-256 for openapi-generator ${config.version} — add it to EXPECTED_JAR_SHA256 ` +
        "in scripts/verify-openapi-generator-jar.ts (compute it from a Maven Central download " +
        "cross-checked against the published .sha1).",
    );
  }
  const jarPath = jarPathFor(root, config);
  let downloaded = false;

  const present = await stat(jarPath).then(
    (s) => s.isFile(),
    () => false,
  );

  if (!present) {
    const url = jarUrl(config.version);
    log(`[sdk] downloading openapi-generator ${config.version} from ${url}`);
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
    }
    await mkdir(path.dirname(jarPath), { recursive: true });
    // Write to a sibling temp file and rename only after verification, so a
    // partial or wrong download can never sit at the path the wrapper runs.
    const tmp = `${jarPath}.download`;
    await writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    const actual = await sha256File(tmp);
    if (actual !== pinned) {
      await rm(tmp, { force: true });
      throw new Error(
        `openapi-generator ${config.version} download hash mismatch: expected ${pinned}, got ${actual} — refusing to use it`,
      );
    }
    await rename(tmp, jarPath);
    downloaded = true;
  }

  const sha256 = await sha256File(jarPath);
  if (sha256 !== pinned) {
    // A cached JAR that no longer matches is worse than a missing one: delete
    // it so the next run re-downloads instead of executing it.
    await rm(jarPath, { force: true });
    throw new Error(
      `Cached ${path.relative(root, jarPath)} hash mismatch: expected ${pinned}, got ${sha256} — removed; re-run to download a fresh copy`,
    );
  }
  log(`[sdk] verified ${path.relative(root, jarPath)} sha256=${sha256}`);
  return { path: jarPath, sha256, downloaded };
}

const __filename = fileURLToPath(import.meta.url);
// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const root = path.resolve(path.dirname(__filename), "..");
  ensureVerifiedJar({ root, log: (line) => console.log(line) }).catch((error: unknown) => {
    console.error(`[sdk] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
