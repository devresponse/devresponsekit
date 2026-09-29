import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * F-58 — AN AUTHENTICATED CALLER'S 403 LEAVES A `denied` ROW.
 *
 * docs/admin-manager.md §12 makes an audit row mandatory for denied access.
 * The permission pipeline and the rank guard wrote one, but the privilege
 * guards inside the handlers did not: the AUTHZ-3 / REVOKE-1 conferral test at
 * twelve sites, the AUTHZ-2 shared-target rule on eight `users/[id]` handlers
 * and the superadmin-only (`hasCrossOrgReach`) gates, the Better Auth platform
 * role among them, each returned a bare 403. An org admin trying to add
 * themselves to a group conferring `superuser` left no trace, so the explorer's
 * `denied` filter missed the most direct escalation signal the platform has.
 *
 * This is the counterpart of pre-auth-refusals-not-audited.test.ts (F-15): a
 * refusal decided BEFORE the caller is verified is logged, never audited; one
 * decided AFTER is audited. The scan walks every route handler under
 * `src/app/api/administrator` and fails when a 403 is returned with neither:
 *
 *   - a `denied` audit write earlier in the same block (`auditEvent` with
 *     `outcome: "denied"`, `auditUserAction` / `auditOrgAction` /
 *     `auditRoleAction` with `"denied"`, or `auditCreationRefusal`), nor
 *   - a `logPreAuthRefusal` there (the F-15 origin guard's shape).
 *
 * A refusal returned through an auditing helper (`refuseUnconferrable`,
 * `refuseSharedTarget`, `refuseWithoutCrossOrgReach` in
 * src/lib/admin/refusals.server.ts, `refuseOutrankingTarget`) never builds a
 * 403 in the handler, so the scan does not see it;
 * tests/unit/admin-refusals-server.test.ts pins that each helper writes its
 * row, and the route suites pin each call site. Neither does the pipeline's
 * `guard.response`, which `requireAdminPermission` audits for a missing
 * permission but not for its status gate (a caller whose status or membership
 * is not active): that 403 writes no row, the one authenticated exception
 * docs/admin-manager.md §12 names.
 *
 * A 403 on a branch no admitted caller can reach is listed in
 * {@link UNREACHABLE}, keyed by handler and condition, with the reason; an entry
 * whose branch is gone, or now audits, fails the scan too.
 *
 * It walks the TypeScript AST, so a comment quoting a call is not a call.
 */

const ADMIN_ROUTES = fileURLToPath(new URL("../../src/app/api/administrator", import.meta.url));

/**
 * `<route file relative to src/app/api/administrator> <handler>` → the
 * condition of an `if` whose 403 no caller admitted by `requireAdminPermission`
 * reaches (whitespace collapsed), with why. The pipeline admits an ACTIVE
 * provisioned user with an ACTIVE membership only (`decideSecureAccess`), so
 * `guard.access.appUserId` is set and a confined caller's `resolveOrgScope` has
 * an org. These branches are defence in depth and write no row.
 */
const UNREACHABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "api-keys/route.ts POST": {
    "!actorAppUserId": "the pipeline admits only a provisioned user, so appUserId is set",
  },
  "api-keys/[id]/route.ts DELETE": {
    "!actorAppUserId": "the pipeline admits only a provisioned user, so appUserId is set",
  },
  "api-keys/[id]/rotate/route.ts POST": {
    "!actorAppUserId": "the pipeline admits only a provisioned user, so appUserId is set",
  },
  "mcp-agents/[id]/route.ts DELETE": {
    "!actorAppUserId": "the pipeline admits only a provisioned user, so appUserId is set",
  },
  "email/test/route.ts POST": {
    "!scope": "the pipeline admits only an active member, whose context names an org",
  },
  "groups/route.ts POST": {
    "!scope": "the pipeline admits only an active member, whose context names an org",
    "!org || !canAccessOrg(guard.access, organizationId)":
      "a confined caller creates in its own org, which exists and which it can access; a caller " +
      "with cross-org reach gets the 404 arm, so the 403 arm needs the org to vanish mid-request",
  },
  "users/route.ts POST": {
    "!scope": "the pipeline admits only an active member, whose context names an org",
  },
};

