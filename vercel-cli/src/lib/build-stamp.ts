import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { CliError } from "./log.js";

/**
 * Whether `dist/` is a build of the source beside it (I-14).
 *
 * `dist/` is gitignored, and both `drk-deploy.cmd` and `node dist/index.js`
 * run whatever it holds. So after a `git pull` brought a fix to `src/` (a
 * release guard, say), `drk-deploy up` went on running the old build, old
 * checks and all, until someone remembered `pnpm build`, and nothing said so.
 *
 * `pnpm build` now ends by writing {@link BUILD_STAMP}: a hash of the build's
 * inputs, every `.ts` file under `src/` by path and content plus
 * `tsconfig.json`. The entry point recomputes it before it parses a command
 * and refuses to run when the two differ, or when there is no stamp: a bare
 * `tsc` (or `pnpm dev`) writes none, and neither did any build made before
 * this check. Content, not mtimes: git gives every file it writes the time of
 * the pull, so a branch switched away from and back to would refuse a current
 * build, and whether the compiler rewrites an output it would emit unchanged
 * is its own business. It refuses rather than rebuilds: a build needs pnpm,
 * may need an install the pull made necessary, and may not typecheck, none of
 * which belongs inside a `deploy`.
 */

/** The stamp `pnpm build` writes, relative to the CLI root. Gitignored with the rest of `dist/`. */
export const BUILD_STAMP = join("dist", "build-stamp.json");

/**
 * A SHA-256 over what `tsc -p tsconfig.json` compiles (every `.ts` file under
 * `src/`) and the config it compiles with, or null when there is no `src/`: a
 * build shipped without its source has nothing to be stale against. Paths are
 * hashed relative to `src/`, in `/` form, so a copy of the package hashes the
 * same.
 */
export function sourceHash(cliRoot: string): string | null {
  const src = join(cliRoot, "src");
  if (!existsSync(src)) return null;
  const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && statSync(join(src, file)).isFile())
    .map((file) => file.split(sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(`src/${file}\0`)
      .update(readFileSync(join(src, file)))
      .update("\0");
  }
  const tsconfig = join(cliRoot, "tsconfig.json");
  if (existsSync(tsconfig)) hash.update("tsconfig.json\0").update(readFileSync(tsconfig));
  return hash.digest("hex");
}

/**
 * The last step of `pnpm build`: records which source `dist/` was built from.
 * It hashes `src/` as it stands once `tsc` has finished, so a file saved while
 * `tsc` ran is recorded as built even if `tsc` compiled the version before it.
 * That gap is known and documented (README, "Rebuild after a pull"): the
 * remedy is to build again after an edit made mid-build.
 */
export function writeBuildStamp(cliRoot: string): void {
  writeFileSync(
    join(cliRoot, BUILD_STAMP),
    `${JSON.stringify({ sourceHash: sourceHash(cliRoot) }, null, 2)}\n`,
  );
}

/** Why `dist/` is not a build of this `src/`, or null when it is (or there is no `src/`). */
export function staleBuild(cliRoot: string): string | null {
  const current = sourceHash(cliRoot);
  if (current === null) return null;
  let stamped: unknown;
  try {
    stamped = (JSON.parse(readFileSync(join(cliRoot, BUILD_STAMP), "utf8")) as { sourceHash?: unknown })
      .sourceHash;
  } catch {
    stamped = undefined;
  }
  if (typeof stamped !== "string") {
    return "This build of drk-deploy carries no build stamp, so nothing shows it was built from this checkout's src/: it predates stamped builds, or came from `pnpm dev` or a bare tsc.";
  }
  if (stamped !== current) {
    return "This build of drk-deploy is out of date: src/ changed after `pnpm build` (a git pull, say), so dist/ would run the old code.";
  }
  return null;
}

/** Refuses to run a `dist/` that is not a build of this `src/` (exit 2, nothing done). */
export function assertFreshBuild(cliRoot: string): void {
  const problem = staleBuild(cliRoot);
  if (problem === null) return;
  throw new CliError(problem, {
    exitCode: 2,
    hint: `Rebuild it, then run the command again: pnpm --dir "${cliRoot}" build (after pnpm --dir "${cliRoot}" install when the pull changed pnpm-lock.yaml).`,
  });
}
