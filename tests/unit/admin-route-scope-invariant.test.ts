import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ADR-0001 systemic guard (docs/adr/0001-three-tier-access-control.md).
 *
 * Every route under `/api/administrator/**` serves tenant-scoped data, so
 * each MUST derive its org boundary from the single source of truth
 * (`@/lib/admin/access-scope.server`) — directly, or transitively via
 * `resolveTargetUser` (which takes the caller's access context and is
 * therefore org-scoped by construction).
 *
 * This is the "completeness critic": the cross-tenant P0s the enterprise
 * re-review found were all routes that simply forgot to call the scope
 * primitive. A point-in-time fix doesn't stop the NEXT route from
 * forgetting — this scan does. A new administrator route that touches the
 * DB without referencing a scope helper fails CI here, forcing the author
 * to either scope it or add a justified exemption below.
 *
 * The exemption list is deliberately tiny and each entry carries a reason.
 * Adding to it should be a conscious, reviewed decision — not a reflex to
 * make the test pass.
 */

const ADMIN_ROUTES_DIR = fileURLToPath(new URL("../../src/app/api/administrator", import.meta.url));

const SCOPE_MARKERS = [
  // The canonical org-boundary module.
  "@/lib/admin/access-scope.server",
  // resolveTargetUser(id, access) embeds canAccessUser — scoped by contract.
  "resolveTargetUser",
];

/**
 * Routes that legitimately need NO org scoping, each with a reason. These
 * are platform-global surfaces (identical for every tenant) whose writes
 * are independently confined to SUPERADMIN. Keep this list short.
 */
const EXEMPT: Record<string, string> = {
  // The email TEMPLATE catalog is platform-global config — identical for
  // every tenant, with no organization column — so reading the list is not a
  // cross-tenant leak. Editing a template (PUT under templates/[id]) affects
  // all tenants and IS SUPERADMIN-gated there, so templates/[id] is NOT
  // exempt; only this read-only list route is.
  "administrator/email/templates/route.ts":
    "platform-global template catalog (no tenant column); read-only list, edits are SUPERADMIN-gated in templates/[id]",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("ADR-0001: every administrator route is org-scoped", () => {
  const routeFiles = walk(ADMIN_ROUTES_DIR);

  it("discovers the administrator route handlers", () => {
    // Sanity check: if this drops to zero the glob/path is wrong and the
    // whole invariant would silently pass.
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [f.slice(f.indexOf("administrator")), f] as const))(
    "%s references a scope primitive (or is explicitly exempt)",
    (rel, full) => {
      const source = readFileSync(full, "utf8");
      const referencesScope = SCOPE_MARKERS.some((m) => source.includes(m));
      const exemptKey = Object.keys(EXEMPT).find((k) => full.replace(/\\/g, "/").endsWith(k));
      if (exemptKey) {
        // An exempt route is allowed to be unscoped, but its exemption must
        // carry a non-empty justification.
        expect((EXEMPT[exemptKey] ?? "").length).toBeGreaterThan(0);
        return;
      }
      expect(
        referencesScope,
        `${rel} touches tenant data but references no org-scope primitive. ` +
          `Derive its boundary from @/lib/admin/access-scope.server ` +
          `(canAccessOrg / canAccessUser / resolveOrgScope / isSuperadmin) ` +
          `or resolveTargetUser, or add a justified entry to EXEMPT.`,
      ).toBe(true);
    },
  );
});
