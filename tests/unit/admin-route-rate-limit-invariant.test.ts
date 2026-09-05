import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * The check is count-based: a file must reference the rate-limit primitive at
 * least once per mutating handler it exports. The admin surface calls
 * `enforceRateLimit`; the v1 surface calls `enforceApiRateLimit` (and the
 * token endpoint the lower-level `consumeToken`). GET (read) handlers are not
 * required to throttle.
 *
 * Review #28 added a THIRD scan over every remaining `src/app/api/**` route
 * (account, preferences, invitations, sso, mcp, the public sinks) with its
 * own justified EXEMPT map, so the self-service mutations that shipped
 * unthrottled can never do so again.
 *
 * The admin check additionally requires each `enforceRateLimit` call to thread
 * the request CONTEXT (`request` + a `requestId` — `guard.requestId` or a local
 * one from `getOrCreateRequestId`), so a 429 carries the same `x-request-id` as
 * the request's logs/audit rows (P3-9) — a call that omits it does not count
 * and fails CI.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const ADMIN_ROUTES_DIR = join(SRC_DIR, "app", "api", "administrator");
const V1_ROUTES_DIR = join(SRC_DIR, "app", "api", "v1");

const MUTATING_HANDLER = /export async function (?:POST|PATCH|PUT|DELETE)\b/g;
// Admin calls must thread the request CONTEXT so the 429 correlates (P3-9):
// match `enforceRateLimit(…requestId…)` — the correlation id threaded either as
// `guard.requestId` (permission-gated routes) or a local `requestId` from
// `getOrCreateRequestId(request)` (e.g. the impersonation STOP route, which is
// authorized by the session being an impersonation session, not by a guard).
// The lazy `[\s\S]*?` spans the multi-line call up to the closing paren, so a
// call WITHOUT a `requestId` arg is not counted and trips the gate below.
const ADMIN_RATE_LIMIT_CALL = /enforceRateLimit\s*\([\s\S]*?\brequestId\b[\s\S]*?\)/g;
// v1 wraps the bucket as enforceApiRateLimit; the token endpoint calls the
// low-level consumeToken directly (per-credential/IP + a global floor).
const V1_RATE_LIMIT_CALL = /(?:enforceApiRateLimit|consumeToken)\s*\(/g;

const ADMIN_EXEMPT: Record<string, string> = {};
const V1_EXEMPT: Record<string, string> = {};

// Review #28: the scan used to stop at administrator/** and v1/**, so the
// self-service and preference mutations shipped unthrottled. Every OTHER
// `src/app/api/**/route.ts` is walked here against the union of the three
// limiter primitives (the account/preference/invitation routes call
// `enforceRateLimit` with the request context; the public sinks call the
// low-level `consumeToken` per IP + a global floor).
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");
const ANY_RATE_LIMIT_CALL = /(?:enforceRateLimit|enforceApiRateLimit|consumeToken)\s*\(/g;
const OTHER_EXEMPT: Record<string, string> = {
  // Better Auth owns this catch-all end to end, including its own limiter
  // (sign-in 3 req / 10 s, password reset 3 / 60 s per client IP — see the
  // `rateLimit` option in src/lib/auth.ts). Wrapping the handler with an app
  // limiter is forbidden: the route MUST NOT be wrapped with custom checks or
  // Better Auth's lifecycle deadlocks (documented in the route).
  "api/auth/[...all]/route.ts":
    "Better Auth catch-all: the plugin applies its own per-IP limiter; wrapping the handler is forbidden",
  // MCP JSON-RPC transport (Phase 0, dark unless MCP_ENABLED). Bearer-only:
  // a cookie session is refused, so every call is a credential-bound
  // principal whose minting is already throttled at /api/v1/auth/token and
  // whose tool calls are bounded by permission ∩ scope. A per-call bucket
  // on the transport itself is a gateway design decision (per credential vs
  // per tool) tracked with the RFC 8707 audience work, not a drive-by here.
  "api/mcp/route.ts":
    "bearer-only MCP transport (dark unless MCP_ENABLED); credential minting is throttled at /v1/auth/token, per-call bucket tracked with the RFC 8707 rollout",
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

function rel(full: string, anchor: string): string {
  const norm = full.replace(/\\/g, "/");
  const idx = norm.indexOf(anchor);
  return idx >= 0 ? norm.slice(idx) : norm;
}

function assertRateLimited(
  full: string,
  relPath: string,
  rateLimitCall: RegExp,
  exempt: Record<string, string>,
  primitive: string,
): void {
  const source = readFileSync(full, "utf8");
  const mutating = (source.match(MUTATING_HANDLER) ?? []).length;
  const limited = (source.match(rateLimitCall) ?? []).length;

  const norm = full.replace(/\\/g, "/");
  const key = Object.keys(exempt).find((k) => norm.endsWith(k));
  if (key) {
    expect((exempt[key] ?? "").length).toBeGreaterThan(0);
    return;
  }

  expect(
    limited >= mutating,
    `${relPath} exports ${mutating} mutating handler(s) (POST/PATCH/PUT/DELETE) but ` +
      `references ${primitive} ${limited} time(s). Every privileged mutation must go ` +
      `through the token bucket — add the ${primitive} call or a justified EXEMPT entry. ` +
      `(Admin calls must thread \`request\` + a \`requestId\` so the 429 correlates; a ` +
      `call that omits the context is not counted.)`,
  ).toBe(true);
}

describe("every administrator mutation is rate-limited", () => {
  const routeFiles = walk(ADMIN_ROUTES_DIR);

  it("discovers the administrator route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [rel(f, "administrator"), f] as const))(
    "%s rate-limits every mutating handler",
    (relPath, full) => {
      assertRateLimited(full, relPath, ADMIN_RATE_LIMIT_CALL, ADMIN_EXEMPT, "enforceRateLimit");
    },
  );
});

describe("every /api/v1 mutation is rate-limited", () => {
  const routeFiles = walk(V1_ROUTES_DIR);

  it("discovers the v1 route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles.map((f) => [rel(f, "api/v1"), f] as const))(
    "%s rate-limits every mutating handler",
    (relPath, full) => {
      assertRateLimited(full, relPath, V1_RATE_LIMIT_CALL, V1_EXEMPT, "enforceApiRateLimit");
    },
  );
});

describe("review #28: every OTHER /api mutation is rate-limited (or explicitly exempt)", () => {
  const isAdminOrV1 = (f: string) => {
    const norm = f.replace(/\\/g, "/");
    return norm.includes("/api/administrator/") || norm.includes("/api/v1/");
  };
  const routeFiles = walk(API_ROUTES_DIR).filter((f) => !isAdminOrV1(f));

  it("discovers the remaining route handlers (account, preferences, sso, mcp, sinks, …)", () => {
    // account/{preferences,profile}, preferences/{locale,active-org},
    // invitations/accept, sso/{launch,consume}, mcp/{route,register},
    // security/csp-report, auth catch-all, health, navigation, … — a shrink
    // below this means the walk is broken, not that the surface got smaller.
    expect(routeFiles.length).toBeGreaterThan(15);
  });

  it("names only real route files in the exemption map", () => {
    for (const key of Object.keys(OTHER_EXEMPT)) {
      expect(
        routeFiles.some((f) => f.replace(/\\/g, "/").endsWith(key)),
        `OTHER_EXEMPT names ${key}, which no longer exists — drop the stale entry`,
      ).toBe(true);
    }
  });

  it.each(routeFiles.map((f) => [rel(f, "api/"), f] as const))(
    "%s rate-limits every mutating handler",
    (relPath, full) => {
      assertRateLimited(
        full,
        relPath,
        ANY_RATE_LIMIT_CALL,
        OTHER_EXEMPT,
        "enforceRateLimit / consumeToken",
      );
    },
  );
});
