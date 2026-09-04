import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
 *   2. `/api/v1/**` route handlers              — same access-scope module, or requireAccountUser (self-scoped)
 *   3. administrator RSC *detail* pages          — canAccessOrg / canAccessUser → notFound()
 *
 * Each surface has its own tiny EXEMPT list (platform-global / public
 * surfaces with no tenant column). Adding to one should be a conscious,
 * reviewed decision — not a reflex to make the test pass.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const ADMIN_ROUTES_DIR = join(SRC_DIR, "app", "api", "administrator");
const V1_ROUTES_DIR = join(SRC_DIR, "app", "api", "v1");
const ACCOUNT_ROUTES_DIR = join(SRC_DIR, "app", "api", "account");
const V1_ME_ROUTES_DIR = join(V1_ROUTES_DIR, "me");
// `[locale]` and `(secure)` are literal directory names — build the path with
// join() (not new URL(), which would percent-encode the brackets).
const ADMIN_PAGES_DIR = join(SRC_DIR, "app", "[locale]", "(secure)", "app", "administrator");

// The canonical org-boundary module + the helpers that embed it by contract.
const ADMIN_SCOPE_MARKERS = [
  "@/lib/admin/access-scope.server",
  // resolveTargetUser(id, access) embeds canAccessUser — scoped by contract.
  "resolveTargetUser",
  // loadScopedOrg(request, orgId, access) embeds canAccessOrg (returning a 404
  // for a foreign org) — the shared org-load helper the /organizations/[id]/*
  // sub-routes derive their boundary from, scoped by contract.
  "loadScopedOrg",
  // selectDashboardMetrics(access) derives system-vs-org scope from
  // access-scope.server (isSuperadmin / resolveOrgScope) by construction.
  "selectDashboardMetrics",
];

// v1 routes scope tenant data via the SAME access-scope module; self-service
// `/me/*` routes are confined to the caller's own account via requireAccountUser.
const V1_SCOPE_MARKERS = ["@/lib/admin/access-scope.server", "requireAccountUser"];

// RSC detail pages enforce the boundary directly before rendering.
const PAGE_SCOPE_MARKERS = ["canAccessOrg", "canAccessUser"];

const ADMIN_EXEMPT: Record<string, string> = {
  // The email TEMPLATE catalog is platform-global config — identical for
  // every tenant, with no organization column — so reading the list is not a
  // cross-tenant leak. Editing a template (PUT under templates/[id]) affects
  // all tenants and IS SUPERADMIN-gated there, so templates/[id] is NOT
  // exempt; only this read-only list route is.
  "administrator/email/templates/route.ts":
    "platform-global template catalog (no tenant column); read-only list, edits are SUPERADMIN-gated in templates/[id]",
};

const V1_EXEMPT: Record<string, string> = {
  // The credential IS the auth — the token endpoint mints a JWT, it does not
  // read tenant data. It is rate-limited per client/IP plus a global floor.
  "api/v1/auth/token/route.ts":
    "credential mint; the credential is the auth, no tenant-data read. Rate-limited per client/IP + global floor.",
  // Public, unauthenticated, platform-global — no tenant data.
  "api/v1/jwks.json/route.ts": "public JWKS; platform-global signing keys, no tenant data",
  "api/v1/openapi.json/route.ts": "public API description; platform-global, no tenant data",
};

const PAGE_EXEMPT: Record<string, string> = {
  // Email templates are platform-global (no organization column) and the
  // detail page is SUPERADMIN-gated via checkAdminPermissionServer — there is
  // no per-org access to check. Mirrors the templates list-route exemption.
  "email/templates/[templateId]/page.tsx":
    "platform-global template (no tenant column); SUPERADMIN-gated via checkAdminPermissionServer, no per-org access to check",
};

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

function rel(full: string, anchor: string): string {
  const norm = full.replace(/\\/g, "/");
  const idx = norm.indexOf(anchor);
  return idx >= 0 ? norm.slice(idx) : norm;
}

describe("ADR-0001: every administrator route is org-scoped", () => {
  const routeFiles = walkFiles(ADMIN_ROUTES_DIR, "route.ts");

  it("discovers the administrator route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it.each(routeFiles.map((f) => [rel(f, "administrator"), f] as const))(
    "%s references a scope primitive (or is explicitly exempt)",
    (relPath, full) => {
      const source = readFileSync(full, "utf8");
      const referencesScope = ADMIN_SCOPE_MARKERS.some((m) => source.includes(m));
      const reason = exemptReason(full, ADMIN_EXEMPT);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      expect(
        referencesScope,
        `${relPath} touches tenant data but references no org-scope primitive. ` +
          `Derive its boundary from @/lib/admin/access-scope.server ` +
          `(canAccessOrg / canAccessUser / resolveOrgScope / isSuperadmin) ` +
          `or resolveTargetUser, or add a justified entry to ADMIN_EXEMPT.`,
      ).toBe(true);
    },
  );
});

