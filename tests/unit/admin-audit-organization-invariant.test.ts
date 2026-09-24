import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * F-32 — every admin audit write decides which tenant's auditors see it.
 *
 * Each tenant-facing audit read (the explorer, a user's Audit tab, the CSV
 * export, `GET /api/v1/audit-events`) shows an org admin exactly the rows whose
 * `organization_id` is their org. About seventy administrator audit writes
 * named no org, so a delegated admin could set a member's password, rotate a
 * colleague's key and export the user list without the org's own auditors
 * seeing any of it. `organizationId` is now REQUIRED on the three helper
 * contexts, so the compiler catches a helper call that forgets it; nothing
 * catches a direct `auditEvent({...})` (its field stays optional for the
 * hundred non-admin callers), a spread that hides the field, or a `null` that
 * quietly makes a tenant's event a platform row. This scan does:
 *
 *   1. Every call to `auditEvent`, `auditUserAction`, `auditOrgAction` or
 *      `auditRoleAction` in the admin surfaces passes an object literal that
 *      names `organizationId` itself. A spread does not count: the scan cannot
 *      see through it, and neither can a reviewer.
 *   2. A literal `null` (or `undefined`) there is a PLATFORM row, visible to
 *      platform auditors only. It is allowed only for an event named, with its
 *      file and the reason, in {@link PLATFORM_EVENTS} (narrowed to one
 *      `reason` literal where only that refusal is platform-level). Any other expression
 *      (`actingOrganizationId(guard.access)`, `existing.organization_id`, a
 *      ternary) is a decision the call site made and passes.
 *   3. A negative control plants each shape in a synthetic source, so the
 *      scanner is shown to catch what rule 1 and rule 2 claim.
 *   4. The helpers keep the field required and pass it through, so rule 1's
 *      compile-time half cannot be switched off in one line.
 *
 * It walks the TypeScript AST, so a comment quoting a call is not a call.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** src-relative directories and files whose audit writes must decide an org. */
const SCANNED = [
  "app/api/administrator",
  "app/api/v1",
  "lib/admin",
  "lib/admin-status.server.ts",
  "lib/api-auth/v1-guard.server.ts",
] as const;

/** The audit writers, and the index of the argument that carries the row. */
const WRITERS = new Map<string, number>([
  ["auditEvent", 0],
  ["auditUserAction", 2],
  ["auditOrgAction", 2],
  ["auditRoleAction", 2],
]);

/**
 * `src-relative file` → event type → why it is written with no organization.
 * A platform row is shown to platform auditors only, so each entry must be an
 * action no single tenant owns. Keyed by file too, so the same event type
 * written elsewhere must still stamp an org.
 *
 * A key may also name ONE reason, `"<event type>#<reason>"`, when only that
 * refusal of the event is a platform row: it then excuses only a write whose
 * `reason` is that string literal, and every other write of the event type in
 * the file (another reason, no reason, a computed one) must still stamp an org.
 */
const PLATFORM_EVENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "app/api/administrator/auth-settings/defaults/route.ts": {
    "admin.platform.auth_policy_updated":
      "the platform-wide sign-up defaults every tenant inherits; superadmin only",
  },
  "app/api/administrator/email/templates/[id]/route.ts": {
    "admin.email.template_updated":
      "email templates are global (no organization_id), every tenant sends against them; superadmin only",
  },
  "app/api/administrator/permissions/route.ts": {
    "admin.permission.created": "the permission catalog is platform-wide; superadmin only",
  },
  "app/api/administrator/permissions/[id]/route.ts": {
    "admin.permission.updated": "the permission catalog is platform-wide; superadmin only",
    "admin.permission.delete_blocked": "the permission catalog is platform-wide; superadmin only",
    "admin.permission.deleted": "the permission catalog is platform-wide; superadmin only",
  },
  "app/api/administrator/users/[id]/role/route.ts": {
    "admin.user.role_set":
      "the Better Auth platform role is account-global and has no tenant; cross-org reach only (F-13)",
    "admin.user.set_role_failed":
      "the Better Auth platform role is account-global and has no tenant; cross-org reach only (F-13)",
  },
  "app/api/administrator/users/[id]/impersonate/route.ts": {
    "admin.user.impersonation_failed#nested_impersonation":
      "the top-of-handler nested-impersonation refusal: guard.access is the BORROWED identity's " +
      "and the requested id is an unresolved path segment, so no org can be derived safely (the " +
      "other refusals in the file stamp the actor's org, and this reason-keyed entry excuses " +
      "none of them)",
  },
  "lib/admin/rate-limit.server.ts": {
    "administrator.rate_limited":
      "the bucket and its once-a-minute denial sample are keyed on (scope, actor) across every " +
      "org the actor acts in, and the IP-keyed pre-auth floors reach it with no verified caller",
  },
};

