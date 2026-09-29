import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import en from "@/messages/en.json";
import { calleeName, parseSource, pathBelow } from "../helpers/handler-scan";

/**
 * F-129 (P3-12): the first-party JSON error contract, kept by enumeration.
 *
 * `adminErrorResponse` answers `{ error, message: "errors.<code>", requestId }`
 * plus `x-request-id`, and docs/admin-manager.md §5.1 promises a client can
 * localize `message` with `useTranslations("errors")`. Both halves had
 * drifted: the application switcher, SSO launch and an active-org refusal
 * still hand-rolled a bare `{ error }` (no `message`, no id in the body; a
 * blocked user's 403 wrote a `navigation.menu.denied` row whose id the body
 * never named), SSO consume had a third shape, and 28 codes the envelope
 * emitted had no `errors.*` key, so a client following the contract showed the
 * raw key path (`errors.organization_in_use`).
 *
 * Two scans, because a behavioural suite passes either omission:
 *
 *   1. No `src/app/api` file builds an error body itself: an object literal
 *      with an `error` member handed to `NextResponse.json` / `Response.json`,
 *      `JSON.stringify` or a local JSON helper. The first-party surfaces use
 *      `adminErrorResponse`, `/api/v1` uses `problemResponse`, and a file whose
 *      protocol owns the shape says why in EXEMPT.
 *   2. Every code `adminErrorResponse` is called with anywhere in `src/` has an
 *      `errors.<code>` key in `en.json` (tests/unit/locale-message-parity
 *      carries it to the other seven locales). The code is read from the
 *      call's first argument: a literal, a conditional of literals, an
 *      exported constant, an `AdminError`'s `.code` (the `AdminErrorCode`
 *      union), a parameter typed as a union of literals, or a destructured
 *      field whose literals the file assigns. An argument the scan cannot
 *      resolve fails the test rather than being skipped.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_DIR = join(SRC_DIR, "app", "api");
const APP_DIR = join(SRC_DIR, "app");

/** Files under src/app/api whose error bodies a protocol or a machine caller owns. */
const EXEMPT: Record<string, string> = {
  "api/mcp/register/route.ts":
    "RFC 7591 Dynamic Client Registration: errors are `{ error, error_description }` (§3.2.2)",
  "api/internal/outbox-drain/route.ts":
    "cron sink (CRON_SECRET): the scheduler reads the status; no person or client localizes it",
  "api/internal/mcp-registration-reap/route.ts":
    "cron sink (CRON_SECRET): the scheduler reads the status; no person or client localizes it",
};

/** Calls that put their argument on the wire as a JSON body. */
const BODY_CALLS = new Set(["json", "stringify", "noStore"]);

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function hasErrorMember(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "error",
  );
}

