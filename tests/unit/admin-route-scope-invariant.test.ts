import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  calleeName,
  parseSource,
  pathBelow,
  reachableCalls,
  reachableCallsNamed,
  routeHandlers,
  type RouteHandler,
} from "../helpers/handler-scan";

/**
 * ADR-0001 systemic guard (docs/adr/0001-three-tier-access-control.md).
 *
 * Every surface that serves tenant-scoped data MUST derive its org boundary
 * from the single source of truth (`@/lib/admin/access-scope.server`) — so a
 * route/page that simply forgets to call the scope primitive fails CI here
 * instead of shipping a cross-tenant leak. This is the "completeness critic":
 * a point-in-time fix doesn't stop the NEXT one from forgetting; this scan
 * does.
 *
 * It covers THREE surfaces, because the rule must hold everywhere it applies,
 * not just where it was first written (MAPI-1 / AUTHZ-RSC-1):
 *   1. `/api/administrator/**` route handlers   — resolveOrgScope / canAccess* / resolveTargetUser
 *   2. `/api/v1/**` route handlers              — same access-scope module, or requireApiAccount (self-scoped)
 *   3. administrator RSC *detail* pages          — canAccessOrg / canAccessUser → notFound()
 *
 * Each surface has its own tiny EXEMPT list (platform-global / public
 * surfaces with no tenant column), keyed by HANDLER (`<route>#<METHOD>`), so
 * a new method added to an exempt file is scanned like any other. Adding to
 * one should be a conscious, reviewed decision — not a reflex to make the
 * test pass.
 *
 * F-127: the checks are made PER EXPORTED HANDLER, on the TypeScript AST
 * (tests/helpers/handler-scan.ts), and require a CALL. They used to ask
 * whether the FILE's text mentioned a primitive, so a DELETE that dropped its
 * `canAccessOrg` passed on the strength of its sibling GET (or of the import
 * line), and a comment naming the primitive counted as a use. A handler now
 * passes only when the code Next runs for that method (its body, and the
 * module-scope helpers it calls) calls a primitive. What the call DOES is
 * still pinned by the route tests, notably
 * tests/security/tenant-handler-reach.test.ts (F-42), and the per-file
 * coverage floors in vitest.config.ts.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const APP_DIR = join(SRC_DIR, "app");
const ADMIN_ROUTES_DIR = join(SRC_DIR, "app", "api", "administrator");
const V1_ROUTES_DIR = join(SRC_DIR, "app", "api", "v1");
const ACCOUNT_ROUTES_DIR = join(SRC_DIR, "app", "api", "account");
const V1_ME_ROUTES_DIR = join(V1_ROUTES_DIR, "me");
// `[locale]` and `(secure)` are literal directory names — build the path with
// join() (not new URL(), which would percent-encode the brackets).
const ADMIN_PAGES_DIR = join(SRC_DIR, "app", "[locale]", "(secure)", "app", "administrator");

// The org-boundary predicates `@/lib/admin/access-scope.server` exports.
// `isSuperadmin` counts: a PLATFORM-GLOBAL record (no organization column)
// has no org to compare against, so "only a superadmin may be here" is the
// strictest boundary there is (review #73). Whether a route may use it as a
// TENANT boundary is policed separately, by the MACHINE-2 scan below.
const BOUNDARY_CALLS = [
  "resolveOrgScope",
  "canAccessOrg",
  "canAccessUser",
  "hasCrossOrgReach",
  "isSuperadmin",
];

// The boundary predicates + the helpers that embed one by contract.
const ADMIN_SCOPE_CALLS = new Set([
  ...BOUNDARY_CALLS,
  // resolveTargetUser(id, access) embeds canAccessUser — scoped by contract.
  "resolveTargetUser",
  // loadScopedOrg(request, orgId, access) embeds canAccessOrg (returning a 404
  // for a foreign org) — the shared org-load helper the /organizations/[id]/*
  // sub-routes derive their boundary from, scoped by contract.
  "loadScopedOrg",
  // selectDashboardMetrics(access) derives system-vs-org scope from
  // access-scope.server (isSuperadmin / resolveOrgScope) by construction.
  "selectDashboardMetrics",
]);

// v1 routes scope tenant data via the SAME access-scope module; self-service
// `/me/*` routes are confined to the caller's own account via the account
// guard — `requireApiAccount` on v1 (the problem+json rendering of the same
// decision, review #45), `requireAccountUser` on the first-party surfaces.
const V1_SCOPE_CALLS = new Set([...BOUNDARY_CALLS, "requireAccountUser", "requireApiAccount"]);

// RSC detail pages enforce the boundary directly before rendering.
const PAGE_SCOPE_CALLS = new Set(["canAccessOrg", "canAccessUser", "isSuperadmin"]);

const ADMIN_EXEMPT: Record<string, string> = {
  // The email TEMPLATE catalog is platform-global config — identical for
  // every tenant, with no organization column — so reading it is not a
  // cross-tenant leak. Editing a template (PUT in templates/[id]) affects all
  // tenants and IS SUPERADMIN-gated there, so that PUT is scanned; only the
  // two reads are exempt.
  "api/administrator/email/templates/route.ts#GET":
    "platform-global template catalog (no tenant column); read-only list, edits are SUPERADMIN-gated in templates/[id]",
  "api/administrator/email/templates/[id]/route.ts#GET":
    "one row of the same platform-global template catalog, loaded into the editor; the PUT beside it is SUPERADMIN-gated",
  // Stop acts on the caller's OWN impersonation session: the target and the
  // audit subject come from the live session (`impersonatedBy`), never from
  // the URL or another tenant's rows (docs/admin-manager.md §8.1).
  "api/administrator/users/[id]/impersonate/route.ts#DELETE":
    "ends the caller's own impersonation session (authorized by session.impersonatedBy); the [id] segment is ignored and no tenant row is read",
};

const V1_EXEMPT: Record<string, string> = {
  // The credential IS the auth — the token endpoint mints a JWT, it does not
  // read tenant data. It is rate-limited per client/IP plus a global floor.
  "api/v1/auth/token/route.ts#POST":
    "credential mint; the credential is the auth, no tenant-data read. Rate-limited per client/IP + global floor.",
  // Public, unauthenticated, platform-global — no tenant data.
  "api/v1/jwks.json/route.ts#GET": "public JWKS; platform-global signing keys, no tenant data",
  "api/v1/openapi.json/route.ts#GET": "public API description; platform-global, no tenant data",
};

// Review #28: every OTHER `src/app/api/**` handler (outside administrator/**
// and v1/**) must confine its data access to the CALLER'S OWN identity — the
// self-service guard, the v1 guard, the unified caller resolver, or the raw
// session — or be a public / platform-global surface listed below with a
// reason. A new first-party route that reads tenant data through neither
// fails here instead of shipping unscoped.
const API_ROUTES_DIR = join(SRC_DIR, "app", "api");
const PREFERENCES_ROUTES_DIR = join(SRC_DIR, "app", "api", "preferences");
const OTHER_SCOPE_CALLS = new Set([
  ...BOUNDARY_CALLS,
  "requireAccountUser",
  "requireApiAccount",
  "requireApiPermission",
  "resolveCaller",
  "resolveCallerDetailed",
  "getCurrentSession",
]);
const OTHER_EXEMPT: Record<string, string> = {
  "api/auth/[...all]/route.ts#GET":
    "Better Auth catch-all; the plugin owns identity, no app tenant read",
  "api/auth/[...all]/route.ts#POST":
    "Better Auth catch-all; the plugin owns identity, no app tenant read",
  "api/health/route.ts#GET": "public liveness probe; touches nothing",
  "api/health/ready/route.ts#GET": "public readiness probe; a dependency ping, no tenant data",
  "api/metrics/route.ts#GET":
    "Prometheus scrape gated by METRICS_TOKEN; platform-wide counters, no tenant rows",
  // No tenant data, but not unauthenticated: both delegate to serveSpaceAsset,
  // which admits only the viewers' audience (F-92,
  // tests/unit/docs-asset-route-auth.test.ts calls both route files).
  "api/docs/asset/[...path]/route.ts#GET":
    "static docs asset from the repo tree; no tenant data. Gated (session, membership, shell.view) in serveSpaceAsset",
  "api/help/asset/[...path]/route.ts#GET":
    "static help asset from the repo tree; no tenant data. Gated (session, membership, shell.view) in serveSpaceAsset",
  "api/sso/jwks.json/route.ts#GET": "public JWKS; platform-global signing keys, no tenant data",
  "api/sso/consume/route.ts#GET":
    "consumer side of the handoff: the signed token IS the principal (jti + sub bound at launch); no session yet",
  "api/sso/consume/route.ts#POST":
    "consumer side of the handoff: the signed token IS the principal (jti + sub bound at launch); no session yet",
  "api/internal/outbox-drain/route.ts#GET":
    "cron worker gated by CRON_SECRET; drains the platform-global outbox, no per-tenant read",
  "api/internal/mcp-registration-reap/route.ts#GET":
    "cron worker gated by CRON_SECRET; expires stale pending MCP self-registrations platform-wide (review #51), no per-tenant read",
  "api/mcp/register/route.ts#POST":
    "RFC 7591 dynamic client registration — unauthenticated by protocol, dark unless MCP_REGISTRATION_ENABLED; creates a zero-scope client, reads no tenant data",
  "api/mcp/route.ts#GET": "405 Method Not Allowed (no server-initiated stream); serves nothing",
  "api/security/csp-report/route.ts#POST": "browser CSP violation sink; logs only, no tenant data",
};

// Review #73: the email-template edit page USED to sit here, on the claim that
// it was "SUPERADMIN-gated via checkAdminPermissionServer". It was not — it
// gated on `admin.email.manage`, which the SUPERADMIN-only PUT rejects, so the
// exemption's rationale was false and the page handed permitted org admins a
// form that always 403d. The page now calls `isSuperadmin(...) -> notFound()`
// and satisfies PAGE_SCOPE_CALLS on its own. Keep this list empty unless a
// page genuinely has no boundary to enforce, and state WHY in the value.
const PAGE_EXEMPT: Record<string, string> = {};

function walkFiles(dir: string, fileName: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, fileName));
    else if (entry === fileName) out.push(full);
  }
  return out;
}

function exemptReason(full: string, exempt: Record<string, string>): string | undefined {
  const norm = full.replace(/\\/g, "/");
  const key = Object.keys(exempt).find((k) => norm.endsWith(k));
  return key ? exempt[key] : undefined;
}

/** A route file, parsed once: its path below `src/app/` and its exported handlers. */
interface ParsedRoute {
  route: string;
  sf: ts.SourceFile;
  handlers: RouteHandler[];
}

