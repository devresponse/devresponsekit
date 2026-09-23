import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-01 systemic guard — every credential issuance passes the ONE rule.
 *
 * The MACHINE-2 fix bounded issuance route by route, and the next review found
 * the rotation paths it had not reached: minting ran the actor bound, rotating
 * (which hands the actor the SAME scope set) did not. Enumerating routes is
 * what let that happen, so this scan DISCOVERS the issuing call sites instead
 * of listing them:
 *
 *   1. Every issuing call anywhere under `src/app/api` must sit INSIDE an
 *      exported route handler's body, and that body must call
 *      `unissuableScopes` (src/lib/api-auth/issuance.ts). A helper defined
 *      beside the handler, or a non-route module, therefore fails.
 *   2. Outside `src/app/api`, an issuing call is allowed only in the reviewed
 *      EXEMPT list below.
 *   3. Every `/api/v1/me/*` handler that reads the caller's keys must derive
 *      its tenant from `tenantConfinement` — the self-service surface is
 *      account-wide only for the owner's own session.
 *
 * Comments are stripped before matching, so a mention in a comment satisfies
 * nothing. A new rotate/mint path fails here until its author routes it
 * through the rule. Adding to EXEMPT should be a conscious, reviewed decision.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_DIR = join(SRC_DIR, "app", "api");
const ME_DIR = join(API_DIR, "v1", "me");

const ISSUING_NAMES = [
  "createApiKey",
  "rotateApiKey",
  "createOauthClient",
  "rotateOauthClientSecret",
  "updateOauthClient",
];
/** Repository functions that put a credential with a scope set into someone's hands. */
const ISSUING_CALL = new RegExp(`\\b(${ISSUING_NAMES.join("|")})\\s*\\(`, "g");
/** An import that renames an issuing function would hide its calls from the scan. */
const ALIASED_IMPORT = new RegExp(`\\b(${ISSUING_NAMES.join("|")})\\s+as\\s+\\w+`);
/** Their defining modules — declarations, not issuances. */
const DEFINING_MODULES = new Set([
  "lib/api-auth/api-keys.server.ts",
  "lib/api-auth/oauth-clients.server.ts",
]);

const EXEMPT: Record<string, string> = {
  // DCR self-registration provisions a ZERO-SCOPE client for a brand-new
  // machine principal it just created; there is no actor authority to bound
  // and nothing is conferred until an admin sets scopes through the
  // mcp-agents route (which IS bounded).
  "lib/mcp/registration.server.ts": "zero-scope client for a freshly provisioned agent principal",
};

const METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";
const HANDLER_EXPORT = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b|export\\s+const\\s+(${METHODS})\\b`,
  "g",
);
const KEY_READ = /\b(getApiKeyById|listApiKeysForUser)\s*\(/;

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

/** Index just past the bracket that closes the one opening at `open`. */
function matchBracket(source: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const closeFor = pairs[source[open]!];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === source[open]) depth++;
    else if (ch === closeFor && --depth === 0) return i + 1;
  }
  return source.length;
}

interface Handler {
  method: string;
  start: number;
  end: number;
  body: string;
}

/**
 * Each exported handler with the exact span of its body. A function
 * declaration's body is the brace block after its parameter list; an
 * `export const` handler spans to the end of its initializer statement.
 */
function handlers(source: string): Handler[] {
  const out: Handler[] = [];
  for (const match of source.matchAll(HANDLER_EXPORT)) {
    const start = match.index;
    let end: number;
    if (match[1]) {
      const paramsEnd = matchBracket(source, source.indexOf("(", start));
      end = matchBracket(source, source.indexOf("{", paramsEnd));
    } else {
      let i = source.indexOf("=", start) + 1;
      while (i < source.length && source[i] !== ";") {
        i = "({[".includes(source[i]!) ? matchBracket(source, i) : i + 1;
      }
      end = i;
    }
    out.push({ method: match[1] ?? match[2]!, start, end, body: source.slice(start, end) });
  }
  return out;
}

/**
 * The policy, applied to one (comment-stripped) module: every issuing call
 * that is NOT inside an exported handler, and every handler that issues
 * without calling `unissuableScopes`. The real scan and the scanner's own
 * self-test both go through this, so the self-test exercises the real rule.
 */
function issuanceViolations(source: string): { outside: string[]; unbounded: string[] } {
  const spans = handlers(source);
  const outside: string[] = [];
  const unbounded: string[] = [];
  for (const call of source.matchAll(ISSUING_CALL)) {
    const handler = spans.find((h) => call.index >= h.start && call.index < h.end);
    if (!handler) outside.push(call[1]!);
    else if (!/\bunissuableScopes\s*\(/.test(handler.body)) {
      unbounded.push(`${call[1]} in ${handler.method}`);
    }
  }
  return { outside, unbounded };
}

const apiFiles = walk(API_DIR).map((file) => ({
  file,
  source: stripComments(readFileSync(file, "utf8")),
}));

describe("F-01: credential issuance is bounded at one chokepoint", () => {
  it("discovers the issuing calls (the scan is not vacuous)", () => {
    // mint ×2, rotate ×2, OAuth create / PATCH / rotate-secret, agent scopes.
    const calls = apiFiles.flatMap(({ source }) => [...source.matchAll(ISSUING_CALL)]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it("every issuing call sits inside an exported route handler", () => {
    const outside = apiFiles.flatMap(({ file, source }) =>
      issuanceViolations(source).outside.map((call) => `${rel(file)} ${call}`),
    );
    expect(outside).toEqual([]);
  });

  it("every handler that issues a credential calls unissuableScopes", () => {
    const unbounded = apiFiles.flatMap(({ file, source }) =>
      issuanceViolations(source).unbounded.map((call) => `${rel(file)} ${call}`),
    );
    expect(unbounded).toEqual([]);
  });

  it("no module imports an issuing function under another name", () => {
    const aliased = walk(SRC_DIR)
      .filter((f) => ALIASED_IMPORT.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(aliased).toEqual([]);
  });

  it("no issuing call outside src/app/api unless reviewed and exempt", () => {
    const offenders = walk(SRC_DIR)
      .filter((f) => !f.startsWith(API_DIR))
      .map(rel)
      .filter((f) => !DEFINING_MODULES.has(f) && !(f in EXEMPT))
      .filter((f) =>
        new RegExp(ISSUING_CALL.source).test(stripComments(readFileSync(join(SRC_DIR, f), "utf8"))),
      );
    expect(offenders).toEqual([]);
  });

  it("every EXEMPT entry still issues (no stale exemptions)", () => {
    for (const file of Object.keys(EXEMPT)) {
      const source = stripComments(readFileSync(join(SRC_DIR, file), "utf8"));
      expect(new RegExp(ISSUING_CALL.source).test(source), file).toBe(true);
    }
  });
});

describe("F-01: the self-service key surface derives its tenant from tenantConfinement", () => {
  const meKeyHandlers = apiFiles
    .filter(({ file }) => file.startsWith(ME_DIR))
    .flatMap(({ file, source }) =>
      handlers(source)
        .filter((h) => KEY_READ.test(h.body))
        .map((h) => ({ at: `${rel(file)} ${h.method}`, body: h.body })),
    );

  it("discovers the key-reading handlers (list, revoke, rotate)", () => {
    expect(meKeyHandlers.length).toBeGreaterThanOrEqual(3);
  });

  it("each one calls tenantConfinement", () => {
    const missing = meKeyHandlers
      .filter((h) => !/\btenantConfinement\s*\(/.test(h.body))
      .map((h) => h.at);
    expect(missing).toEqual([]);
  });
});

describe("F-09: the on-behalf owner-reach bound reads RANK, not authority", () => {
  // `userIsGlobalSuperuser` is AUTHORITY: since F-09 a grant held in a
  // suspended org no longer satisfies it. A credential minted or rotated for
  // that principal now would authenticate as a platform superuser the moment
  // the org is reactivated, so the mint-time bound must read RANK
  // (`userHoldsSuperuserGrant`), the same predicate `targetOutranksActor` uses.
  const bounded = apiFiles.flatMap(({ file, source }) =>
    handlers(source)
      .filter((h) => /\bownerOutranksActor\s*\(/.test(h.body))
      .map((h) => ({ at: `${rel(file)} ${h.method}`, body: h.body })),
  );

  it("discovers the bounded handlers (mint, rotate, OAuth create, rotate-secret)", () => {
    expect(bounded.length).toBeGreaterThanOrEqual(4);
  });

  it("each one reads the owner's rank with userHoldsSuperuserGrant", () => {
    const missing = bounded
      .filter((h) => !/\buserHoldsSuperuserGrant\s*\(/.test(h.body))
      .map((h) => h.at);
    expect(missing).toEqual([]);
  });

  it("none of them reads the owner's rank from userIsGlobalSuperuser", () => {
    const authority = bounded
      .filter((h) => /\buserIsGlobalSuperuser\s*\(/.test(h.body))
      .map((h) => h.at);
    expect(authority).toEqual([]);
  });
});

describe("the scanner itself", () => {
  // A module that breaks the rule in every way the scan must catch. Each
  // expectation below FAILS if comment stripping is removed or if a handler's
  // span runs past its closing brace.
  const source = stripComments(`
    export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
      // unissuableScopes(x) — a mention in a comment satisfies nothing
      /* unissuableScopes(y) */
      return createApiKey({ scopes: [] });
    }
    async function laterHelper() {
      unissuableScopes({});
      return rotateApiKey(id, actor);
    }
    export const DELETE = withGuard(async () => {
      return createOauthClient({});
    });
    export async function PATCH(request: NextRequest) {
      if (unissuableScopes({}).length) return deny();
      return updateOauthClient(id, {});
    }
  `);

  it("computes each handler's exact span", () => {
    const spans = handlers(source);
    expect(spans.map((h) => h.method)).toEqual(["POST", "DELETE", "PATCH"]);
    expect(spans[0]!.body.trimEnd().endsWith("}")).toBe(true);
    expect(spans[0]!.body).not.toMatch(/laterHelper|rotateApiKey/);
    expect(spans[1]!.body).toMatch(/createOauthClient/);
    expect(spans[1]!.body).not.toMatch(/PATCH/);
  });

  it("reports a comment-only mention and a helper outside any handler", () => {
    expect(issuanceViolations(source)).toEqual({
      outside: ["rotateApiKey"],
      unbounded: ["createApiKey in POST", "createOauthClient in DELETE"],
    });
  });
});
