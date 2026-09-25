import type { EnvTarget, EnvVarSpec } from "./env-spec.js";
import type { EnvVarSummary } from "./vercel-client.js";

/**
 * What is actually on Vercel for the deployment being checked (F-46).
 *
 * Vercel lists one ENTRY per stored value, and an entry serves only the
 * targets in its `target` array, and only the branch or custom environment
 * it names when it carries a `gitBranch` or `customEnvironmentIds`. The
 * checks used to ask whether any entry had the key, and never looked at its
 * type or value. So a DATABASE_URL created for Development alone read as set:
 * `env:sync` reported it "unchanged (already set)", `env:check` printed
 * `set development`, and the preflight passed a production build that cannot
 * boot. And an `httsp://` SSO_HANDOFF_ISSUER, stored write-only by hand,
 * passed every check this CLI had while every satellite handoff was refused.
 *
 * Every presence decision goes through {@link presenceFor}, and every check
 * of a stored type or value through {@link storedProblems}, so `env:check`,
 * the `env:sync` preflight that `up` relies on, and its rotation guard cannot
 * disagree about what "set" means. `env:sync` checks every entry it keeps,
 * including those of a key it is only filling in on other targets.
 */

/**
 * The targets whose stored VALUES are checked. Vercel builds and serves only
 * Production and Preview, both with NODE_ENV=production, so the kit applies
 * its production rules there. Development is what `vercel env pull` hands a
 * laptop, where a localhost origin is correct, so it is checked for presence
 * only.
 */
const VALUE_CHECKED_TARGETS: readonly string[] = ["production", "preview"];

/** Whether a stored value on `target` is checked, and so whether a value written there must pass. */
export function isValueChecked(target: string): boolean {
  return VALUE_CHECKED_TARGETS.includes(target);
}

/** How one key stands against the targets being synced or deployed. */
export interface Presence {
  key: string;
  targets: readonly EnvTarget[];
  /** The entries a deployment to one of `targets` would read: unscoped, serving at least one of them. */
  serving: EnvVarSummary[];
  /** The targets no serving entry covers. The key is present only when this is empty. */
  missing: EnvTarget[];
  /**
   * Every other entry for the key, described for the operator: another target
   * only, a git branch, a custom environment. None of them counts, but
   * naming them explains a "MISSING" for a key the dashboard shows.
   */
  elsewhere: string[];
}

/** The branch or custom environment an entry is confined to, or null for a whole target. */
function scopeOf(entry: EnvVarSummary): string | null {
  if (entry.gitBranch) return `git branch ${entry.gitBranch}`;
  if (entry.customEnvironmentIds.length > 0) {
    return `custom environment ${entry.customEnvironmentIds.join(", ")}`;
  }
  return null;
}

/** "production, preview (git branch feat-x)", for a line of output. */
export function describeEntry(entry: EnvVarSummary): string {
  const scope = scopeOf(entry);
  const targets = entry.target.length > 0 ? entry.target.join(", ") : "no target";
  return scope ? `${targets} (${scope})` : targets;
}

/**
 * The one presence rule: the key counts as set only when unscoped entries
 * cover EVERY target in `targets`. Several entries may share the work (one
 * for production, another for preview), as Vercel allows. An entry confined
 * to a git branch or a custom environment never counts: the target's own
 * deployments do not read it.
 */
export function presenceFor(
  listing: readonly EnvVarSummary[],
  key: string,
  targets: readonly EnvTarget[],
): Presence {
  const serving: EnvVarSummary[] = [];
  const elsewhere: string[] = [];
  const covered = new Set<string>();
  for (const entry of listing) {
    if (entry.key !== key) continue;
    const hits = entry.target.filter((t) => (targets as readonly string[]).includes(t));
    if (scopeOf(entry) === null && hits.length > 0) {
      serving.push(entry);
      for (const target of hits) covered.add(target);
    } else {
      elsewhere.push(describeEntry(entry));
    }
  }
  return { key, targets, serving, missing: targets.filter((t) => !covered.has(t)), elsewhere };
}

export function isPresent(presence: Presence): boolean {
  return presence.missing.length === 0;
}

/** Something wrong with a variable that IS set, and the exact way to put it right. */
export interface StoredProblem {
  why: string;
  fix: string;
}

/**
 * What is wrong with what is stored for a key, entry by entry, on the
 * targets whose values matter (production and preview).
 *
 * - A PUBLIC value (`secret: false`) must be readable, which means `plain`,
 *   or `encrypted` and read back by {@link readPublicValues}. One stored
 *   `sensitive` is write-only: no listing, no check and no code can read it,
 *   which is how the kit's production issuer sat at `httsp://` for a week.
 *   That is a problem in itself, not a skipped check.
 * - A readable value must pass the spec's `validate` rule, the copy of the
 *   kit's boot rule, and a value the recorded config pins (`expected`, from
 *   `pinnedValuesFor`) must equal it. Those are printed, expected and found,
 *   because they are public by construction.
 * - A secret is never read. One stored `plain` comes back in the listing
 *   anyway, so its value is validated, and only the rule's own sentence is
 *   printed: the rules never quote the value.
 */