function parseRoutes(dir: string): ParsedRoute[] {
  return walkFiles(dir, "route.ts").map((full) => {
    const sf = parseSource(full, readFileSync(full, "utf8"));
    return { route: pathBelow(APP_DIR, full), sf, handlers: routeHandlers(sf) };
  });
}

/** One `it.each` row per exported handler: `<route>#<METHOD>`. */
function handlerRows(routes: ParsedRoute[]) {
  return routes.flatMap(({ route, sf, handlers }) =>
    handlers.map((handler) => [`${route}#${handler.method}`, sf, handler] as const),
  );
}

/** The exemption map names only handlers that exist (a stale entry would pass silently). */
function expectLiveKeys(exempt: Record<string, string>, routes: ParsedRoute[], map: string) {
  const live = new Set<string>(handlerRows(routes).map(([key]) => key));
  for (const key of Object.keys(exempt)) {
    expect(
      live.has(key),
      `${map} names ${key}, which no longer exists — drop the stale entry`,
    ).toBe(true);
  }
}

/** Asserts one handler calls one of `calls`, unless its `<route>#<METHOD>` key is exempt. */
function expectScopedHandler(
  key: string,
  sf: ts.SourceFile,
  handler: RouteHandler,
  calls: ReadonlySet<string>,
  exempt: Record<string, string>,
  hint: string,
) {
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
  expect(
    reachableCallsNamed(sf, handler.body, calls).length,
    `${key} calls none of ${[...calls].join(" / ")}. ${hint}`,
  ).toBeGreaterThan(0);
}