describe("ADR-0001: every /api/v1 route is org-scoped (or self-scoped)", () => {
  const routeFiles = walkFiles(V1_ROUTES_DIR, "route.ts");

  it("discovers the v1 route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles.map((f) => [rel(f, "api/v1"), f] as const))(
    "%s references a scope primitive (or is explicitly exempt)",
    (relPath, full) => {
      const source = readFileSync(full, "utf8");
      const referencesScope = V1_SCOPE_MARKERS.some((m) => source.includes(m));
      const reason = exemptReason(full, V1_EXEMPT);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      expect(
        referencesScope,
        `${relPath} touches tenant data but references no scope primitive. ` +
          `Derive its boundary from @/lib/admin/access-scope.server ` +
          `(resolveOrgScope / canAccessOrg / canAccessUser), confine it to the ` +
          `caller via requireAccountUser, or add a justified entry to V1_EXEMPT.`,
      ).toBe(true);
    },
  );
});

describe("review #184: every self-service guard call names an account scope literal", () => {
  // `requireAccountUser(request)` WITHOUT a scope admits ANY resolvable bearer
  // credential — a read-only or zero-scope key — to the handler. The
  // self-service surface (`/api/account/*`, `/api/v1/me/*`) must therefore
  // always pass the `account.<x>` scope literal the design (§7) assigns, so a
  // new handler that forgets it fails here instead of shipping unscoped.
  const routeFiles = [
    ...walkFiles(ACCOUNT_ROUTES_DIR, "route.ts"),
    ...walkFiles(V1_ME_ROUTES_DIR, "route.ts"),
  ];
  const GUARD_CALL = /requireAccountUser\s*\(([^)]*)\)/g;
  const SCOPED_CALL = /^\s*request\s*,\s*"account\.[a-z]+(?:\.[a-z]+)?"\s*$/;

  it("discovers the self-service route handlers", () => {
    expect(routeFiles.length).toBeGreaterThan(4);
  });

  it.each(routeFiles.map((f) => [rel(f, "api/"), f] as const))(
    "%s passes an account scope to every requireAccountUser call",
    (relPath, full) => {
      const source = readFileSync(full, "utf8");
      const calls = [...source.matchAll(GUARD_CALL)].map((m) => m[1] ?? "");
      expect(calls.length, `${relPath} has no requireAccountUser call`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(
          SCOPED_CALL.test(args),
          `${relPath}: requireAccountUser(${args.trim()}) must pass an "account.<x>" scope literal ` +
            `(e.g. "account.read" for reads, "account.profile.write" / ` +
            `"account.preferences.write" / "account.apikeys.manage" for mutations) so a ` +
            `read-only or zero-scope bearer key cannot reach the handler.`,
        ).toBe(true);
      }
    },
  );
});

describe("AUTHZ-RSC: every administrator RSC detail page is org-scoped", () => {
  // Detail pages (a dynamic [segment] below /administrator) load a record by
  // id and MUST gate it with canAccessOrg/canAccessUser → notFound(). List and
  // /new pages have no per-id target and delegate to the API routes above.
  const detailPages = walkFiles(ADMIN_PAGES_DIR, "page.tsx").filter((f) =>
    /\[[^\]]+\]/.test(rel(f, "administrator")),
  );

  it("discovers the administrator detail pages", () => {
    expect(detailPages.length).toBeGreaterThan(4);
  });

  it.each(detailPages.map((f) => [rel(f, "administrator"), f] as const))(
    "%s gates the target with canAccessOrg/canAccessUser (or is explicitly exempt)",
    (relPath, full) => {
      const source = readFileSync(full, "utf8");
      const referencesScope = PAGE_SCOPE_MARKERS.some((m) => source.includes(m));
      const reason = exemptReason(full, PAGE_EXEMPT);
      if (reason !== undefined) {
        expect(reason.length).toBeGreaterThan(0);
        return;
      }
      expect(
        referencesScope,
        `${relPath} loads a record by id but references no access guard. ` +
          `Gate the target with canAccessOrg/canAccessUser → notFound() ` +
          `(preserving existence indistinguishability), or add a justified ` +
          `entry to PAGE_EXEMPT.`,
      ).toBe(true);
    },
  );
});