export function storedProblems(spec: EnvVarSpec, presence: Presence, expected?: string): StoredProblem[] {
  const problems: StoredProblem[] = [];
  for (const entry of presence.serving) {
    const where = entry.target.filter(
      (t) => (presence.targets as readonly string[]).includes(t) && isValueChecked(t),
    );
    if (where.length === 0) continue;
    const on = where.join(", ");

    if (spec.secret) {
      const invalid = entry.value === undefined ? null : (spec.validate?.(entry.value) ?? null);
      if (invalid) {
        problems.push({
          why: `${on}: the stored value ${invalid}`,
          fix: replaceHint(spec, where, undefined),
        });
      }
      continue;
    }

    if (entry.value === undefined) {
      problems.push({
        why: `${on}: public value stored write-only (\`${entry.type}\`), so it cannot be read back or verified`,
        fix: replaceHint(spec, where, expected, "Re-store it as plain"),
      });
      continue;
    }

    const found = JSON.stringify(entry.value);
    const invalid = spec.validate?.(entry.value) ?? null;
    const mismatch = expected !== undefined && entry.value !== expected;
    if (!invalid && !mismatch) continue;
    const derivedNote = mismatch
      ? `expected ${JSON.stringify(expected)} (derived from the recorded config)`
      : "";
    problems.push({
      why: invalid
        ? `${on}: ${found} ${invalid}${mismatch ? `; ${derivedNote}` : ""}`
        : `${on}: ${derivedNote}, found ${found}`,
      fix:
        replaceHint(spec, where, expected) +
        (mismatch && !invalid
          ? " If the stored value is the right one, the recorded config is wrong instead: correct it with `drk-deploy init`."
          : ""),
    });
  }
  return problems;
}

/**
 * The remediation for a stored entry, as commands. Not `env:sync --force`: it
 * overwrites EVERY variable, regenerating each secret it may (a rotation that
 * signs every user out), and an upsert over a `sensitive` entry is not
 * known to make it readable again. Removing the entry and letting `env:sync`
 * re-create it touches this key only, and writes a public value as plain.
 */
function replaceHint(
  spec: EnvVarSpec,
  where: readonly string[],
  expected: string | undefined,
  lead = "Replace it",
): string {
  const remove = where.map((t) => `vercel env rm ${spec.key} ${t}`).join(" and ");
  const target = where.length === 1 && where[0] === "production" ? "" : ` --target ${where.join(",")}`;
  const plain = spec.secret ? "" : " as plain";
  const refill =
    expected !== undefined
      ? `\`drk-deploy env:sync${target}\` re-creates it${plain} from the recorded config`
      : spec.source === "derived"
        ? // Derived only as a default (see pinnedValuesFor): a supplied value wins.
          `\`drk-deploy env:sync${target}\` writes it back${plain}: the value from \`--from-env <file>\` or the shell, or else the default the recorded config derives`
        : `\`drk-deploy env:sync${target} --from-env <file>\` (or the value exported in the shell) writes it back${plain}`;
  return `${lead}: remove it (\`${remove}\`, or delete it in the dashboard), then ${refill}. Redeploy for it to take effect.`;
}

/**
 * Reads back the PUBLIC values Vercel lists only as ciphertext (`encrypted`),
 * so they are verified like `plain` ones instead of being reported
 * unverifiable. A dashboard edit stores `encrypted` by default, and the API
 * decrypts one on request (`getProjectEnv`), so this is not a reason to fail
 * a deployment. Only for `secret: false` keys, and only for the entries whose
 * value {@link storedProblems} checks (unscoped, on one of `targets` that is
 * Production or Preview): this never fetches a secret. A `sensitive` entry is
 * left alone, because nothing can read it.
 */
export async function readPublicValues(
  listing: readonly EnvVarSummary[],
  specs: readonly EnvVarSpec[],
  targets: readonly EnvTarget[],
  read: (entry: EnvVarSummary) => Promise<string | null>,
): Promise<EnvVarSummary[]> {
  const publicKeys = new Set(specs.filter((s) => !s.secret).map((s) => s.key));
  const checked = (t: string) => (targets as readonly string[]).includes(t) && isValueChecked(t);
  return Promise.all(
    listing.map(async (entry) => {
      if (entry.value !== undefined || entry.type !== "encrypted" || !publicKeys.has(entry.key)) return entry;
      if (scopeOf(entry) !== null || !entry.target.some(checked)) return entry;
      const value = await read(entry);
      return value === null ? entry : { ...entry, value };
    }),
  );
}