describe("F-127: the scope scan reads each handler, not the file", () => {
  // Negative controls: every shape the rule claims, planted in synthetic
  // sources, so the scan is proven to catch (and to pass) what it says.
  const scoped = (source: string) => {
    const sf = parseSource("planted.ts", source);
    return Object.fromEntries(
      routeHandlers(sf).map((h) => [
        h.method,
        reachableCallsNamed(sf, h.body, ADMIN_SCOPE_CALLS).length > 0,
      ]),
    );
  };

  it("fails the one handler of a multi-method file that drops its check", () => {
    expect(
      scoped(`import { canAccessOrg } from "@/lib/admin/access-scope.server";
        export const GET = withAdminRoute(async function GET(r) { if (!canAccessOrg(a, o)) return nf(); });
        export const DELETE = withAdminRoute(async function DELETE(r) { await db.deleteFrom("x").execute(); });`),
    ).toEqual({ GET: true, DELETE: false });
  });

  it("does not count the import line or a comment as a call", () => {
    expect(
      scoped(`import { canAccessOrg } from "@/lib/admin/access-scope.server";
        // canAccessOrg(access, org) runs in the sibling
        export async function PATCH() { /* canAccessOrg(a, b) */ return ok(); }`),
    ).toEqual({ PATCH: false });
  });

  it("follows a module-scope helper, but not a local that only shares a name", () => {
    expect(
      scoped(`async function loadRole(id, access) { return canAccessOrg(access, id) ? row : null; }
        export const GET = withAdminRoute(async function GET() { return loadRole(id, access); });
        export const POST = withAdminRoute(async function POST() { const scope = resolveOrgScope(a); });
        export const PUT = withAdminRoute(async function PUT() { const scope = 1; return scope; });`),
    ).toEqual({ GET: true, POST: true, PUT: false });
  });

  it("does not take a local that shadows a module helper's name for that helper", () => {
    expect(
      scoped(`async function loadRole(id, access) { return canAccessOrg(access, id) ? row : null; }
        export const GET = withAdminRoute(async function GET() { return loadRole(id, access); });
        export const PATCH = withAdminRoute(async function PATCH() { const loadRole = (id) => db.find(id); return loadRole(id); });
        export const DELETE = withAdminRoute(async function DELETE(r) { return ids.map((loadRole) => loadRole(r)); });
        export const PUT = withAdminRoute(async function PUT() { function loadRole(id) { return db.find(id); } return loadRole(id); });`),
    ).toEqual({ GET: true, PATCH: false, DELETE: false, PUT: false });
  });

  it("keys a route by its path below src/app, whatever the checkout's own path holds", () => {
    // The key used to be cut at the first "api/" in the full path, so a
    // checkout under a directory ending in "api" shifted every key and every
    // exemption stopped matching.
    expect(
      pathBelow("/home/me/api/repo/src/app", "/home/me/api/repo/src/app/api/v1/users/route.ts"),
    ).toBe("api/v1/users/route.ts");
    expect(
      pathBelow(
        "C:\\work\\myapi\\repo\\src\\app",
        "C:\\work\\myapi\\repo\\src\\app\\api\\administrator\\roles\\[id]\\route.ts",
      ),
    ).toBe("api/administrator/roles/[id]/route.ts");
  });

  it("reads every handler export shape, and fails the ones defined elsewhere", () => {
    const sf = parseSource(
      "planted.ts",
      `async function handler() { return resolveTargetUser(id, access); }
       export function GET() { return canAccessUser(a, u); }
       export const POST = async () => loadScopedOrg(r, o, a);
       export { handler as PATCH };
       export const { DELETE } = makeHandlers();
       export { PUT } from "./other";
       export * from "./more";`,
    );
    const shapes = routeHandlers(sf).map((h) => [
      h.method,
      h.body === null ? "unreadable" : reachableCallsNamed(sf, h.body, ADMIN_SCOPE_CALLS).length,
    ]);
    expect(shapes).toEqual([
      ["GET", 1],
      ["POST", 1],
      ["PATCH", 1],
      ["DELETE", 0],
      ["PUT", "unreadable"],
      ["*", "unreadable"],
    ]);
  });
});

