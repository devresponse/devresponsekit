import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  MUTATING_METHODS,
  calleeName,
  parseSource,
  pathBelow,
  reachableCallsNamed,
  routeHandlers,
  type RouteHandler,
} from "../helpers/handler-scan";

/**
 * Systemic guard: every mutating handler under `/api/administrator/**` AND
 * `/api/v1/**` must be rate-limited (docs/admin-manager.md §2.5 /
 * api-and-cli-guide §2.5).
 *
 * The contract — "all privileged mutations go through a token bucket" — had
 * silently drifted on the admin surface (~17 routes shipped unthrottled). A
 * point-in-time fix doesn't stop the NEXT route from forgetting; this scan
 * does, and it now covers the v1 surface too (MAPI-1) so a new versioned
 * mutation that forgets to throttle also fails CI.
 *
 * F-127: the check is made PER MUTATING HANDLER, on the TypeScript AST
 * (tests/helpers/handler-scan.ts): the code Next runs for each exported
 * POST/PATCH/PUT/DELETE (its body, and the module-scope helpers it calls)
 * must call the rate-limit primitive. It used to compare two per-FILE counts,
 * "limiter mentions ≥ mutating exports", so one handler calling the limiter
 * twice paid for a sibling that called it never, and a comment quoting the
 * call counted as one. The admin surface calls `enforceRateLimit`; the v1
 * surface calls `enforceApiRateLimit` (and the token endpoint the lower-level
 * `consumeToken`). GET (read) handlers are not required to throttle.
 *
 * Review #28 added a THIRD scan over every remaining `src/app/api/**` route
 * (account, preferences, invitations, sso, mcp, the public sinks) with its
 * own justified EXEMPT map, so the self-service mutations that shipped
 * unthrottled can never do so again.
 *
 * A limiter call counts only when it threads the request CONTEXT:
 *   - `enforceRateLimit` / `enforceSharedRateLimit` must pass the `request`
 *     (4th argument). It is the load-bearing one: it names the human behind an
 *     impersonated session, whose bucket is the one charged (F-07), and it is
 *     what the 429 reads its correlation id from (review #155).
 *   - on the admin surface the call must also pass a `requestId` (5th
 *     argument) — `guard.requestId`, or a local one from `getOrCreateRequestId`
 *     — so a 429 carries the same `x-request-id` as the request's logs and
 *     audit rows (P3-9).
 *
 * F-64: the admin actions that mail someone take their per-actor budget from
 * the SHARED bucket, through `enforceSharedRateLimit`, which counts on the
 * same terms as `enforceRateLimit` on the admin surface.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const APP_DIR = join(SRC_DIR, "app");
const ADMIN_ROUTES_DIR = join(SRC_DIR, "app", "api", "administrator");
const V1_ROUTES_DIR = join(SRC_DIR, "app", "api", "v1");

/** The limiters whose 4th argument is the request (and 5th the request id). */
const CONTEXT_LIMITERS = new Set(["enforceRateLimit", "enforceSharedRateLimit"]);

/** Whether an argument is present and is not a bare `undefined` / `null`. */
function passed(arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  if (arg.kind === ts.SyntaxKind.NullKeyword) return false;
  return !(ts.isIdentifier(arg) && arg.text === "undefined");
}

/** `requestId` or `<x>.requestId`. */
function isRequestId(arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  if (ts.isIdentifier(arg)) return arg.text === "requestId";
  return ts.isPropertyAccessExpression(arg) && arg.name.text === "requestId";
}

/** A context limiter call must pass the request; other limiters are taken as they are. */
function threadsRequest(call: ts.CallExpression): boolean {
  return !CONTEXT_LIMITERS.has(calleeName(call) ?? "") || passed(call.arguments[3]);
}

/** The admin rule: `enforceRateLimit(scope, actor, limit, request, requestId)`. */
function threadsRequestAndId(call: ts.CallExpression): boolean {
  return threadsRequest(call) && isRequestId(call.arguments[4]);
}

// F-64: the mail-sending admin actions charge the shared bucket instead.
const ADMIN_LIMITERS = new Set(["enforceRateLimit", "enforceSharedRateLimit"]);
// v1 wraps the bucket as enforceApiRateLimit; the token endpoint calls the
// lower-level primitives directly — consumeSourceThenGlobal for its shared
// per-IP + global pre-auth floors (review #98, F-18) and consumeToken for the
// per-credential bucket.
const V1_LIMITERS = new Set([
  "enforceApiRateLimit",
  "consumeToken",
  "consumeSharedToken",
  "consumeSourceThenGlobal",
]);

const ADMIN_EXEMPT: Record<string, string> = {};
const V1_EXEMPT: Record<string, string> = {};

