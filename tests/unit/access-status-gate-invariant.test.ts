import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  calleeName,
  parseSource,
  pathBelow,
  reachableCallsNamed,
  statementName,
  topLevelStatement,
} from "../helpers/handler-scan";

/**
 * I-15 systemic guard — the completeness critic for the STATUS GATE.
 *
 * `getUserAccessContext` answers "who is this and what do their roles grant";
 * it does NOT answer "may they act". A suspended or deactivated user, a
 * pending one, and a member whose membership was blocked all resolve with
 * their role permissions intact (a superuser grant still expands to the full
 * set), and the context says so only in `status` / `membershipStatus`. The
 * decision is `decideSecureAccess(status, membershipStatus)`, and every
 * surface has to apply it itself: the secure shell, the admin and v1 guards,
 * the account guard, the token endpoint, SSO launch, the navigation routes,
 * the docs assets. Twelve call sites and no chokepoint, so a new route that
 * does `const caller = await resolveCaller(req); if (isSuperadmin(caller.access))`
 * lets a blocked superadmin straight through (review #200).
 *
 * The permissions are NOT zeroed for a blocked context, deliberately:
 * `targetOutranksActor` reads a blocked TARGET's permissions so that a
 * lower-ranked admin cannot act on a suspended superadmin. So the rule is
 * enforced here instead: every module-scope declaration under `src/` that
 * calls an access-context loader must also reach a `decideSecureAccess` call
 * (in its own body or a same-file helper), or be listed below with the reason
 * it may skip it. It is checked per declaration, not per file, so one gated
 * function cannot cover for an ungated sibling (F-127).
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** Everything that hands out a principal's access context. */
const LOADERS = new Set([
  "getUserAccessContext",
  "getSessionAccessContext",
  "resolveCaller",
  "resolveCallerDetailed",
]);
const GATES = new Set(["decideSecureAccess"]);

/**
 * `<src-relative file>#<declaration>` → why that declaration may resolve an
 * access context without applying the status gate. An entry must name a
 * declaration that still calls a loader, or it fails as stale.
 */
const UNGATED: Record<string, string> = {
  // The loaders themselves: they answer "who", and every caller of theirs is
  // scanned here.
  "lib/session-access.server.ts#getSessionAccessContext":
    "the session loader itself (derives ImpersonatedBy from the session); its callers apply the gate",
  "lib/api-auth/resolve-caller.server.ts#resolveCaller":
    "the caller resolver itself; status and permission checks are the guard's (see its doc comment)",
  "lib/api-auth/resolve-caller.server.ts#resolveCallerDetailed":
    "the caller resolver itself; status and permission checks are the guard's (see its doc comment)",
  // Resolves someone OTHER than the caller, whose status is the point.
  "lib/admin/user-target.server.ts#targetOutranksActor":
    "reads the TARGET's permissions for the rank comparison, and must keep a blocked target's (review #200); the actor passed requireAdminPermission",
  // Re-pins a selector cookie, and reads and grants nothing.
  "app/api/preferences/active-org/apply/route.ts#GET":
    "sets the active_org SELECTOR cookie only to an org the caller is an ACTIVE member of (userHasActiveMembership); it reads no data and grants nothing, and the next secure request applies the gate",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** `names` plus the local aliases a module imports them under (`import { x as y }`). */
function localNames(sf: ts.SourceFile, names: ReadonlySet<string>): Set<string> {
  const out = new Set(names);
  for (const statement of sf.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) {
        if (names.has((spec.propertyName ?? spec.name).text)) out.add(spec.name.text);
      }
    }
  }
  return out;
}

interface LoaderUse {
  /** `<file>#<declaration>`. */
  key: string;
  line: number;
  loader: string;
  gated: boolean;
}