describe("ADR-0001: every administrator route handler is org-scoped", () => {
  const routes = parseRoutes(ADMIN_ROUTES_DIR);

  it("discovers the administrator route handlers", () => {
    expect(routes.length).toBeGreaterThan(20);
    // 97 handlers when F-127 landed; far fewer means the parse stopped
    // matching the export shapes, not that the surface shrank.
    expect(handlerRows(routes).length).toBeGreaterThan(80);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(ADMIN_EXEMPT, routes, "ADMIN_EXEMPT");
  });

  it.each(handlerRows(routes))(
    "%s calls a scope primitive (or is explicitly exempt)",
    (key, sf, handler) => {
      expectScopedHandler(
        key,
        sf,
        handler,
        ADMIN_SCOPE_CALLS,
        ADMIN_EXEMPT,
        `It touches tenant data without deriving its boundary from ` +
          `@/lib/admin/access-scope.server (canAccessOrg / canAccessUser / resolveOrgScope / ` +
          `hasCrossOrgReach / isSuperadmin) or resolveTargetUser / loadScopedOrg. Call one, or ` +
          `add a justified entry to ADMIN_EXEMPT.`,
      );
    },
  );
});

describe("ADR-0001: every /api/v1 route handler is org-scoped (or self-scoped)", () => {
  const routes = parseRoutes(V1_ROUTES_DIR);

  it("discovers the v1 route handlers", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(handlerRows(routes).length).toBeGreaterThan(15);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(V1_EXEMPT, routes, "V1_EXEMPT");
  });

  it.each(handlerRows(routes))(
    "%s calls a scope primitive (or is explicitly exempt)",
    (key, sf, handler) => {
      expectScopedHandler(
        key,
        sf,
        handler,
        V1_SCOPE_CALLS,
        V1_EXEMPT,
        `It touches tenant data without a scope primitive. Derive its boundary from ` +
          `@/lib/admin/access-scope.server (resolveOrgScope / canAccessOrg / canAccessUser), ` +
          `confine it to the caller via requireApiAccount, or add a justified entry to V1_EXEMPT.`,
      );
    },
  );
});