/** Each `{ error… }` literal the file hands to a body-building call, as `line: source`. */
function handRolledErrorBodies(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  visit(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node) || !hasErrorMember(node)) return;
    const parent = node.parent;
    const isBody =
      (ts.isCallExpression(parent) && BODY_CALLS.has(calleeName(parent) ?? "")) ||
      ts.isNewExpression(parent);
    if (!isBody) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${line + 1}: ${node.getText(sf).replace(/\s+/g, " ")}`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Scan 2: which codes reach `adminErrorResponse`.
// ---------------------------------------------------------------------------

const sourceFiles = walk(SRC_DIR, (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)).map(
  (full) => parseSource(full, readFileSync(full, "utf8")),
);

function stringLiterals(node: ts.Node | undefined): string[] | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isLiteralTypeNode(node)) return stringLiterals(node.literal);
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.map((t) => stringLiterals(t));
    return parts.every((p) => p !== null) ? (parts.flat() as string[]) : null;
  }
  return null;
}

/** `export const NAME = "literal"` anywhere under src/. */
const exportedConstants = new Map<string, string>();
/** `type Name = "a" | "b"` anywhere under src/ (names are unique enough here). */
const literalUnionTypes = new Map<string, string[]>();
for (const sf of sourceFiles) {
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const value = stringLiterals(decl.initializer);
        if (ts.isIdentifier(decl.name) && value?.length === 1) {
          exportedConstants.set(decl.name.text, value[0]!);
        }
      }
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      const members = stringLiterals(statement.type);
      if (members) literalUnionTypes.set(statement.name.text, members);
    }
  }
}

function resolveTypeNode(type: ts.TypeNode | undefined): string[] | null {
  if (type === undefined) return null;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return literalUnionTypes.get(type.typeName.text) ?? null;
  }
  return stringLiterals(type);
}

/** The declaration an identifier in `sf` refers to, by name, nearest scope first. */
function declarationOf(id: ts.Identifier): ts.Node | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find(
        (p) => ts.isIdentifier(p.name) && p.name.text === id.text,
      );
      if (param) return param;
    }
    let found: ts.Node | undefined;
    ts.forEachChild(scope, (child) => {
      if (found || !ts.isVariableStatement(child)) return;
      for (const decl of child.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === id.text) found = decl;
        if (ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === id.text) found = el;
          }
        }
      }
    });
    if (found) return found;
  }
  return undefined;
}

/** String literals the file assigns to an object property called `name`. */
function propertyLiterals(sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  visit(sf, (node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      out.push(...(stringLiterals(node.initializer) ?? []));
    }
  });
  return out;
}

function resolveCodes(expr: ts.Expression, sf: ts.SourceFile): string[] | null {
  const literal = stringLiterals(expr);
  if (literal) return literal;
  if (ts.isParenthesizedExpression(expr)) return resolveCodes(expr.expression, sf);
  if (ts.isConditionalExpression(expr)) {
    const a = resolveCodes(expr.whenTrue, sf);
    const b = resolveCodes(expr.whenFalse, sf);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "code") {
    // An `AdminError` narrowed by `instanceof`: its code is the union.
    return /\bAdminError\b/.test(sf.text)
      ? (literalUnionTypes.get("AdminErrorCode") ?? null)
      : null;
  }
  if (ts.isIdentifier(expr)) {
    const decl = declarationOf(expr);
    if (decl && ts.isParameter(decl)) return resolveTypeNode(decl.type);
    if (decl && ts.isBindingElement(decl)) {
      const codes = propertyLiterals(sf, expr.text);
      return codes.length > 0 ? codes : null;
    }
    if (decl && ts.isVariableDeclaration(decl)) {
      return stringLiterals(decl.initializer) ?? resolveTypeNode(decl.type);
    }
    return exportedConstants.has(expr.text) ? [exportedConstants.get(expr.text)!] : null;
  }
  return null;
}

interface EmittedCode {
  where: string;
  codes: string[] | null;
  argument: string;
}

function emittedCodes(): EmittedCode[] {
  const out: EmittedCode[] = [];
  for (const sf of sourceFiles) {
    visit(sf, (node) => {
      if (!ts.isCallExpression(node) || calleeName(node) !== "adminErrorResponse") return;
      const arg = node.arguments[0];
      if (!arg) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({
        where: `${pathBelow(SRC_DIR, sf.fileName)}:${line + 1}`,
        codes: resolveCodes(arg, sf),
        argument: arg.getText(sf),
      });
    });
  }
  return out;
}

describe("F-129: first-party API errors go through the shared envelope", () => {
  const routeFiles = walk(API_DIR, (name) => name.endsWith(".ts")).map((full) => ({
    rel: pathBelow(APP_DIR, full),
    sf: parseSource(full, readFileSync(full, "utf8")),
  }));

  it("names only real files in EXEMPT", () => {
    for (const key of Object.keys(EXEMPT)) {
      expect(
        routeFiles.some((f) => f.rel === key),
        `EXEMPT names ${key}, which no longer exists`,
      ).toBe(true);
    }
  });

  it("recognises a hand-rolled body in each shape (regression guard for the scan itself)", () => {
    const scan = (text: string) => handRolledErrorBodies(parseSource("x.ts", text)).length;
    expect(scan('return NextResponse.json({ error: "forbidden" }, { status: 403 });')).toBe(1);
    expect(
      scan("return NextResponse.json(\n  { error: code, requestId },\n  { status },\n);"),
    ).toBe(1);
    expect(scan("new Response(JSON.stringify({ error, error_description: d }));")).toBe(1);
    expect(scan('return noStore({ error: "unauthorized" }, 401);')).toBe(1);
    // Not a response body: log fields, a per-item result, a helper's return.
    expect(scan('logServerError("x", { error: message });')).toBe(0);
    expect(scan('results.push({ ok: false, error: "not_found" });')).toBe(0);
    expect(scan('return { error: "invalid_token", description: d };')).toBe(0);
  });

  it.each(routeFiles.map((f) => [f.rel, f.sf] as const))(
    "%s builds no error body of its own (or is exempt)",
    (rel, sf) => {
      if (rel in EXEMPT) return;
      expect(
        handRolledErrorBodies(sf),
        `${rel} answers an error body it built itself. Use adminErrorResponse ` +
          `(first-party: { error, message: "errors.<code>", requestId }) or, under ` +
          `/api/v1, problemResponse, so the body carries the request id and a ` +
          `localizable message; a protocol-owned shape needs a reasoned EXEMPT entry.`,
      ).toEqual([]);
    },
  );
});

describe("F-129: every adminErrorResponse code has an errors.<code> message", () => {
  const emitted = emittedCodes();
  const messages = en.errors as Record<string, string>;

  it("finds the envelope's call sites (the scan is not vacuous)", () => {
    // About 410 call sites when F-129 landed; far fewer means the scan stopped
    // matching the source, not that the surface shrank.
    expect(emitted.length).toBeGreaterThan(300);
  });

  it("resolves the code of every call (a literal, a constant, a typed union)", () => {
    const unresolved = emitted.filter((e) => e.codes === null || e.codes.length === 0);
    expect(
      unresolved.map((e) => `${e.where}: adminErrorResponse(${e.argument}, …)`),
      "the scan cannot tell which codes these calls emit, so it cannot check their " +
        "errors.<code> messages. Pass a string literal, an exported constant, or a " +
        "parameter typed as a union of literals.",
    ).toEqual([]);
  });

  it("has an en.json errors.<code> message for each code", () => {
    const missing = emitted.flatMap((e) =>
      (e.codes ?? []).filter((code) => !(code in messages)).map((code) => `${code} (${e.where})`),
    );
    expect(
      [...new Set(missing)],
      "add an `errors.<code>` message to all 8 src/messages/*.json files: the envelope " +
        "tells every client to localize `message` through it",
    ).toEqual([]);
  });

  it("resolves the indirect forms the call sites use (regression guard for the resolver)", () => {
    const codesOf = (fileSuffix: string) =>
      emitted.filter((e) => e.where.startsWith(fileSuffix)).flatMap((e) => e.codes ?? []);
    // A parameter typed as a union (SSO consume's renderer).
    expect(codesOf("app/api/sso/consume/route.ts")).toEqual(
      expect.arrayContaining(["token_expired", "token_already_used", "audience_not_configured"]),
    );
    // A destructured field (the account guard's rejection table).
    expect(codesOf("lib/account/guard.server.ts")).toEqual(
      expect.arrayContaining(["untrusted_origin", "not_provisioned", "insufficient_scope"]),
    );
    // An AdminError's code, and an exported constant.
    expect(codesOf("app/api/administrator/organizations/[id]/route.ts")).toEqual(
      expect.arrayContaining([
        "organization_not_empty",
        "organization_is_default",
        "last_superadmin",
      ]),
    );
  });
});