const AUDIT_HELPERS = new Set(["auditUserAction", "auditOrgAction", "auditRoleAction"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A status argument that is, or may be, 403 (`403`, `cond ? 404 : 403`). */
function mayBe403(status: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  return status !== undefined && /\b403\b/.test(status.getText(sf));
}

/** Whether `node` contains a `denied` audit write or a pre-auth refusal log. */
function recordsTheRefusal(node: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === "logPreAuthRefusal" || name === "auditCreationRefusal") found = true;
      else if (name && AUDIT_HELPERS.has(name)) {
        const outcome = n.arguments[1];
        found =
          outcome !== undefined && ts.isStringLiteralLike(outcome) && outcome.text === "denied";
      } else if (name === "auditEvent") {
        const row = n.arguments[0];
        found =
          row !== undefined &&
          ts.isObjectLiteralExpression(row) &&
          row.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              p.name.getText(sf) === "outcome" &&
              ts.isStringLiteralLike(p.initializer) &&
              p.initializer.text === "denied",
          );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The nearest named function around `node`: the handler for `withAdminRoute(async function POST(…))`. */
function handlerOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.text;
  }
  return "<module>";
}

interface Refusal {
  where: string;
  line: number;
  /** The guarding `if` condition, whitespace collapsed; `""` when none. */
  condition: string;
  recorded: boolean;
  call: string;
}

/**
 * Every 403 a source builds: each `adminErrorResponse(code, <403>, …)` call,
 * judged by the block its `return` sits in. A 403 that is not returned directly
 * (stored, passed on) is reported unrecorded, since the scan cannot follow it.
 */
