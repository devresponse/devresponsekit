import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin/permissions";
import { calleeName, parseSource, pathBelow } from "../helpers/handler-scan";

/**
 * F-69: every key in the admin permission catalog is ENFORCED somewhere.
 *
 * `admin.orgs.manage` ("Manage organization members and bindings") sat in the
 * catalog, the seed and the bearer-scope list while no guard checked it: the
 * member, invitation and provider-binding writes gated on `admin.orgs.update`.
 * A role an operator built from the catalog text then did something else than
 * it said: `.manage` granted nothing, and `.update` granted people management.
 * A catalog key is a promise to whoever builds a role or mints a scoped key, so
 * each one must reach at least one guard, or be listed in RESERVED with the
 * reason it is advertised anyway.
 *
 * A guard is the permission argument of one of the calls that decide access:
 * `requireAdminPermission` (administrator routes), `requireApiPermission` (v1)
 * and `checkAdminPermissionServer` (RSC pages), as a string literal or a string
 * literal in an array literal. A UI flag (`permissions.includes(…)`) hides a
 * control and enforces nothing, and a rate-limit bucket or a comment that
 * happens to spell a key is not a check, so none of those count.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** Guard call → index of its permission argument. */
const GUARD_PERMISSION_ARG: Readonly<Record<string, number>> = {
  requireAdminPermission: 1,
  requireApiPermission: 1,
  checkAdminPermissionServer: 0,
};

/**
 * Catalog keys advertised without a guard, each with the reason. Empty: F-69
 * put `admin.orgs.manage` on the routes it describes rather than here.
 */
const RESERVED: Readonly<Record<string, string>> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The literal permission keys `sf`'s guard calls check. */
function guardedKeys(sf: ts.SourceFile): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const index = name === undefined ? undefined : GUARD_PERMISSION_ARG[name];
      const arg = index === undefined ? undefined : node.arguments[index];
      if (arg && ts.isStringLiteralLike(arg)) keys.push(arg.text);
      if (arg && ts.isArrayLiteralExpression(arg)) {
        for (const element of arg.elements) {
          if (ts.isStringLiteralLike(element)) keys.push(element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

describe("F-69: every admin permission catalog key is enforced by a guard", () => {
  const catalog = ADMIN_PERMISSION_CATALOG.map((p) => p.key);
  /** key → the files whose guards check it. */
  const guards = new Map<string, string[]>();
  for (const full of walk(SRC_DIR)) {
    const sf = parseSource(full, readFileSync(full, "utf8"));
    for (const key of guardedKeys(sf)) {
      guards.set(key, [...(guards.get(key) ?? []), pathBelow(SRC_DIR, full)]);
    }
  }

  it("discovers the guards (regression guard for the walk)", () => {
    const total = [...guards.values()].reduce((n, files) => n + files.length, 0);
    expect(total).toBeGreaterThan(120);
  });

  it("counts only the permission argument of a guard call", () => {
    const planted = parseSource(
      "planted.ts",
      [
        `// requireAdminPermission(request, "comment.key")`,
        `const a = await requireAdminPermission(request, "route.key");`,
        `const b = await checkAdminPermissionServer(["page.one", "page.two"]);`,
        `const c = await requireApiPermission(request, "v1.key");`,
        `const d = access.permissions.includes("ui.flag");`,
        `enforceRateLimit("bucket.key", id, LIMIT, request, requestId);`,
        `const e = await requireAdminPermission(request, SOME_CONSTANT);`,
      ].join("\n"),
    );
    expect(guardedKeys(planted)).toEqual(["route.key", "page.one", "page.two", "v1.key"]);
  });

  it("names a guard for every catalog key that is not reserved", () => {
    const unenforced = catalog.filter((key) => !guards.has(key) && !(key in RESERVED));
    expect(
      unenforced,
      "these catalog keys gate nothing: guard the action the catalog says they grant, " +
        "or list them in RESERVED with the reason",
    ).toEqual([]);
  });

  it("keeps RESERVED to catalog keys that really are unguarded", () => {
    for (const key of Object.keys(RESERVED)) {
      expect(catalog, `RESERVED names ${key}, which is not a catalog key`).toContain(key);
      expect(guards.get(key), `RESERVED names ${key}, which a guard now checks`).toBeUndefined();
    }
  });

  it("guards only on catalog keys (a misspelt key admits nobody but a superadmin)", () => {
    const unknown = [...guards.keys()].filter((key) => !catalog.includes(key));
    expect(
      unknown.map((key) => `${key} in ${guards.get(key)?.join(", ")}`),
      "these guards check a key the catalog does not define",
    ).toEqual([]);
  });
});