interface Finding {
  line: number;
  eventType: string;
  /** The row's `reason` when it is a string literal; `undefined` otherwise. */
  reason: string | undefined;
  problem: "no_object_literal" | "no_organization_id" | "platform_row_not_allowed";
  call: string;
}

function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function propertyNamed(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  for (const p of obj.properties) {
    if (
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name
    ) {
      return p;
    }
  }
  return undefined;
}

/** A literal `null` / `undefined`, through parentheses and `as` casts. */
function isAbsentLiteral(node: ts.Expression): boolean {
  let e: ts.Expression = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined");
}

/** The event type as written: a string literal's text, else the expression source. */
function eventTypeOf(call: ts.CallExpression, sf: ts.SourceFile): string {
  const name = calleeName(call)!;
  let expr: ts.Expression | undefined;
  if (name === "auditEvent") {
    const obj = call.arguments[0];
    const prop =
      obj && ts.isObjectLiteralExpression(obj) ? propertyNamed(obj, "eventType") : undefined;
    expr = prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
  } else {
    expr = call.arguments[0];
  }
  if (!expr) return "<unknown>";
  return ts.isStringLiteralLike(expr) ? expr.text : expr.getText(sf);
}

/**
 * The row's `reason` when it is written as a string literal, else `undefined`
 * (absent, computed, or behind a spread): only a literal can match a
 * reason-keyed PLATFORM_EVENTS entry.
 */
function reasonOf(call: ts.CallExpression): string | undefined {
  const arg = call.arguments[WRITERS.get(calleeName(call)!)!];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  const prop = propertyNamed(arg, "reason");
  if (!prop || !ts.isPropertyAssignment(prop)) return undefined;
  return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
}

/** Whether `allowed` excuses a platform row of this event type and reason. */
function isAllowedPlatformRow(
  allowed: Readonly<Record<string, string>>,
  eventType: string,
  reason: string | undefined,
): boolean {
  return (
    Object.hasOwn(allowed, eventType) ||
    (reason !== undefined && Object.hasOwn(allowed, `${eventType}#${reason}`))
  );
}

/**
 * Rules 1 and 2 over one source. `allowed` is the event → reason map for this
 * file. Calls inside the helpers' own bodies (`audit-helpers.server.ts` passes
 * `ctx.organizationId` through) are ordinary calls and pass rule 1 like any
 * other.
 */
