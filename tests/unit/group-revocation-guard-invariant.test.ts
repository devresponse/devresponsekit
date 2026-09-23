import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-11 — systemic guard for REVOKE-1 on the group revocation family.
 *
 * Group membership confers the union of the group's roles (ADR-0002), so any
 * statement that deletes an `app_groups`, `app_group_memberships` or
 * `app_group_roles` row takes authority away from someone, and REVOKE-1 says
 * an actor may only take away what they could have conferred. That rule lives
 * in each route handler (there is no shared chokepoint every group mutation
 * passes through), and it had been written into three of the four handlers:
 * `DELETE /groups/[id]`, the widest of them, shipped without it. This scan
 * fails CI when a handler deletes group authority without the AUTHZ-3 subset
 * test wired the P1-1 way, so the next route cannot repeat that.
 *
 * It also covers the tables whose FOREIGN-KEY CASCADE removes group rows, each
 * with the reviewed guard that makes the cascade take nobody's authority.
 *
 * Granularity is the exported handler: the source from `export async function
 * X` (or `export const <METHOD> =`) to the next one. A delete counts in any
 * form, aliased, in an array or as raw SQL. A group delete outside every
 * handler (a helper above the first export) or outside a route file is
 * reported too, since the scan cannot see which guard runs before it.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");

/**
 * A delete of rows in any of `tables`, in every form that can issue one: the
 * Kysely builder with a bare name, an aliased name (`"t as x"`) or an array of
 * them, and raw SQL (`DELETE FROM t`). An alias or array must not be a way
 * past the scan.
 */
function deleteOf(tables: ReadonlyArray<string>): RegExp {
  const names = tables.join("|");
  return new RegExp(
    String.raw`\bdeleteFrom\(\s*(?:\[[^\]]*?)?["'\x60](?:${names})(?:\s+as\s+\w+)?["'\x60]` +
      String.raw`|\bdelete\s+from\s+"?(?:${names})\b`,
    "i",
  );
}

/** A direct delete of a row that confers group authority. */
const GROUP_AUTHORITY_DELETE = deleteOf(["app_groups", "app_group_memberships", "app_group_roles"]);

