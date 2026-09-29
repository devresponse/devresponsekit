import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-154 systemic guard — every grant write asks the ONE eligibility rule.
 *
 * Three routes wrote grants under three rules (no membership, any status,
 * active only), and an accepted invitation wrote its role under none. They
 * now all ask `grantEligibleUserIds` / `userIsGrantEligible`
 * (src/lib/admin/access-scope.server.ts): an ACTIVE membership in the org the
 * role or group belongs to. A rule that lives in each writer is a rule the
 * next writer forgets, so this scan DISCOVERS every write of a role
 * assignment (`app_user_roles`) or a group membership (`app_group_memberships`)
 * under `src/` and fails when the exported function or route handler holding
 * it does not ask the rule. Granularity is one top-level `export` up to the
 * next (the prelude before the first export is its own span), so a check in
 * one handler does not cover its sibling.
 *
 * Comments are stripped before matching, so a mention in a comment satisfies
 * nothing. Adding to EXEMPT should be a conscious, reviewed decision.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

const GRANT_WRITE =
  /\binsertInto\(\s*["'](?:app_user_roles|app_group_memberships)["']\s*\)|\binsert\s+into\s+"?(?:app_user_roles|app_group_memberships)\b/i;
const ELIGIBILITY_CALL = /\b(?:grantEligibleUserIds|userIsGrantEligible)\s*\(/;

/** The writers the scan must find, so it cannot pass by finding nothing. */
const KNOWN_WRITERS = [
  "app/api/administrator/groups/[id]/members/route.ts",
  "app/api/administrator/users/[id]/app-roles/route.ts",
  "app/api/administrator/users/[id]/groups/route.ts",
  "lib/invitations.server.ts",
];

const EXEMPT: Record<string, string> = {
  // Neither seed is reachable from a request: an operator runs it.
  //
  // default-admin does NOT follow the grant rule, by design. Its `created`
  // outcome forces the default-org membership active before the grants, but
  // `reconciled` and `adopted` insert the membership only when it is missing
  // and otherwise leave it as found (review #18: the seed never lifts an
  // administrator's block), and still write the admin, admin.platform and
  // superuser grants. On a blocked or suspended seed admin those confer
  // nothing until the membership is restored. What decides that account is
  // the seed's provenance gate (see its module docblock), not this rule.
  "db/seeds/default-admin.ts":
    "bootstrap superadmin: provenance-gated grants (review #18); an existing membership is left as found",
  // dev-init forces each membership active just before it writes the role,
  // and adds its demo users only to groups of their own org.
  "db/seeds/dev-init.ts": "local demo data: memberships forced active, then their roles and groups",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(SRC_DIR, file).split(sep).join("/");
}

/** Source with comments blanked out (same length, so offsets are preserved). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The prelude, then each top-level `export` up to the next one. */
function exportSpans(source: string): string[] {
  const starts = [0, ...[...source.matchAll(/^export\s/gm)].map((m) => m.index)];
  return starts.map((start, i) => source.slice(start, starts[i + 1] ?? source.length));
}

/** The policy, for one comment-stripped module: spans that write a grant unasked. */
function unaskedWrites(source: string): string[] {
  return exportSpans(source)
    .filter((span) => GRANT_WRITE.test(span) && !ELIGIBILITY_CALL.test(span))
    .map((span) => span.slice(0, 60).replace(/\s+/g, " ").trim());
}

const modules = walk(SRC_DIR).map((file) => ({
  file: rel(file),
  source: stripComments(readFileSync(file, "utf8")),
}));
const writers = modules.filter(({ source }) => GRANT_WRITE.test(source));

describe("F-154: every grant write asks the one eligibility rule", () => {
  it("discovers the grant writers (the scan is not vacuous)", () => {
    expect(writers.map((m) => m.file)).toEqual(expect.arrayContaining(KNOWN_WRITERS));
  });

  it("every exported function or handler that writes a grant asks the rule", () => {
    const offenders = writers
      .filter(({ file }) => !(file in EXEMPT))
      .flatMap(({ file, source }) => unaskedWrites(source).map((span) => `${file}: ${span}`));
    expect(offenders).toEqual([]);
  });

  it("every EXEMPT entry still writes a grant (no stale exemptions)", () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(
        writers.map((m) => m.file),
        file,
      ).toContain(file);
    }
  });

  it("the policy flags an unasked write and accepts an asked one (scanner self-test)", () => {
    const unasked = [
      'export const POST = async () => { await db.insertInto("app_user_roles").values(v); };',
      "export const DELETE = async () => { await userIsGrantEligible(u, o); };",
    ].join("\n");
    expect(unaskedWrites(unasked)).toHaveLength(1);
    const asked = [
      "export const POST = async () => {",
      "  const ok = await grantEligibleUserIds(o, ids);",
      '  await db.insertInto("app_group_memberships").values(v);',
      "};",
    ].join("\n");
    expect(unaskedWrites(asked)).toEqual([]);
  });
});
