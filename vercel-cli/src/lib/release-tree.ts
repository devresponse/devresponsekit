import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type RunResult, run } from "./exec.js";
import { CliError } from "./log.js";
import type { ProjectGit } from "./vercel-client.js";

/**
 * What a release is made from, and who else deploys it (F-49).
 *
 * `deploy`, `up` and `migrate` used to release whatever the checkout held: a
 * feature branch, uncommitted edits, an untracked migration file. The kit's
 * migration runner ledgers every file it applies under a checksum of its
 * content (`reconcileLedgerChecksum`, src/db/migrations/migration-plan.ts), so
 * a work-in-progress `0007-foo.sql` applied to production from a laptop stays
 * applied. When review then edits that file, every later migrate against
 * production aborts on the checksum mismatch until someone rewrites the ledger
 * by hand. And nothing recorded which commit had run: the ledger holds an id,
 * a checksum and a time.
 *
 * So a release is now made only from a commit that can be named and that
 * review can see. For every checkout a run reads (the kit, and a satellite's
 * app folder when it is the one built):
 *
 * - it is a git checkout, with a commit;
 * - `git status --porcelain` is empty, untracked files included (an untracked
 *   migration is exactly the file that goes wrong);
 * - HEAD is the tip of a remote-tracking branch, so it has been pushed.
 *
 * A run that PROMOTES (`deploy`, `up`) also needs HEAD to be what origin's
 * default branch holds, or the pushed ref `--allow-ref` names. So does the kit
 * checkout a satellite's own database is migrated from, for every command and
 * with no flag: nothing documents migrating a satellite's production ahead of
 * a kit merge. Only the kit's own `migrate` may run from any pushed branch,
 * because docs/deployment.md §1.1 has the kit's production migrated from the
 * open pull request's branch BEFORE it merges (see {@link ReleaseRule}).
 *
 * One change is set aside rather than refused: `next-env.d.ts` modified in the
 * working tree. `next build` rewrites it in place on every run (the kit commits
 * the `next dev` form, which imports `.next/dev/types`), including the build
 * `deploy` itself runs. It is regenerated from the app's config before
 * anything reads it and it emits nothing, so what is built and migrated does
 * not depend on it. Refusing it would refuse the next run after every build.
 * It is reported, never hidden.
 *
 * Nothing here fetches. "Pushed" and "origin/main" mean the remote-tracking
 * refs as the checkout last fetched them, and the report says so: a fetch
 * writes refs, and this runs before anything is allowed to write.
 */

/** One checkout, as `git` describes it. Read by {@link inspectTree}, judged by {@link treeProblems}. */
export interface TreeState {
  /** The directory inspected: the kit checkout, or a satellite's app folder. */
  root: string;
  /** Why this is not a git checkout (git's own words), or null when it is one. */
  notRepository: string | null;
  /** HEAD's commit, or null in a repository with no commit yet. */
  head: string | null;
  /** The branch checked out, or null when HEAD is detached. */
  branch: string | null;
  /**
   * Every change `git status --porcelain` lists, untracked files included, in
   * its plain `XY path` form, except the ones in {@link TreeState.generated}.
   */
  changes: string[];
  /**
   * Paths of `next-env.d.ts` files modified in the working tree (not staged),
   * set aside from `changes` because every `next build` rewrites them (see
   * {@link rewrittenByBuild}). Reported, not refused.
   */
  generated: string[];
  /** Remote-tracking branches whose tip is HEAD, as last fetched (`origin/main`). */
  pushedAs: string[];
  /** The ref a promoting run must release, and its commit (null when it does not resolve). */
  release: { ref: string; commit: string | null };
}

/** The remote whose default branch a promoting run releases, unless `--allow-ref` names another ref. */
export const RELEASE_REMOTE = "origin";