/** The REVOKE-1 conferral guard, as every group revocation twin wires it. */
const CONFERRAL_GUARD: ReadonlyArray<[RegExp, string]> = [
  [/\bunheldPermissionKeys\s*\(/, "unheldPermissionKeys(...)"],
  // P1-1: a bearer credential confers only within its scopes...
  [/\bconferrablePermissions\s*\(/, "conferrablePermissions(...)"],
  // ...and never takes the SUPERADMIN fast-path.
  [/grantedScopes\s*===\s*null/, "the `grantedScopes === null` qualifier on the superadmin skip"],
];

/**
 * Parents whose ON DELETE CASCADE removes group rows, and the guard that keeps
 * each cascade from destroying anyone's group-conferred authority. `null`
 * means no handler may delete the parent at all today.
 */
const CASCADE_PARENTS: Record<string, { guards: RegExp[] | null; why: string }> = {
  // app_group_roles.role_id → app_roles ON DELETE CASCADE
  app_roles: {
    guards: [/\bassertRoleNotInUse\s*\(/],
    why: "role delete is refused (409 role_in_use) while any group still bundles the role",
  },
  // app_groups.organization_id → app_organizations ON DELETE CASCADE
  app_organizations: {
    guards: [/\bhasCrossOrgReach\s*\(/, /\bassertOrgEmpty\s*\(/],
    why: "tenant delete is superadmin-only and refused while the org has any membership, so its groups confer nothing",
  },
  // app_group_memberships.app_user_id → app_users ON DELETE CASCADE. There is
  // no hard user delete (soft delete only); one would need its own guard.
  app_users: {
    guards: null,
    why: "no hard user delete exists; adding one cascades every group membership the user holds",
  },
};

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

interface Handler {
  where: string;
  body: string;
}

/**
 * Split a route file into its exported handlers, plus the preamble before them.
 * A handler is an exported function, or an HTTP-method `export const` (the
 * `export const DELETE = async (...) => ...` form), so neither shape can hide
 * a delete inside the previous handler's body.
 */
function handlersOf(rel: string, source: string): { preamble: string; handlers: Handler[] } {
  const exportRe =
    /^export\s+(?:(?:async\s+)?function\s+(\w+)|const\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b)/gm;
  const starts = [...source.matchAll(exportRe)].map((m) => ({
    name: (m[1] ?? m[2])!,
    at: m.index!,
  }));
  const preamble = source.slice(0, starts[0]?.at ?? source.length);
  const handlers = starts.map((s, i) => ({
    where: `${rel} ${s.name}`,
    body: source.slice(s.at, starts[i + 1]?.at ?? source.length),
  }));
  return { preamble, handlers };
}

// Runtime code only: migrations and seeds are operator tooling, not a request path.
const sources = walk(SRC_DIR, (name) => /\.(ts|tsx)$/.test(name))
  .filter((file) => !relative(SRC_DIR, file).split(sep).join("/").startsWith("db/"))
  .map((file) => ({
    file,
    rel: relative(SRC_DIR, file).split(sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));

const routes = walk(API_ROUTES_DIR, (name) => name === "route.ts").map((file) => {
  const rel = relative(API_ROUTES_DIR, file).split(sep).join("/");
  return { rel, ...handlersOf(rel, readFileSync(file, "utf8")) };
});
const allHandlers = routes.flatMap((r) => r.handlers);
const groupRevokers = allHandlers.filter((h) => GROUP_AUTHORITY_DELETE.test(h.body));

describe("group revocation guard invariant (REVOKE-1, F-11)", () => {
  it("recognises every way to write a group delete (an alias or array is no way past it)", () => {
    for (const stmt of [
      `db.deleteFrom("app_groups").where("id", "=", id)`,
      `trx.deleteFrom('app_group_memberships')`,
      "db.deleteFrom(`app_group_roles`)",
      `db.deleteFrom("app_groups as g").where("g.id", "=", id)`,
      `db.deleteFrom(["app_audit_log", "app_group_roles as gr"])`,
      `db.deleteFrom(\n  "app_group_memberships",\n)`,
      "sql`DELETE FROM app_group_memberships WHERE group_id = ${id}`",
      `sql\`delete from "app_groups" where id = \${id}\``,
    ]) {
      expect(GROUP_AUTHORITY_DELETE.test(stmt), stmt).toBe(true);
    }
    for (const stmt of [
      `db.deleteFrom("app_role_permissions")`,
      `db.deleteFrom("app_groups_archive")`,
      `db.selectFrom("app_groups as g")`,
      `db.insertInto("app_group_roles")`,
    ]) {
      expect(GROUP_AUTHORITY_DELETE.test(stmt), stmt).toBe(false);
    }
    expect(deleteOf(["app_roles"]).test(`db.deleteFrom("app_roles as r")`)).toBe(true);
    expect(deleteOf(["app_roles"]).test(`db.deleteFrom("app_role_permissions")`)).toBe(false);
  });

  it("splits `export const <METHOD>` handlers too, so a delete cannot hide in the previous body", () => {
    const { preamble, handlers } = handlersOf(
      "x/route.ts",
      [
        `import { db } from "@/db/database";`,
        `export const dynamic = "force-dynamic";`,
        `export async function GET() { unheldPermissionKeys(a, b); }`,
        `export const DELETE = async () => { await db.deleteFrom("app_groups").execute(); };`,
      ].join("\n"),
    );
    expect(preamble).not.toMatch(GROUP_AUTHORITY_DELETE);
    expect(handlers.map((h) => h.where)).toEqual(["x/route.ts GET", "x/route.ts DELETE"]);
    expect(handlers[0]!.body).not.toMatch(GROUP_AUTHORITY_DELETE);
    expect(handlers[1]!.body).toMatch(GROUP_AUTHORITY_DELETE);
  });

  it("finds the group revocation handlers (the scan is not vacuous)", () => {
    expect(groupRevokers.map((h) => h.where)).toEqual(
      expect.arrayContaining([
        "administrator/groups/[id]/route.ts DELETE",
        "administrator/groups/[id]/members/route.ts DELETE",
        "administrator/groups/[id]/roles/route.ts DELETE",
        "administrator/users/[id]/groups/route.ts DELETE",
      ]),
    );
  });

  it("every handler that deletes group authority runs the conferral guard", () => {
    const offenders = groupRevokers.flatMap((h) =>
      CONFERRAL_GUARD.filter(([re]) => !re.test(h.body)).map(
        ([, what]) => `${h.where}: missing ${what}`,
      ),
    );
    expect(
      offenders,
      "run the REVOKE-1 subset test (see DELETE /groups/[id]/members) before the delete",
    ).toEqual([]);
  });

  it("no group authority is deleted outside a route handler", () => {
    const outsideHandlers = routes
      .filter((r) => GROUP_AUTHORITY_DELETE.test(r.preamble))
      .map((r) => `${r.rel} (before the first exported handler)`);
    const outsideRoutes = sources
      .filter((s) => !s.rel.startsWith("app/api/") || !s.rel.endsWith("/route.ts"))
      .filter((s) => GROUP_AUTHORITY_DELETE.test(s.source))
      .map((s) => s.rel);
    expect(
      [...outsideHandlers, ...outsideRoutes],
      "delete group rows inside the guarded handler, where this scan can see the guard",
    ).toEqual([]);
  });

  for (const [table, { guards, why }] of Object.entries(CASCADE_PARENTS)) {
    it(`a delete of ${table} (cascades group rows) keeps its reviewed guard: ${why}`, () => {
      const parentDelete = deleteOf([table]);
      // Not vacuous: a reviewed guard names a delete that really exists.
      if (guards !== null) {
        expect(allHandlers.some((h) => parentDelete.test(h.body))).toBe(true);
      }
      const offenders = [
        ...allHandlers
          .filter((h) => parentDelete.test(h.body))
          .filter((h) => guards === null || guards.some((re) => !re.test(h.body)))
          .map((h) => h.where),
        ...sources
          .filter((s) => !s.rel.startsWith("app/api/") || !s.rel.endsWith("/route.ts"))
          .filter((s) => parentDelete.test(s.source))
          .map((s) => s.rel),
      ];
      expect(offenders).toEqual([]);
    });
  }
});