describe("review #28: every OTHER /api route handler is caller-scoped (or explicitly exempt)", () => {
  const isAdminOrV1 = (route: string) =>
    route.startsWith("api/administrator/") || route.startsWith("api/v1/");
  const routes = parseRoutes(API_ROUTES_DIR).filter((r) => !isAdminOrV1(r.route));

  it("discovers the remaining route handlers", () => {
    expect(routes.length).toBeGreaterThan(15);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(OTHER_EXEMPT, routes, "OTHER_EXEMPT");
  });

  it.each(handlerRows(routes))(
    "%s confines its reads to the caller (or is explicitly exempt)",
    (key, sf, handler) => {
      expectScopedHandler(
        key,
        sf,
        handler,
        OTHER_SCOPE_CALLS,
        OTHER_EXEMPT,
        `Gate it with requireAccountUser / requireApiPermission (or resolve the caller via ` +
          `resolveCaller / getCurrentSession and scope every read to it), derive an org ` +
          `boundary from @/lib/admin/access-scope.server, or add a justified entry to ` +
          `OTHER_EXEMPT.`,
      );
    },
  );
});

describe("review #184: every self-service handler calls the account guard with a scope literal", () => {
  // `requireAccountUser(request)` WITHOUT a scope admits ANY resolvable bearer
  // credential — a read-only or zero-scope key — to the handler. The
  // self-service surface (`/api/account/*`, `/api/v1/me/*`, and since review
  // #28 the `/api/preferences/*` mutations) must therefore always pass the
  // `account.<x>` scope literal the design (§7) assigns, so a new handler that
  // forgets it fails here instead of shipping unscoped. F-127: EVERY handler
  // must call the guard; one scoped call in the file no longer speaks for a
  // sibling method that makes none.
  const routes = [
    ...parseRoutes(ACCOUNT_ROUTES_DIR),
    ...parseRoutes(V1_ME_ROUTES_DIR),
    ...parseRoutes(PREFERENCES_ROUTES_DIR),
  ];
  // Both renderings of the one account decision (review #45): the first-party
  // `requireAccountUser` and the v1 problem+json `requireApiAccount`. Matching
  // only the former would silently stop scanning every `/api/v1/me/*` handler.
  const GUARD_CALLS = new Set(["requireAccountUser", "requireApiAccount"]);
  /**
   * `(request, "account.<x>"[, { …options }])`. The optional third argument is
   * the per-route options bag (IMP-1's `allowImpersonation`); it only ever
   * relaxes the impersonation default, never the scope requirement, so it is
   * tolerated here — the scope literal in position 2 is still mandatory. Which
   * routes may set `allowImpersonation` is policed separately, by
   * tests/unit/session-access-context-invariant.test.ts.
   */
  const isScopedCall = (call: ts.CallExpression): boolean => {
    const [request, scope, options, ...rest] = call.arguments;
    return (
      rest.length === 0 &&
      request !== undefined &&
      ts.isIdentifier(request) &&
      request.text === "request" &&
      scope !== undefined &&
      ts.isStringLiteral(scope) &&
      /^account\.[a-z]+(?:\.[a-z]+)?$/.test(scope.text) &&
      (options === undefined || ts.isObjectLiteralExpression(options))
    );
  };
  const SELF_SERVICE_EXEMPT: Record<string, string> = {
    // Browser redirect target after a scoped sign-in (GET, session-only, no
    // bearer path): it degrades to a plain redirect on every failure, so there
    // is no guard call to scope — the cookie it sets is a selector among the
    // caller's own memberships, never a grant.
    "api/preferences/active-org/apply/route.ts#GET":
      "GET redirect applicator; session-only with no bearer path, degrades to a plain redirect",
  };

  it("discovers the self-service route handlers", () => {
    expect(handlerRows(routes).length).toBeGreaterThan(6);
  });

  it("names only real handlers in the exemption map", () => {
    expectLiveKeys(SELF_SERVICE_EXEMPT, routes, "SELF_SERVICE_EXEMPT");
  });

  it("recognises a scoped call and refuses the unscoped shapes (regression guard)", () => {
    const scopedOf = (source: string) => {
      const sf = parseSource("planted.ts", source);
      return reachableCallsNamed(sf, sf, GUARD_CALLS).map(isScopedCall);
    };
    expect(scopedOf(`requireAccountUser(request, "account.read");`)).toEqual([true]);
    expect(scopedOf(`requireAccountUser(request, "account.profile.write");`)).toEqual([true]);
    expect(
      scopedOf(`requireApiAccount(request, "account.read", { allowImpersonation: true });`),
    ).toEqual([true]);
    expect(scopedOf(`requireAccountUser(request);`)).toEqual([false]);
    expect(scopedOf(`requireAccountUser(request, scope);`)).toEqual([false]);
    expect(scopedOf(`requireAccountUser(request, "admin.users.read");`)).toEqual([false]);
  });

  it.each(handlerRows(routes))(
    "%s calls the account guard, passing an account scope",
    (key, sf, handler) => {
      const reason = SELF_SERVICE_EXEMPT[key];
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      const calls = reachableCallsNamed(sf, handler.body, GUARD_CALLS);
      expect(calls.length, `${key} calls no account guard`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          isScopedCall(call),
          `${key}: the account guard was called as ${call.getText(sf).replace(/\s+/g, " ")} ` +
            `but must pass an "account.<x>" scope literal ` +
            `(e.g. "account.read" for reads, "account.profile.write" / ` +
            `"account.preferences.write" / "account.apikeys.manage" for mutations) so a ` +
            `read-only or zero-scope bearer key cannot reach the handler.`,
        ).toBe(true);
      }
    },
  );
});