function auditWritesWithoutAnOrgDecision(
  fileName: string,
  text: string,
  allowed: Readonly<Record<string, string>> = {},
): Finding[] {
  const sf = parse(fileName, text);
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const argIndex = name === undefined ? undefined : WRITERS.get(name);
      if (argIndex !== undefined) {
        const eventType = eventTypeOf(node, sf);
        const reason = reasonOf(node);
        const report = (problem: Finding["problem"]) =>
          out.push({
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            eventType,
            reason,
            problem,
            call: node.getText(sf).replace(/\s+/g, " ").slice(0, 160),
          });
        const arg = node.arguments[argIndex];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          report("no_object_literal");
        } else {
          const org = propertyNamed(arg, "organizationId");
          if (!org) {
            report("no_organization_id");
          } else if (
            ts.isPropertyAssignment(org) &&
            isAbsentLiteral(org.initializer) &&
            !isAllowedPlatformRow(allowed, eventType, reason)
          ) {
            report("platform_row_not_allowed");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The PLATFORM_EVENTS keys a source's literal-null writes would match: each
 * such write's event type, and `<event type>#<reason>` when its reason is a
 * literal.
 */
function platformRowKeys(fileName: string, text: string): Set<string> {
  const all = auditWritesWithoutAnOrgDecision(fileName, text);
  return new Set(
    all
      .filter((f) => f.problem === "platform_row_not_allowed")
      .flatMap((f) =>
        f.reason === undefined ? [f.eventType] : [f.eventType, `${f.eventType}#${f.reason}`],
      ),
  );
}

const srcRelative = (full: string) => relative(SRC_DIR, full).replace(/\\/g, "/");

const SOURCES = SCANNED.flatMap((entry) => walk(join(SRC_DIR, entry)))
  .filter((full) => !/\.test\.tsx?$/.test(full))
  .map((full) => ({ rel: srcRelative(full), text: readFileSync(full, "utf8") }));

describe("F-32: every admin audit write names its organization (derived)", () => {
  it("walks the real audit surface (the scan is not vacuous)", () => {
    const writers = new Set(WRITERS.keys());
    let calls = 0;
    for (const { rel, text } of SOURCES) {
      const sf = parse(rel, text);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && writers.has(calleeName(node) ?? "")) calls += 1;
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    // 162 writes at F-32 (the auditUserAction sites, the org/role helper sites
    // and the direct auditEvent writes). A count this low means the walk or the
    // callee match broke, not that the surface shrank.
    expect(calls).toBeGreaterThan(120);
  });

  it("every write names organizationId, and a null one is a reviewed platform event", () => {
    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      for (const f of auditWritesWithoutAnOrgDecision(rel, text, PLATFORM_EVENTS[rel])) {
        const reason = f.reason === undefined ? "" : `#${f.reason}`;
        offenders.push(`${rel}:${f.line}  ${f.problem}  ${f.eventType}${reason}  ${f.call}`);
      }
    }
    expect(
      offenders,
      "pass `organizationId` explicitly: the resource's org for an org-owned row, " +
        "`actingOrganizationId(guard.access)` for an action on a user, or `null` only for " +
        "a platform event added to PLATFORM_EVENTS with its reason (docs/admin-manager.md §12)",
    ).toEqual([]);
  });

  it("names only live platform events, each with a reason", () => {
    for (const [file, events] of Object.entries(PLATFORM_EVENTS)) {
      const source = SOURCES.find((s) => s.rel === file);
      expect(
        source,
        `PLATFORM_EVENTS names ${file}, which is not scanned or does not exist`,
      ).toBeDefined();
      const written = platformRowKeys(file, source!.text);
      for (const [key, why] of Object.entries(events)) {
        expect(why.trim().length, `${file} ${key} needs a reason`).toBeGreaterThan(0);
        expect(
          written.has(key),
          `${file} no longer writes ${key} as a platform row — drop the entry`,
        ).toBe(true);
      }
    }
  });
});

describe("F-32: the scanner catches every shape it claims (negative control)", () => {
  const PLANTED: ReadonlyArray<[shape: string, source: string]> = [
    [
      "a helper call with no organizationId",
      `await auditUserAction("admin.user.updated", "success", {
         request, actorBetterAuthUserId: a, appUserId: target.appUserId,
       });`,
    ],
    [
      "a direct auditEvent with no organizationId (the pre-F-32 key revoke)",
      `await auditEvent({ eventType: "admin.api_key.revoked", outcome: "success",
         actorBetterAuthUserId: a, appUserId: existing.app_user_id, request });`,
    ],
    [
      "a null that is not a reviewed platform event",
      `await auditEvent({ eventType: "admin.export.completed", outcome: "success",
         organizationId: null, request });`,
    ],
    ["an undefined organization", `auditOrgAction("x", "success", { organizationId: undefined });`],
    [
      "a cast null",
      `auditRoleAction("x", "success", { organizationId: (null as string | null) });`,
    ],
    [
      "a spread that hides the field",
      `const base = { organizationId: orgId };
       await auditEvent({ ...base, eventType: "x", outcome: "success" });`,
    ],
    ["a row passed by reference", `const row = { eventType: "x" }; await auditEvent(row);`],
    [
      "a namespace-qualified writer",
      `await helpers.auditUserAction("x", "success", { request, appUserId: null });`,
    ],
    [
      "a lazily imported writer (the rate-limit sample's shape)",
      `void import("@/lib/audit.server").then(({ auditEvent }) =>
         auditEvent({ eventType: "x", outcome: "denied" }));`,
    ],
  ];

  it.each(PLANTED)("reports %s", (_shape, source) => {
    expect(auditWritesWithoutAnOrgDecision("planted.ts", source)).toHaveLength(1);
  });

  const CLEAN: ReadonlyArray<[shape: string, source: string]> = [
    [
      "the acting org",
      `await auditUserAction("admin.user.updated", "success", {
         request, actorBetterAuthUserId: a, appUserId: t, organizationId: actingOrganizationId(guard.access),
       });`,
    ],
    [
      "the resource's org",
      `await auditEvent({ eventType: "admin.api_key.revoked", outcome: "success",
         organizationId: existing.organization_id });`,
    ],
    [
      "a shorthand",
      `const organizationId = scopeOrganizationId(scope);
      await auditEvent({ eventType: "x", outcome: "success", organizationId });`,
    ],
    [
      "a decision that may be null",
      `await auditEvent({ eventType: "admin.app.updated", outcome: "success",
         organizationId: input.organization_id ?? existing.organization_id });`,
    ],
    [
      "a comment that quotes an unstamped call",
      `// was: auditEvent({ eventType: "x", outcome: "success" })
       await auditEvent({ eventType: "x", outcome: "success", organizationId: org.id });`,
    ],
    [
      "an unrelated call that shares no writer name",
      `await logPreAuthRefusal({ eventType: "x", outcome: "denied" });`,
    ],
  ];

  it.each(CLEAN)("does not report %s", (_shape, source) => {
    expect(auditWritesWithoutAnOrgDecision("clean.ts", source)).toEqual([]);
  });

  it("allows a null only for the event types the file's entry names", () => {
    const source = `await auditEvent({ eventType: "admin.permission.created", outcome: "success", organizationId: null });
      await auditEvent({ eventType: "admin.permission.renamed", outcome: "success", organizationId: null });`;
    const found = auditWritesWithoutAnOrgDecision("planted.ts", source, {
      "admin.permission.created": "platform-wide",
    });
    expect(found.map((f) => f.eventType)).toEqual(["admin.permission.renamed"]);
  });

  it("allows a null under a reason-keyed entry only for that literal reason", () => {
    // The impersonate route's shape: one refusal of the event is a platform
    // row, the others must stamp the actor's org and may not hide behind it.
    const source = `
      await auditEvent({ eventType: "admin.user.impersonation_failed", outcome: "denied",
        organizationId: null, reason: "nested_impersonation" });
      await auditUserAction("admin.user.impersonation_failed", "failure", {
        organizationId: null, reason: "nested_impersonation" });
      await auditUserAction("admin.user.impersonation_failed", "failure", {
        organizationId: null, reason: "privilege_escalation_in_shared_org" });
      await auditEvent({ eventType: "admin.user.impersonation_failed", outcome: "denied",
        organizationId: null });
      await auditEvent({ eventType: "admin.user.impersonation_failed", outcome: "denied",
        organizationId: null, reason: live ? "nested_impersonation" : "session_principal_mismatch" });
      await auditUserAction("admin.user.impersonation_started", "success", {
        organizationId: null, reason: "nested_impersonation" });`;
    const found = auditWritesWithoutAnOrgDecision("planted.ts", source, {
      "admin.user.impersonation_failed#nested_impersonation": "the borrowed identity's refusal",
    });
    expect(found.map((f) => [f.line, f.eventType, f.reason ?? "<not a literal>"])).toEqual([
      [6, "admin.user.impersonation_failed", "privilege_escalation_in_shared_org"],
      [8, "admin.user.impersonation_failed", "<not a literal>"],
      [10, "admin.user.impersonation_failed", "<not a literal>"],
      [12, "admin.user.impersonation_started", "nested_impersonation"],
    ]);
    // …and the entry is live only while that exact write exists.
    expect(platformRowKeys("planted.ts", source)).toContain(
      "admin.user.impersonation_failed#nested_impersonation",
    );
    expect(platformRowKeys("planted.ts", source)).not.toContain(
      "admin.user.impersonation_failed#bogus",
    );
  });
});

describe("F-32: the helpers keep organizationId required and pass it through", () => {
  const file = "lib/admin/audit-helpers.server.ts";
  const text = readFileSync(join(SRC_DIR, file), "utf8");
  const sf = parse(file, text);

  it.each(["UserAuditContext", "RoleAuditContext", "OrgAuditContext"])(
    "%s declares organizationId: string | null with no `?`",
    (name) => {
      let member: ts.PropertySignature | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
          member = node.members.find(
            (m): m is ts.PropertySignature =>
              ts.isPropertySignature(m) &&
              ts.isIdentifier(m.name) &&
              m.name.text === "organizationId",
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(member, `${name} has no organizationId`).toBeDefined();
      expect(member!.questionToken, `${name}.organizationId must stay required`).toBeUndefined();
      expect(member!.type?.getText(sf).replace(/\s+/g, "")).toBe("string|null");
    },
  );

  it("each helper forwards ctx.organizationId to auditEvent", () => {
    const forwarded = auditWritesWithoutAnOrgDecision(file, text);
    expect(forwarded).toEqual([]);
    expect(text.match(/organizationId: ctx\.organizationId,/g)).toHaveLength(3);
  });
});