/** Every loader call in a source, with whether its module-scope declaration reaches the gate. */
function loaderUses(fileName: string, text: string): LoaderUse[] {
  const sf = parseSource(fileName, text);
  const loaders = localNames(sf, LOADERS);
  const gates = localNames(sf, GATES);
  const out: LoaderUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && loaders.has(calleeName(node) ?? "")) {
      const statement = topLevelStatement(node);
      out.push({
        key: `${fileName}#${statementName(sf, statement)}`,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        loader: calleeName(node)!,
        gated: reachableCallsNamed(sf, statement, gates).length > 0,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const USES = walk(SRC_DIR).flatMap((full) =>
  loaderUses(pathBelow(SRC_DIR, full), readFileSync(full, "utf8")),
);

describe("I-15: the scanner catches what the rule claims (negative control)", () => {
  const ungated = (source: string) =>
    loaderUses("planted.ts", source)
      .filter((u) => !u.gated)
      .map((u) => u.key);

  it("reports a route that trusts caller.access without the gate (review #200)", () => {
    expect(
      ungated(`export const GET = withAdminRoute(async function GET(request) {
        const caller = await resolveCaller(request);
        if (caller && isSuperadmin(caller.access)) return everything();
      });`),
    ).toEqual(["planted.ts#GET"]);
  });

  it("passes a gated caller, directly or through a same-file helper", () => {
    expect(
      ungated(`function allowed(a) { return decideSecureAccess(a.status, a.membershipStatus) === "allow"; }
        export async function GET() {
          const access = await getSessionAccessContext(session);
          if (!allowed(access)) return notFound();
        }
        export async function load(id) {
          const access = await getUserAccessContext(id);
          if (decideSecureAccess(access.status, access.membershipStatus) !== "allow") throw denied();
        }`),
    ).toEqual([]);
  });

  it("checks each declaration: a gated sibling does not cover for an ungated one", () => {
    expect(
      ungated(`export async function a(r) {
          const c = await resolveCallerDetailed(r);
          if (decideSecureAccess(c.caller.access.status, null) !== "allow") return;
        }
        export async function b(r) { const c = await resolveCallerDetailed(r); return c.caller.access.permissions; }`),
    ).toEqual(["planted.ts#b"]);
  });

  it("sees an aliased loader, and not a comment that names one", () => {
    expect(
      ungated(`import { getSessionAccessContext as loadAccess } from "@/lib/session-access.server";
        // getUserAccessContext(id) is not called here
        export async function GET() { return (await loadAccess(session)).permissions; }`),
    ).toEqual(["planted.ts#GET"]);
  });
});

describe("I-15: every access-context caller applies decideSecureAccess (or says why not)", () => {
  it("discovers the loader callers (the scan is not vacuous)", () => {
    // 20 calls when I-15 landed: the guards, the shell, the token endpoint,
    // SSO, the navigation and docs routes. A count far below that means the
    // walk or the callee match is broken, not that the surface shrank.
    expect(USES.length).toBeGreaterThan(15);
    expect(USES.filter((u) => u.gated).length).toBeGreaterThan(10);
  });

  it("names only declarations that still call a loader (no stale allowances)", () => {
    const callers = new Set(USES.map((u) => u.key));
    for (const [key, reason] of Object.entries(UNGATED)) {
      expect(reason.trim().length, `${key} needs a reason`).toBeGreaterThan(0);
      expect(
        callers.has(key),
        `UNGATED names ${key}, which no longer calls an access-context loader — drop the entry`,
      ).toBe(true);
    }
  });

  it("every other caller reaches decideSecureAccess", () => {
    const offenders = USES.filter((u) => !u.gated && UNGATED[u.key] === undefined).map(
      (u) => `${u.key} (line ${u.line}: ${u.loader})`,
    );
    expect(
      offenders,
      `These resolve an access context and never ask decideSecureAccess whether the principal ` +
        `may act. A blocked, suspended or pending principal still carries its role permissions ` +
        `(a superuser grant included), so a permission check alone lets it through. Apply ` +
        `decideSecureAccess(access.status, access.membershipStatus) and refuse anything but ` +
        `"allow", route through a guard that does (requireAdminPermission, requireApiPermission, ` +
        `requireAccountUser, requireSecureSession), or add a justified entry to UNGATED.`,
    ).toEqual([]);
  });
});