/**
 * The variables that make `git` read ANOTHER repository than the one in its
 * working directory. A shell inside a git hook has GIT_DIR set, for one, and
 * the check would then report that repository's state as this checkout's.
 * Matched case-insensitively, because on Windows `git_dir` is GIT_DIR to the
 * child (as `migrationEnv` does for the libpq variables, F-47).
 */
const REPOSITORY_SELECTORS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];

/** The overlay for a `git` child: every repository selector removed (`undefined` drops it). */
export function gitEnv(inherited: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const spelled = Object.keys(inherited).filter((key) => REPOSITORY_SELECTORS.includes(key.toUpperCase()));
  return Object.fromEntries([...REPOSITORY_SELECTORS, ...spelled].map((key) => [key, undefined]));
}

/**
 * Refuses an `--allow-ref` that `git` would read as an option. The ref reaches
 * `git` as one argument of a vector (no shell), so a leading dash is the only
 * way it could be misread.
 */
export function assertRefName(ref: string): void {
  if (!ref.trim() || ref.startsWith("-") || /\s/.test(ref)) {
    throw new CliError(`--allow-ref ${JSON.stringify(ref)} is not a ref.`, {
      hint: "Name the pushed branch to deploy as git knows it, e.g. --allow-ref origin/hotfix.",
      exitCode: 2,
    });
  }
}

/** Non-empty output lines, without the carriage return Windows' git may leave. */
function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** The file Next writes into the app folder on every `next build` and `next dev`. */
export const NEXT_ENV_FILE = "next-env.d.ts";

/**
 * Is this path (relative to the repository root, as `git status` prints it)
 * a `next-env.d.ts`?
 *
 * Next regenerates the file from the app's config on every build and dev run
 * (`writeAppTypeDeclarations`), and never reads the old content. The two
 * commands write different forms: `next dev` imports `./.next/dev/types/…`,
 * `next build` imports `./.next/types/…`. So a checkout that commits one form
 * shows the file modified after the other command runs. The kit commits the
 * dev form, and `vercel build`, which `deploy` and `up` run in the checkout,
 * runs `next build`. The file declares types and emits no code, and the build
 * rewrites it before type-checking, so whatever it holds changes nothing that
 * is built or migrated. Any folder counts: a satellite repository holds
 * several apps, and building one of them locally must not stop another's
 * deploy.
 */
export function rewrittenByBuild(path: string): boolean {
  return path === NEXT_ENV_FILE || path.endsWith(`/${NEXT_ENV_FILE}`);
}

/**
 * `git status --porcelain=v1 -z` output, as the plain porcelain lines
 * (`XY path`, `R  from -> to`) with every path unquoted, split into what
 * counts and what {@link rewrittenByBuild} sets aside.
 *
 * `-z` because the plain form wraps a path with a space or an unusual
 * character in quotes, and a quoted `app one/next-env.d.ts` would not be
 * recognised. Only a working-tree modification (` M`) is set aside: a staged,
 * deleted or untracked `next-env.d.ts` is something a person did, not the
 * build, and it counts.
 */
export function readStatus(output: string): { changes: string[]; generated: string[] } {
  const fields = output.split("\0");
  const changes: string[] = [];
  const generated: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index] ?? "";
    if (entry.length === 0) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or a copy is followed by the path it came from (`-z` reverses the plain order).
    const from = /[RC]/.test(xy) ? (fields[++index] ?? "") : undefined;
    if (xy === " M" && rewrittenByBuild(path)) {
      generated.push(path);
      continue;
    }
    changes.push(`${xy} ${from !== undefined ? `${from} -> ` : ""}${path}`);
  }
  return { changes, generated };
}

/**
 * Reads one checkout's state with read-only `git` commands. Nothing is
 * fetched, and `status` runs with `--no-optional-locks`, so not even the
 * index is refreshed.
 *
 * `--untracked-files=normal` is explicit because `status.showUntrackedFiles=no`
 * in a config would otherwise hide the untracked migration this exists to
 * find, and `-z` leaves every path unquoted ({@link readStatus}). `allowRef`
 * replaces origin's default branch as the release ref; the
 * default is `refs/remotes/origin/HEAD` (what a clone records), else
 * `origin/main` (a CI checkout records no origin/HEAD).
 */
