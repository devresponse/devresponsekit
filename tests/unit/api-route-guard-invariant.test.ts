import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Systemic guard (review #28): every route file under `src/app/api/**` that
 * exports a MUTATING handler (POST/PATCH/PUT/DELETE) must authenticate AND
 * CSRF-guard it through one of the shared gates —
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
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");

const MUTATING_HANDLER = /export (?:async function|const) (?:POST|PATCH|PUT|DELETE)\b/g;
const GUARD_MARKERS = [
  "requireAdminPermission",
  "requireAccountUser",
  "requireApiAccount",
  "requireApiPermission",
  "checkTrustedOrigin",
];

const EXEMPT: Record<string, string> = {
  // Better Auth owns sign-in/up/out, OAuth callbacks and session refresh; its
  // own `trustedOrigins` check covers CSRF and the route MUST NOT be wrapped.
  "api/auth/[...all]/route.ts":
    "Better Auth catch-all: identity + CSRF (trustedOrigins) are the plugin's; wrapping is forbidden",
  // Bearer-only transport: a cookie session is explicitly refused
  // (`!caller.isBearer` → 401), so no ambient credential can be replayed
  // cross-site; each tool is authorized by permission ∩ scope in dispatch.
  "api/mcp/route.ts":
    "bearer-only MCP transport (cookie callers refused → no CSRF surface); tool authz in dispatch",
  // RFC 7591 dynamic client registration is unauthenticated by protocol; dark
  // unless MCP_REGISTRATION_ENABLED, per-IP + global bucket, org quota, and
  // the client it mints is zero-scope until an admin grants scopes.
  "api/mcp/register/route.ts":
    "RFC 7591 registration: unauthenticated by protocol, feature-flagged, throttled, mints a zero-scope client",
  // Browser CSP violation sink: the Reporting API sends no cookies, so there is
  // nothing to authenticate or CSRF-guard; per-IP + global bucket, always 204.
  "api/security/csp-report/route.ts":
    "CSP report sink: cookieless by spec, logs only, throttled, always 204",
  // OAuth 2.0 client-credentials mint: the client id + secret in the request
  // ARE the authentication (no ambient credential → no CSRF surface); it is
  // throttled per client/IP plus a global floor and reads no tenant data.
  "api/v1/auth/token/route.ts":
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

function rel(full: string): string {
  const norm = full.replace(/\\/g, "/");
  const idx = norm.indexOf("api/");
  return idx >= 0 ? norm.slice(idx) : norm;
}

function exemptReason(full: string): string | undefined {
  const norm = full.replace(/\\/g, "/");
  const key = Object.keys(EXEMPT).find((k) => norm.endsWith(k));
  return key ? EXEMPT[key] : undefined;
}

describe("review #28: every mutating /api handler goes through a shared auth/CSRF gate", () => {
  const routeFiles = walk(API_ROUTES_DIR);

  it("discovers the whole API surface", () => {
    expect(routeFiles.length).toBeGreaterThan(80);
  });

  it("names only real route files in the exemption map", () => {
    for (const key of Object.keys(EXEMPT)) {
      expect(
        routeFiles.some((f) => f.replace(/\\/g, "/").endsWith(key)),
        `EXEMPT names ${key}, which no longer exists — drop the stale entry`,
      ).toBe(true);
    }
  });

  it("recognises both handler export styles (regression guard for the scan itself)", () => {
    // The Better Auth catch-all exports `const POST = …`; every first-party
    // route exports `async function POST`. Both must count as mutating, or
    // a route written in the other style would silently escape the scan.
    expect("export const POST = async () => {}".match(MUTATING_HANDLER)).toHaveLength(1);
    expect("export async function DELETE() {}".match(MUTATING_HANDLER)).toHaveLength(1);
    expect("export async function GET() {}".match(MUTATING_HANDLER)).toBeNull();
  });

  it.each(routeFiles.map((f) => [rel(f), f] as const))(
    "%s gates its mutating handlers (or is explicitly exempt)",
    (relPath, full) => {
      const source = readFileSync(full, "utf8");
      const mutating = (source.match(MUTATING_HANDLER) ?? []).length;
      if (mutating === 0) return; // read-only route: nothing to CSRF-guard

      const reason = exemptReason(full);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      const guarded = GUARD_MARKERS.some((m) => source.includes(m));
      expect(
        guarded,
        `${relPath} exports ${mutating} mutating handler(s) but references none of ` +
          `${GUARD_MARKERS.join(" / ")}. Route it through the matching shared guard ` +
          `(the origin check is skipped under NODE_ENV=test, so only this scan catches ` +
          `the omission), or add a justified entry to EXEMPT.`,
      ).toBe(true);
    },
  );
});