function refusalsIn(rel: string, text: string): Refusal[] {
  const sf = parse(rel, text);
  const out: Refusal[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      calleeName(node) === "adminErrorResponse" &&
      mayBe403(node.arguments[1], sf)
    ) {
      let ret: ts.Node | undefined = node.parent;
      while (ret && !ts.isReturnStatement(ret) && !ts.isFunctionLike(ret)) ret = ret.parent;
      let recorded = false;
      let condition = "";
      if (ret && ts.isReturnStatement(ret)) {
        const holder = ret.parent;
        if (ts.isBlock(holder)) {
          const before = holder.statements.slice(0, holder.statements.indexOf(ret));
          recorded = before.some((s) => recordsTheRefusal(s, sf));
          if (ts.isIfStatement(holder.parent) && holder.parent.thenStatement === holder) {
            condition = squash(holder.parent.expression.getText(sf));
          }
        } else if (ts.isIfStatement(holder)) {
          condition = squash(holder.expression.getText(sf));
        }
      }
      out.push({
        where: `${rel} ${handlerOf(node)}`,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        condition,
        recorded,
        call: squash(node.getText(sf)).slice(0, 120),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A 403 built without `adminErrorResponse` (`NextResponse.json(…, { status: 403 })`) escapes the AST rule. */
const RAW_403 = /\bstatus\s*:\s*403\b/;

const ROUTES = walk(ADMIN_ROUTES).map((full) => {
  const rel = relative(ADMIN_ROUTES, full).replace(/\\/g, "/");
  return { rel, text: readFileSync(full, "utf8") };
});
const REFUSALS = ROUTES.flatMap(({ rel, text }) => refusalsIn(rel, text));

const isExempt = (r: Refusal) => Object.hasOwn(UNREACHABLE[r.where] ?? {}, r.condition);

describe("F-58: every authenticated 403 in the admin console writes a denied row (source scan)", () => {
  it("walks the real admin surface (the scan is not vacuous)", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    const wheres = new Set(REFUSALS.map((r) => r.where));
    for (const expected of [
      // Already audited before F-58: the shapes the scan must accept.
      "groups/[id]/route.ts DELETE",
      "users/[id]/memberships/route.ts DELETE",
      "organizations/[id]/provider-bindings/route.ts POST",
      "users/[id]/impersonate/route.ts POST",
      "api-keys/[id]/rotate/route.ts POST",
      // The F-15 pre-auth refusal (logged, not audited).
      "users/[id]/impersonate/route.ts DELETE",
    ]) {
      expect(wheres, expected).toContain(expected);
    }
    // Recorded 403s and reviewed unreachable ones, both present.
    expect(REFUSALS.filter((r) => r.recorded).length).toBeGreaterThan(10);
    expect(REFUSALS.some(isExempt)).toBe(true);
  });

  it("each 403 writes a denied row (or logs a pre-auth refusal) before it returns", () => {
    const offenders = REFUSALS.filter((r) => !r.recorded && !isExempt(r)).map(
      (r) => `${r.where}:${r.line}  if (${r.condition})  ${r.call}`,
    );
    expect(
      offenders,
      "return one of the auditing refusals in src/lib/admin/refusals.server.ts, or write the " +
        "`denied` row just before the 403 (see DELETE /groups/[id]); an unreachable branch goes " +
        "in UNREACHABLE with its reason",
    ).toEqual([]);
  });

  it("names only live unreachable branches, each with a reason", () => {
    for (const [where, conditions] of Object.entries(UNREACHABLE)) {
      for (const [condition, why] of Object.entries(conditions)) {
        expect(why.trim().length, `${where} if (${condition}) needs a reason`).toBeGreaterThan(0);
        expect(
          REFUSALS.some((r) => r.where === where && r.condition === condition && !r.recorded),
          `${where} no longer returns an unrecorded 403 under if (${condition}) — drop the entry`,
        ).toBe(true);
      }
    }
  });

  it("builds every 403 through adminErrorResponse, where the scan can see it", () => {
    const raw = ROUTES.filter(({ text }) => RAW_403.test(text)).map(({ rel }) => rel);
    expect(raw).toEqual([]);
  });
});

describe("F-58: the scan catches every shape it claims (negative control)", () => {
  const wrap = (body: string) =>
    `export const POST = withAdminRoute(async function POST(request) {\n${body}\n});`;
  const unrecorded = (body: string) =>
    refusalsIn("planted/route.ts", wrap(body)).filter((r) => !r.recorded);

  it.each([
    ["a bare 403", `if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);`],
    [
      "a 403 in a braced block with no audit",
      `if (await requiresSuperadminForSharedTarget(scope, id)) {
         return adminErrorResponse("forbidden", 403, request);
       }`,
    ],
    [
      "a 403 whose audit is written after it",
      `if (x) {
         return adminErrorResponse("forbidden", 403, request);
         await auditUserAction("admin.user.action_denied", "denied", { organizationId: null });
       }`,
    ],
    [
      "a 403 whose audit is in another branch",
      `if (a) { await auditEvent({ eventType: "x", outcome: "denied", organizationId: null }); }
       if (b) { return adminErrorResponse("forbidden", 403, request); }`,
    ],
    [
      "a 403 after a success row",
      `if (x) {
         await auditOrgAction("admin.group.updated", "success", { organizationId: o });
         return adminErrorResponse("forbidden", 403, request);
       }`,
    ],
    [
      "a 403 after a failure row",
      `if (x) {
         await auditUserAction("admin.user.impersonation_failed", "failure", { organizationId: o });
         return adminErrorResponse("forbidden", 403, request);
       }`,
    ],
    [
      "a conditional 403",
      `if (!org) return adminErrorResponse(reach ? "not_found" : "forbidden", reach ? 404 : 403, request);`,
    ],
    [
      "a 403 that is not returned",
      `const refusal = adminErrorResponse("forbidden", 403, request);`,
    ],
  ])("reports %s", (_shape, body) => {
    expect(unrecorded(body)).toHaveLength(1);
  });

  it.each([
    [
      "a denied helper row",
      `if (x) {
         await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", { organizationId: o });
         return adminErrorResponse("forbidden", 403, request);
       }`,
    ],
    [
      "a denied auditEvent",
      `if (x) {
         await auditEvent({ eventType: "admin.api_key.create_denied", outcome: "denied", organizationId: o });
         return adminErrorResponse("forbidden", 403, request, { requestId });
       }`,
    ],
    [
      "a creation refusal",
      `if (refusal) {
         await auditCreationRefusal(refusal, { request });
         return adminErrorResponse("forbidden", 403, request);
       }`,
    ],
    [
      "a pre-auth refusal (F-15)",
      `if (!origin.ok) {
         logPreAuthRefusal({ eventType: "administrator.access.denied", outcome: "denied" });
         return adminErrorResponse("untrusted_origin", 403, request);
       }`,
    ],
    [
      "an auditing refusal helper",
      `if (unheld.length > 0) return refuseUnconferrable(guard, request, { action: "x" });`,
    ],
    ["a 404", `if (!row) return adminErrorResponse("not_found", 404, request);`],
    [
      "a comment quoting a bare 403",
      `// was: return adminErrorResponse("forbidden", 403, request);
       return refuseSharedTarget(guard, target, request, "ban");`,
    ],
  ])("does not report %s", (_shape, body) => {
    expect(unrecorded(body)).toEqual([]);
  });

  it("keys a refusal by its handler and guarding condition", () => {
    const [refusal] = refusalsIn(
      "x/route.ts",
      `export const DELETE = withAdminRoute(async function DELETE(request) {
         if (!actorAppUserId) {
           return adminErrorResponse("forbidden", 403, request);
         }
       });`,
    );
    expect(refusal).toMatchObject({
      where: "x/route.ts DELETE",
      condition: "!actorAppUserId",
      recorded: false,
    });
  });

  it("sees a 403 built without adminErrorResponse", () => {
    expect(RAW_403.test(`return NextResponse.json({ error: "forbidden" }, { status: 403 });`)).toBe(
      true,
    );
    expect(RAW_403.test(`return NextResponse.json(body, { status: 404 });`)).toBe(false);
  });
});