describe("MACHINE-2: no route uses isSuperadmin as a tenant boundary", () => {
  /**
   * The sibling of the scans above, for the predicate rather than the module.
   * `BOUNDARY_CALLS` counts `isSuperadmin`, so a route that uses it to decide
   * "may this caller reach every org" passes every scan above unchanged — and
   * silently reintroduces MACHINE-2 (a bearer credential minted in one tenant
   * reaching the whole platform, because `getUserAccessContext` expands a
   * superuser principal to the full permission set on the bound path too).
   *
   * That mistake existed in 18 branches across 16 files and had to be corrected
   * by hand; `main` auto-deploys, so the regression cost is an outage-grade
   * cross-tenant leak. A point-in-time fix does not stop the next one — this
   * does. Reverting any of those `hasCrossOrgReach` gates back to `isSuperadmin`
   * now fails here.
   *
   * TWO uses are legitimate in a route and are recognized by shape or by name:
   *   - the P1-1 conferral idiom `isSuperadmin(x) && <g>.grantedScopes === null`
   *     — a CAPABILITY question about a cookie session, not a tenant boundary;
   *   - a listed exemption, which must say WHY in its value.
   * Anything else must use `hasCrossOrgReach`.
   */
  const SUPERADMIN_CALL = /isSuperadmin\s*\(/g;
  // `isSuperadmin(<args>) && <something>grantedScopes === null` — the exact
  // form the role/group/permission conferral routes use (AUTHZ-3 / P1-1).
  const P1_1_IDIOM = /^\s*\([^()]*\)\s*&&\s*[\w.]*grantedScopes\s*===\s*null/;
  const SUPERADMIN_EXEMPT: Record<string, string> = {
    // Bound 3 of the on-behalf mint asks the rank of the OWNER (a context
    // resolved for someone else entirely), not the reach of the caller — the
    // caller's own bound is the `grantedScopes` argument of
    // `ownerOutranksActor`, which applies the P1-1 rule internally.
    "api/administrator/api-keys/route.ts":
      "asks the OWNER's rank for the layer-2 mint bound, not the caller's tenant reach; the caller bound lives inside ownerOutranksActor",
  };

  const routeFiles = [
    ...walkFiles(ADMIN_ROUTES_DIR, "route.ts"),
    ...walkFiles(V1_ROUTES_DIR, "route.ts"),
  ];

  // Comments discuss `isSuperadmin(...)` at length in exactly the files that
  // correctly avoid it, so strip them before scanning — otherwise the guard
  // would punish the documentation it is meant to encourage.
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("names only real route files in the exemption map", () => {
    for (const key of Object.keys(SUPERADMIN_EXEMPT)) {
      expect(
        routeFiles.some((f) => f.replace(/\\/g, "/").endsWith(key)),
        `SUPERADMIN_EXEMPT names ${key}, which no longer exists — drop the stale entry`,
      ).toBe(true);
    }
  });

  it.each(routeFiles.map((f) => [pathBelow(APP_DIR, f), f] as const))(
    "%s decides cross-tenant reach with hasCrossOrgReach, not isSuperadmin",
    (relPath, full) => {
      const reason = exemptReason(full, SUPERADMIN_EXEMPT);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      const source = stripComments(readFileSync(full, "utf8"));
      for (const match of source.matchAll(SUPERADMIN_CALL)) {
        const tail = source.slice((match.index ?? 0) + "isSuperadmin".length);
        expect(
          P1_1_IDIOM.test(tail),
          `${relPath} calls isSuperadmin(...) outside the P1-1 conferral idiom. ` +
            `isSuperadmin answers "is this principal a superadmin", NOT "may this ` +
            `request reach every org" — an ORG-BOUND bearer credential owned by a ` +
            `global superuser satisfies it and would escape its tenant (MACHINE-2). ` +
            `Use hasCrossOrgReach for the tenant boundary, write the conferral guard ` +
            `as \`isSuperadmin(access) && guard.grantedScopes === null\`, or add a ` +
            `justified entry to SUPERADMIN_EXEMPT.`,
        ).toBe(true);
      }
    },
  );
});

describe("AUTHZ-RSC: every administrator RSC detail page is org-scoped", () => {
  // Detail pages (a dynamic [segment] below /administrator) load a record by
  // id and MUST gate it with canAccessOrg/canAccessUser → notFound(). List and
  // /new pages have no per-id target and delegate to the API routes above. A
  // page has ONE export Next runs, so the page is the unit here; what must
  // hold is a CALL (F-127), not a mention in a comment or an import.
  // Tested below the administrator directory, so the `[locale]` segment above
  // it (or a bracket in the checkout's own path) never marks a list page.
  const pagePath = (f: string) => `administrator/${pathBelow(ADMIN_PAGES_DIR, f)}`;
  const detailPages = walkFiles(ADMIN_PAGES_DIR, "page.tsx").filter((f) =>
    /\[[^\]]+\]/.test(pathBelow(ADMIN_PAGES_DIR, f)),
  );

  it("discovers the administrator detail pages", () => {
    expect(detailPages.length).toBeGreaterThan(4);
  });

  it.each(detailPages.map((f) => [pagePath(f), f] as const))(
    "%s gates the target with canAccessOrg/canAccessUser (or is explicitly exempt)",
    (relPath, full) => {
      const sf = parseSource(full, readFileSync(full, "utf8"));
      const callsScope = reachableCalls(sf, sf).some((call) =>
        PAGE_SCOPE_CALLS.has(calleeName(call) ?? ""),
      );
      const reason = exemptReason(full, PAGE_EXEMPT);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      expect(
        callsScope,
        `${relPath} loads a record by id but calls no access guard. ` +
          `Gate the target with canAccessOrg/canAccessUser → notFound() ` +
          `(preserving existence indistinguishability), or add a justified ` +
          `entry to PAGE_EXEMPT.`,
      ).toBe(true);
    },
  );
});