// Review #28: the scan used to stop at administrator/** and v1/**, so the
// self-service and preference mutations shipped unthrottled. Every OTHER
// `src/app/api/**/route.ts` is walked here against the union of the limiter
// primitives (the account/preference routes call `enforceRateLimit` with the
// request context; the public sinks take a per-IP bucket + a global floor).
// The pre-auth floors (register, the CSP sink, invitation acceptance, SSO
// consume and the signed-out SSO launch) use the SHARED-bucket twins —
// consumeSourceThenGlobal (per-IP then global, F-18) / enforceSharedRateLimit
// (review #98; per IP for the SSO pair, F-19);
// tests/unit/rate-limit-shared-floors-invariant.test.ts fails any in-memory
// call keyed on the client IP, this scan only requires that one exists.
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");
const ANY_LIMITERS = new Set([
  "enforceRateLimit",
  "enforceSharedRateLimit",
  "enforceApiRateLimit",
  "consumeToken",
  "consumeSharedToken",
  "consumeSourceThenGlobal",
]);
const OTHER_EXEMPT: Record<string, string> = {
  // Better Auth owns this catch-all end to end, including its own limiter
  // (sign-in 3 req / 10 s, password reset 3 / 60 s per client IP — see the
  // `rateLimit` option in src/lib/auth.ts). Wrapping the handler with an app
  // limiter is forbidden: the route MUST NOT be wrapped with custom checks or
  // Better Auth's lifecycle deadlocks (documented in the route).
  "api/auth/[...all]/route.ts#POST":
    "Better Auth catch-all: the plugin applies its own per-IP limiter; wrapping the handler is forbidden",
  // (`api/mcp/route.ts` was exempt until F-76 gave `tools/call` a
  // per-credential bucket; it is scanned like any other route now.)
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

/** One row per exported MUTATING handler in `dir`: `<route>#<METHOD>`. */
function mutatingHandlers(dir: string, keep: (route: string) => boolean = () => true) {
  return walk(dir)
    .filter((full) => keep(pathBelow(APP_DIR, full)))
    .flatMap((full) => {
      const sf = parseSource(full, readFileSync(full, "utf8"));
      return routeHandlers(sf)
        .filter((h) => MUTATING_METHODS.has(h.method) || h.method === "*")
        .map((h) => [`${pathBelow(APP_DIR, full)}#${h.method}`, sf, h] as const);
    });
}

function expectLiveKeys(
  exempt: Record<string, string>,
  rows: ReadonlyArray<readonly [string, ...unknown[]]>,
) {
  const live = new Set(rows.map(([key]) => key));
  for (const key of Object.keys(exempt)) {
    expect(
      live.has(key),
      `EXEMPT names ${key}, which no longer exists — drop the stale entry`,
    ).toBe(true);
  }
}

function assertRateLimited(
  key: string,
  sf: ts.SourceFile,
  handler: RouteHandler,
  limiters: ReadonlySet<string>,
  accept: (call: ts.CallExpression) => boolean,
  exempt: Record<string, string>,
  primitive: string,
): void {
  const reason = exempt[key];
  if (reason !== undefined) {
    expect(reason.length).toBeGreaterThan(0);
    return;
  }
  expect(
    handler.body,
    `${key} is re-exported from another module, so this scan cannot read it; define the ` +
      `handler in the route file`,
  ).not.toBeNull();
  const all = reachableCallsNamed(sf, handler.body, limiters);
  const threaded = all.filter(accept);
  expect(
    threaded.length,
    `${key} is a mutating handler, but it ` +
      (all.length === 0
        ? `calls no ${primitive}. Every privileged mutation must go through the token bucket — ` +
          `add the ${primitive} call or a justified EXEMPT entry.`
        : `calls ${primitive} without the request context (${all
            .map((c) => c.getText(sf).replace(/\s+/g, " "))
            .join("; ")}). Pass \`request\` (and, on the admin surface, a \`requestId\`), ` +
          `so the bucket charges the human behind an impersonation and the 429 correlates.`),
  ).toBeGreaterThan(0);
}

describe("F-127: the rate-limit scan reads each mutating handler, not the file", () => {
  // Negative controls, planted in synthetic sources.
  const limited = (source: string, accept = threadsRequestAndId) => {
    const sf = parseSource("planted.ts", source);
    return Object.fromEntries(
      routeHandlers(sf).map((h) => [
        h.method,
        reachableCallsNamed(sf, h.body, ADMIN_LIMITERS, accept).length > 0,
      ]),
    );
  };

  it("fails a handler whose sibling calls the limiter twice (the old count passed it)", () => {
    expect(
      limited(`
        export const POST = withAdminRoute(async function POST(request) {
          const a = enforceRateLimit("x.one", id, L, request, guard.requestId);
          const b = enforceRateLimit("x.two", id, L, request, guard.requestId);
        });
        export const DELETE = withAdminRoute(async function DELETE(request) { return ok(); });`),
    ).toEqual({ POST: true, DELETE: false });
  });

  it("does not count a comment that quotes the call", () => {
    expect(
      limited(`// throttled: enforceRateLimit(scope, actor, limit, request, requestId)
        export const PUT = withAdminRoute(async function PUT(request) { return ok(); });`),
    ).toEqual({ PUT: false });
  });

  it("recognises both export styles and a limiter in a module-scope helper", () => {
    expect(
      limited(`function throttle(request, guard) { return enforceRateLimit("x", id, L, request, guard.requestId); }
        export async function PATCH(request) { return throttle(request, guard); }
        export const DELETE = async (request) => enforceRateLimit("x", id, L, request, requestId);`),
    ).toEqual({ PATCH: true, DELETE: true });
  });

  it("requires the request context, positionally (review #155)", () => {
    const shapes: Array<[string, boolean]> = [
      [`enforceRateLimit("x", id, L, request, guard.requestId)`, true],
      [`enforceRateLimit("x", id, L, request, requestId)`, true],
      // requestId alone used to satisfy the scan; the request is what matters.
      [`enforceRateLimit("x", id, L, undefined, guard.requestId)`, false],
      [`enforceRateLimit("x", id, L, null, requestId)`, false],
      [`enforceRateLimit("x", id, L, request)`, false],
      [`enforceRateLimit("x", id, L)`, false],
      // F-64: the shared bucket counts on the admin surface on the same terms.
      [`enforceSharedRateLimit("x", id, L, request, guard.requestId)`, true],
      [`enforceSharedRateLimit("x", id, L, request)`, false],
    ];
    for (const [call, ok] of shapes) {
      expect(limited(`export const POST = async (request) => ${call};`).POST, call).toBe(ok);
    }
    // Outside the admin surface the request is still required, the id is not.
    const other = (source: string) => {
      const sf = parseSource("planted.ts", source);
      return reachableCallsNamed(sf, sf, ANY_LIMITERS, threadsRequest).length;
    };
    expect(other(`enforceSharedRateLimit("x", id, L, request);`)).toBe(1);
    expect(other(`enforceSharedRateLimit("x", id, L);`)).toBe(0);
    expect(other(`consumeToken(rateLimitKey("x", id), L);`)).toBe(1);
  });
});

describe("every administrator mutation is rate-limited", () => {
  const rows = mutatingHandlers(ADMIN_ROUTES_DIR);

  it("discovers the administrator mutating handlers (the scan is not vacuous)", () => {
    // F-29 found an earlier version of this scan counting zero mutating
    // handlers once they were wrapped; a total this low means the parse no
    // longer matches the source, not that the surface shrank.
    expect(rows.length).toBeGreaterThan(50);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(ADMIN_EXEMPT, rows);
  });

  it.each(rows)("%s is rate-limited", (key, sf, handler) => {
    assertRateLimited(
      key,
      sf,
      handler,
      ADMIN_LIMITERS,
      threadsRequestAndId,
      ADMIN_EXEMPT,
      "enforceRateLimit",
    );
  });
});

describe("every /api/v1 mutation is rate-limited", () => {
  const rows = mutatingHandlers(V1_ROUTES_DIR);

  it("discovers the v1 mutating handlers", () => {
    expect(rows.length).toBeGreaterThan(8);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(V1_EXEMPT, rows);
  });

  it.each(rows)("%s is rate-limited", (key, sf, handler) => {
    assertRateLimited(
      key,
      sf,
      handler,
      V1_LIMITERS,
      threadsRequest,
      V1_EXEMPT,
      "enforceApiRateLimit",
    );
  });
});

describe("review #28: every OTHER /api mutation is rate-limited (or explicitly exempt)", () => {
  const isAdminOrV1 = (route: string) =>
    route.startsWith("api/administrator/") || route.startsWith("api/v1/");
  const rows = mutatingHandlers(API_ROUTES_DIR, (route) => !isAdminOrV1(route));

  it("discovers the remaining mutating handlers (account, preferences, sso, mcp, sinks, …)", () => {
    // account/{preferences,profile}, preferences/{locale,active-org},
    // invitations/accept, sso/consume, mcp/{route,register},
    // security/csp-report, the auth catch-all — a shrink below this means the
    // walk is broken, not that the surface got smaller.
    expect(rows.length).toBeGreaterThan(8);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(OTHER_EXEMPT, rows);
  });

  it.each(rows)("%s is rate-limited", (key, sf, handler) => {
    assertRateLimited(
      key,
      sf,
      handler,
      ANY_LIMITERS,
      threadsRequest,
      OTHER_EXEMPT,
      "enforceRateLimit / consumeToken",
    );
  });
});