export async function inspectTree(root: string, allowRef?: string): Promise<TreeState> {
  const env = gitEnv();
  const git = (args: string[]) => run("git", args, { cwd: root, env, capture: true });
  const unresolved = { ref: allowRef ?? `${RELEASE_REMOTE}/main`, commit: null };
  const outside = (why: string): TreeState => ({
    root,
    notRepository: why,
    head: null,
    branch: null,
    changes: [],
    generated: [],
    pushedAs: [],
    release: unresolved,
  });

  if (!existsSync(root)) return outside("the directory does not exist");
  let top: RunResult;
  try {
    top = await git(["rev-parse", "--show-toplevel"]);
  } catch (err) {
    // `git` itself could not be started: nothing can be named, so nothing is released.
    return outside((err as Error).message);
  }
  if (top.code !== 0) return outside(lines(top.stderr)[0] ?? `git rev-parse exited ${top.code}`);

  const headResult = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headResult.code === 0 ? (lines(headResult.stdout)[0] ?? null) : null;
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.code === 0 ? (lines(branchResult.stdout)[0] ?? null) : null;

  const status = await git([
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);
  const { changes, generated } =
    status.code === 0
      ? readStatus(status.stdout)
      : {
          changes: [`(git status failed, exit ${status.code}: ${lines(status.stderr)[0] ?? "no message"})`],
          generated: [],
        };

  let pushedAs: string[] = [];
  if (head) {
    // A symbolic ref (origin/HEAD) names a branch already listed, so it is skipped.
    const tips = await git([
      "for-each-ref",
      "--points-at=HEAD",
      "--format=%(refname)%09%(symref)",
      "refs/remotes/",
    ]);
    pushedAs = lines(tips.stdout)
      .map((line) => line.split("\t"))
      .filter(([, symref]) => !symref)
      .map(([name]) => (name ?? "").replace(/^refs\/remotes\//, ""))
      .filter((name) => name.length > 0);
  }

  let release: TreeState["release"];
  if (allowRef !== undefined) {
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${allowRef}^{commit}`]);
    release = { ref: allowRef, commit: resolved.code === 0 ? (lines(resolved.stdout)[0] ?? null) : null };
  } else {
    const remoteHead = await git(["symbolic-ref", "--quiet", `refs/remotes/${RELEASE_REMOTE}/HEAD`]);
    const full =
      remoteHead.code === 0
        ? (lines(remoteHead.stdout)[0] ?? `refs/remotes/${RELEASE_REMOTE}/main`)
        : `refs/remotes/${RELEASE_REMOTE}/main`;
    // Resolved by its full name: a LOCAL branch called "origin/main" would win the short one.
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${full}^{commit}`]);
    release = {
      ref: full.replace(/^refs\/remotes\//, ""),
      commit: resolved.code === 0 ? (lines(resolved.stdout)[0] ?? null) : null,
    };
  }

  return { root, notRepository: null, head, branch, changes, generated, pushedAs, release };
}

/** What stops a release from one checkout, and how to fix it. */
export interface TreeProblem {
  what: string;
  fix: string;
}

/** A commit, short enough to read and long enough to find. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "(none)";
}

/** The first few `git status` lines, for a message that names what is uncommitted. */
function preview(changes: string[]): string {
  const shown = changes.slice(0, 5).map((line) => line.trim());
  const more = changes.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

/**
 * Which HEAD a checkout may be released at, beyond clean and pushed (F-49).
 *
 * - `"release"`: the release ref, which is origin's default branch or the
 *   pushed ref `--allow-ref` names. This is the checkout a `deploy` or `up`
 *   builds and promotes.
 * - `"default-branch"`: origin's default branch, and no flag changes that.
 *   This is the kit checkout a satellite's OWN production database is
 *   migrated from, by `deploy`, `up` and `migrate` alike. The kit's §1.1 gate
 *   (migrate from the pull request's branch, then merge) covers the kit's own
 *   production. Nothing documents one for a satellite's, and a migration
 *   applied there from an unmerged branch has the same fate: it is ledgered
 *   under its checksum, and once review changes it every later migrate of
 *   that database aborts. `--allow-ref` names the satellite's ref. It is
 *   another repository, so the flag never applies to the kit's.
 * - `"any-pushed"`: any pushed commit. This is the kit checkout of the kit's
 *   own `migrate`, which docs/deployment.md §1.1 runs from the open pull
 *   request's branch before it merges.
 */
export type ReleaseRule = "release" | "default-branch" | "any-pushed";

/** Why the kit checkout behind a satellite's own database stays on origin's default branch. */
const KIT_FOR_SATELLITE =
  "A satellite's own database is migrated only from the kit's merged migrations: one applied from an unmerged branch is ledgered under its checksum, and once review changes it every later migrate of that database aborts. No flag changes this. --allow-ref names the satellite's ref, never the kit's.";

/**
 * Every reason this checkout may not be released from. Pure, so the rules are
 * table-tested without a repository. `rule` is which HEAD it may be at
 * ({@link ReleaseRule}), and `allowRef` the `--allow-ref` it was read with,
 * for a `"release"` checkout only.
 */
export function treeProblems(
  state: TreeState,
  check: { label: string; rule: ReleaseRule; allowRef?: string },
): TreeProblem[] {
  const { label } = check;
  if (state.notRepository !== null) {
    return [
      {
        what: `the ${label} (${state.root}) is not a git checkout`,
        fix: `git says: ${state.notRepository}. A release is made only from a commit, so that what ran can be named.`,
      },
    ];
  }
  if (!state.head) {
    return [{ what: `the ${label} has no commit yet`, fix: "Commit and push it first." }];
  }

  const problems: TreeProblem[] = [];
  if (state.changes.length > 0) {
    problems.push({
      what: `the ${label} has ${state.changes.length} uncommitted change(s), untracked files included: ${preview(state.changes)}`,
      fix: "Commit and push them, or set them aside (`git stash --include-untracked`). An uncommitted migration applied to production is ledgered under its checksum, and once review changes it every later migrate aborts on the mismatch.",
    });
  }
  if (state.pushedAs.length === 0) {
    problems.push({
      what: `the ${label}'s HEAD ${shortSha(state.head)}${state.branch ? ` (${state.branch})` : ""} is not pushed: no remote-tracking branch points at it`,
      fix: "Push it (`git push`), so review sees exactly what ran. If it was pushed from somewhere else, `git fetch` first: nothing here fetches.",
    });
  }
  const pinned = check.rule !== "any-pushed";
  const allowRef = check.rule === "release" ? check.allowRef : undefined;
  if (pinned && state.release.commit === null) {
    problems.push({
      what: `the ${label} has no ${state.release.ref} to compare HEAD with`,
      fix:
        check.rule === "default-branch"
          ? `Fetch it in ${state.root} (\`git fetch ${RELEASE_REMOTE}\`). ${KIT_FOR_SATELLITE}`
          : allowRef !== undefined
            ? `git cannot resolve ${state.release.ref} in ${state.root}. Name a ref it knows, e.g. origin/<branch> after a fetch.`
            : `Fetch it (\`git fetch ${RELEASE_REMOTE}\`), or name the pushed ref to deploy with --allow-ref <ref> (a remote not called ${RELEASE_REMOTE} needs it too).`,
    });
  } else if (pinned && state.release.commit !== state.head) {
    problems.push({
      what: `the ${label}'s HEAD ${shortSha(state.head)} is not ${state.release.ref} (${shortSha(state.release.commit)})`,
      fix:
        check.rule === "default-branch"
          ? `Check out what ${state.release.ref} holds in ${state.root} (then \`git pull --ff-only\`). ${KIT_FOR_SATELLITE}`
          : allowRef !== undefined
            ? `Check out ${state.release.ref} itself, or name the ref HEAD is.`
            : `Deploy what ${state.release.ref} holds (check it out, then \`git pull --ff-only\`), or name the pushed ref to deploy with --allow-ref <ref>. To migrate the kit's production from a pull request's branch before it merges, run \`drk-deploy migrate\`, which allows it.`,
    });
  }
  return problems;
}

/** Why a changed `next-env.d.ts` is reported and not refused, for the line that names it. */
export const GENERATED_NOTE =
  "modified, set aside: every `next build` rewrites it from the app's config, and nothing built or migrated reads it";

/** "abc123def456 (on main, clean tree, pushed as origin/main)": the line that records what ran. */
export function describeCommit(state: TreeState): string {
  const where = state.branch ? `on ${state.branch}` : "detached HEAD";
  const tree = `${state.changes.length === 0 ? "clean tree" : `${state.changes.length} UNCOMMITTED change(s)`}${
    state.generated.length > 0 ? ` apart from ${state.generated.join(" and ")}` : ""
  }`;
  const pushed = state.pushedAs.length > 0 ? `pushed as ${state.pushedAs.join(", ")}` : "NOT pushed";
  return `${state.head ?? "(no commit)"} (${where}, ${tree}, ${pushed})`;
}

/* ------------------------------------------------------------------ */
/*  The other deployer: Vercel's git integration                       */
/* ------------------------------------------------------------------ */

/** A checkout's `vercel.json`, or null when it has none or it is not JSON. */
export function readVercelJson(root: string): unknown {
  const file = join(root, "vercel.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Does Vercel ITSELF build and promote a production deployment on every push
 * to the project's production branch?
 *
 * While it does, this CLI's order (migrate, then promote) is a race it cannot
 * win: a merge is promoted by Vercel, with no migration, however soon this
 * runs. The README said so, and nothing checked it. Only an answer this can
 * be sure of counts as off: no repository connected, `git.deploymentEnabled`
 * false in `vercel.json` (for every branch, or for the production branch by
 * name), or an Ignored Build Step of `exit 0`, which skips every build. Any
 * other Ignored Build Step is a program this cannot evaluate, so it counts as
 * on, and is named so the operator can judge it.
 */
export function productionAutoDeploy(git: ProjectGit, vercelJson: unknown): { on: boolean; why: string } {
  if (!git.repository) return { on: false, why: "no git repository is connected to the project" };
  const branch = git.productionBranch ?? "main";
  const enabled = (vercelJson as { git?: { deploymentEnabled?: unknown } } | null)?.git?.deploymentEnabled;
  if (enabled === false) {
    return {
      on: false,
      why: `${git.repository} is connected, but vercel.json sets git.deploymentEnabled false`,
    };
  }
  if (
    typeof enabled === "object" &&
    enabled !== null &&
    (enabled as Record<string, unknown>)[branch] === false
  ) {
    return {
      on: false,
      why: `${git.repository} is connected, but vercel.json sets git.deploymentEnabled.${branch} false`,
    };
  }
  const ignore = git.ignoreCommand?.trim() ?? "";
  if (/^exit\s+0;?$/.test(ignore)) {
    return {
      on: false,
      why: `${git.repository} is connected, but its Ignored Build Step (\`exit 0\`) skips every build`,
    };
  }
  return {
    on: true,
    why: `${git.repository}: every push to ${branch} is built and promoted by Vercel${
      ignore ? `, unless its Ignored Build Step (\`${ignore}\`), which this cannot evaluate, skips it` : ""
    }`,
  };
}
