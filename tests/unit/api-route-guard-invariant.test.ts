import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MUTATING_METHODS,
  parseSource,
  pathBelow,
  reachableCallsNamed,
  routeHandlers,
} from "../helpers/handler-scan";

/**
 * Systemic guard (review #28): every MUTATING handler (POST/PATCH/PUT/DELETE)
 * exported under `src/app/api/**` must authenticate AND CSRF-guard itself
 * through one of the shared gates —
 *
 *   - `requireAdminPermission`  (administrator surface: permission + origin),
 *   - `requireAccountUser`      (self-service surface: membership + origin + scope),
 *   - `requireApiAccount`       (the same decision rendered as problem+json for
 *                                the `/api/v1/me*` routes — review #45),
 *   - `requireApiPermission`    (v1 machine API: credential + scope),
 *   - `checkTrustedOrigin`      (a cookie mutation with its own authn, e.g. the
 *                                SSO confirm POST or invitation acceptance) —
 *
 * or carry a one-line, reviewed reason in EXEMPT. The origin guard
 * short-circuits under NODE_ENV=test, so a route that forgot it passes every
 * behavioural suite; only a static invariant catches the omission before it
 * ships a cross-site mutation.
 *
 * F-127: checked PER HANDLER, on the TypeScript AST
 * (tests/helpers/handler-scan.ts). It used to ask whether the FILE mentioned
 * a gate, so a new DELETE with no guard passed beside a guarded GET, and so
 * did a handler whose file named a gate only in a comment or an import.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const APP_DIR = join(SRC_DIR, "app");
const API_ROUTES_DIR = join(APP_DIR, "api");

const GUARD_CALLS = new Set([
  "requireAdminPermission",
  "requireAccountUser",
  "requireApiAccount",
  "requireApiPermission",
  "checkTrustedOrigin",
]);

const EXEMPT: Record<string, string> = {
  // Better Auth owns sign-in/up/out, OAuth callbacks and session refresh; its
  // own `trustedOrigins` check covers CSRF and the route MUST NOT be wrapped.
  "api/auth/[...all]/route.ts#POST":
    "Better Auth catch-all: identity + CSRF (trustedOrigins) are the plugin's; wrapping is forbidden",
  // Bearer-only transport: a cookie session is explicitly refused
  // (`!caller.isBearer` → 401), so no ambient credential can be replayed
  // cross-site; each tool is authorized by permission ∩ scope in dispatch.
  "api/mcp/route.ts#POST":
    "bearer-only MCP transport (cookie callers refused → no CSRF surface); tool authz in dispatch",
  // RFC 7591 dynamic client registration is unauthenticated by protocol; dark
  // unless MCP_REGISTRATION_ENABLED, per-IP + global bucket, org quota, and
  // the client it mints is zero-scope until an admin grants scopes.
  "api/mcp/register/route.ts#POST":
    "RFC 7591 registration: unauthenticated by protocol, feature-flagged, throttled, mints a zero-scope client",
  // Browser CSP violation sink: the Reporting API sends no cookies, so there is
  // nothing to authenticate or CSRF-guard; per-IP + global bucket, always 204.
  "api/security/csp-report/route.ts#POST":
    "CSP report sink: cookieless by spec, logs only, throttled, always 204",
  // OAuth 2.0 client-credentials mint: the client id + secret in the request
  // ARE the authentication (no ambient credential → no CSRF surface); it is
  // throttled per client/IP plus a global floor and reads no tenant data.
  "api/v1/auth/token/route.ts#POST":
    "client-credentials token mint: the presented client secret is the auth, no cookie path; throttled per client/IP + global floor",
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

describe("review #28: every mutating /api handler goes through a shared auth/CSRF gate", () => {
  const routeFiles = walk(API_ROUTES_DIR);
  // One row per exported mutating handler (and per `export *`, whose names
  // this scan cannot see): `<route>#<METHOD>`.
  const rows = routeFiles.flatMap((full) => {
    const sf = parseSource(full, readFileSync(full, "utf8"));
    return routeHandlers(sf)
      .filter((h) => MUTATING_METHODS.has(h.method) || h.method === "*")
      .map((h) => [`${pathBelow(APP_DIR, full)}#${h.method}`, sf, h] as const);
  });

  it("discovers the whole API surface", () => {
    expect(routeFiles.length).toBeGreaterThan(80);
    expect(rows.length).toBeGreaterThan(70);
  });

  it("names only real handlers in the exemption map", () => {
    const live = new Set<string>(rows.map(([key]) => key));
    for (const key of Object.keys(EXEMPT)) {
      expect(
        live.has(key),
        `EXEMPT names ${key}, which no longer exists — drop the stale entry`,
      ).toBe(true);
    }
  });

  it("gates each handler on its own (regression guard for the scan itself)", () => {
    // The Better Auth catch-all exports `const POST = …`; the first-party
    // routes export `const POST = withAdminRoute(async function POST(…))`.
    // Every shape must count, and a guarded sibling must not cover for an
    // unguarded one.
    const guarded = (source: string) => {
      const sf = parseSource("planted.ts", source);
      return Object.fromEntries(
        routeHandlers(sf).map((h) => [
          h.method,
          reachableCallsNamed(sf, h.body, GUARD_CALLS).length > 0,
        ]),
      );
    };
    expect(
      guarded(`import { requireAdminPermission } from "@/lib/admin/permissions.server";
        export const GET = withAdminRoute(async function GET(r) { await requireAdminPermission(r, "a"); });
        export const DELETE = withAdminRoute(async function DELETE(r) { await db.deleteFrom("x").execute(); });
        export const POST = async (r) => requireApiPermission(r, "b");
        // export async function PUT: guarded by checkTrustedOrigin(request)
        export async function PUT(r) { return ok(); }`),
    ).toEqual({ GET: true, DELETE: false, POST: true, PUT: false });
  });

  it.each(rows)("%s is gated (or explicitly exempt)", (key, sf, handler) => {
    const reason = EXEMPT[key];
    if (reason !== undefined) {
      expect(reason.length).toBeGreaterThan(0);
      return;
    }
    expect(
      handler.body,
      `${key} is re-exported from another module, so this scan cannot read it; define the ` +
        `handler in the route file`,
    ).not.toBeNull();
    expect(
      reachableCallsNamed(sf, handler.body, GUARD_CALLS).length,
      `${key} is a mutating handler but calls none of ${[...GUARD_CALLS].join(" / ")}. ` +
        `Route it through the matching shared guard (the origin check is skipped under ` +
        `NODE_ENV=test, so only this scan catches the omission), or add a justified entry ` +
        `to EXEMPT.`,
    ).toBeGreaterThan(0);
  });
});
