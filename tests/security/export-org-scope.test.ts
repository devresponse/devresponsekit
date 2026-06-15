import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ExportRoute from "@/app/api/administrator/export/[resource]/route";

/**
 * ADR-0001 — CSV export org-scoping (the highest-risk bulk-exfil surface).
 *
 * `GET /api/administrator/export/[resource]` streams a CSV built by a
 * per-resource exporter. Each exporter MUST confine its rows to the
 * caller's org: SUPERADMIN → all, ORG ADMIN → their org only, null scope →
 * nothing. Because the rows are filtered by a SQL `WHERE` (not an `[id]`
 * lookup), a plain mock that ignores `WHERE` cannot prove scoping — so the
 * `db` mock here RECORDS every value handed to the query builder (including
 * inside `eb` callbacks) and we assert the caller's org id actually reaches
 * a clause. The null-scope case is proved structurally: the exporter
 * returns `[]` before querying, so the CSV is header-only.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: { dataRows: unknown[]; whereValues: (string | number)[] } = {
  dataRows: [],
  whereValues: [],
};

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
// No-op the limiter so 7 resources × 3 scopes don't exhaust the bucket.
vi.mock("@/lib/admin/rate-limit.server", () => ({
  enforceRateLimit: () => null,
  DEFAULT_ADMIN_EXPORT_LIMIT: { capacity: 9999, refillPerSec: 9999 },
}));

// Recording query-builder stub: every string/number passed to any builder
// method (where, whereRef, eb(...), eb.or, …) is captured; function args
// (eb callbacks) are invoked with the same recorder so nested clause values
// — e.g. the org id inside `eb.exists(... where organization_id = orgId)` —
// are captured too.
function capture(args: unknown[]) {
  for (const a of args) {
    if (typeof a === "string" || typeof a === "number") state.whereValues.push(a);
    else if (typeof a === "function") {
      try {
        (a as (eb: unknown) => unknown)(recorder);
      } catch {
        /* best-effort */
      }
    } else if (Array.isArray(a)) {
      capture(a);
    }
  }
}
const recorder: unknown = new Proxy(function () {}, {
  apply(_t, _this, args) {
    capture(args);
    return recorder;
  },
  get(_t, prop) {
    if (typeof prop === "symbol") return undefined;
    if (prop === "then") return undefined;
    if (prop === "execute") return async () => state.dataRows;
    if (prop === "executeTakeFirst") return async () => state.dataRows[0];
    return (...args: unknown[]) => {
      capture(args);
      return recorder;
    };
  },
});

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (...a: unknown[]) => {
      capture(a);
      return recorder;
    },
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function orgAdmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "admin-1",
    primaryEmail: "admin@org-a.com",
    status: "active",
    organizationId: ORG_A,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: perms,
  };
}
function superadmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return { ...orgAdmin(perms), organizationId: null, permissions: [...perms, "superuser"] };
}
function nullScopeAdmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return { ...orgAdmin(perms), organizationId: null };
}

function req(resource: string): NextRequest {
  const url = `http://test.local/api/administrator/export/${resource}`;
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
}
const ctx = (resource: string) => ({ params: Promise.resolve({ resource }) });

/** Count CSV data rows (total lines minus the header). */
function dataRowCount(text: string): number {
  const lines = text.trim().split("\n");
  return Math.max(0, lines.length - 1);
}

let GET: typeof ExportRoute.GET;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.dataRows = [
    { id: "r1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];
  state.whereValues = [];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET } = await import("@/app/api/administrator/export/[resource]/route"));
});
afterEach(() => vi.resetModules());

// resource → required read permission, and whether it is tenant-scoped
// (`permissions` is the platform-global catalog and carries no org filter).
const RESOURCES = [
  { name: "users", perm: "admin.users.read", tenantScoped: true },
  { name: "audit", perm: "admin.audit.read", tenantScoped: true },
  { name: "organizations", perm: "admin.orgs.read", tenantScoped: true },
  { name: "roles", perm: "admin.roles.read", tenantScoped: true },
  { name: "memberships", perm: "admin.orgs.read", tenantScoped: true },
  { name: "enterprise-apps", perm: "admin.apps.read", tenantScoped: true },
  { name: "permissions", perm: "admin.roles.read", tenantScoped: false },
] as const;

describe("GET /export/[resource] — ADR-0001 org-scoped CSV", () => {
  for (const r of RESOURCES) {
    describe(`resource: ${r.name}`, () => {
      it("null-scope admin exports ZERO data rows (header only)", async () => {
        accessGetter.mockResolvedValue(nullScopeAdmin([r.perm]));
        const res = await GET(req(r.name), ctx(r.name));
        expect(res.status).toBe(200);
        expect(dataRowCount(await res.text())).toBe(0);
      });

      it(
        "ORG ADMIN export streams rows" + (r.tenantScoped ? " constrained to their org" : ""),
        async () => {
          accessGetter.mockResolvedValue(orgAdmin([r.perm]));
          const res = await GET(req(r.name), ctx(r.name));
          expect(res.status).toBe(200);
          expect(dataRowCount(await res.text())).toBeGreaterThan(0);
          if (r.tenantScoped) {
            // The caller's org id must reach a WHERE clause.
            expect(state.whereValues).toContain(ORG_A);
          }
        },
      );

      it("SUPERADMIN export streams rows with NO org constraint", async () => {
        accessGetter.mockResolvedValue(superadmin([r.perm]));
        const res = await GET(req(r.name), ctx(r.name));
        expect(res.status).toBe(200);
        expect(dataRowCount(await res.text())).toBeGreaterThan(0);
        // A superadmin's query is never narrowed to a specific org.
        expect(state.whereValues).not.toContain(ORG_A);
      });
    });
  }

  it("rejects a caller lacking the resource read permission (403)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["shell.view"]));
    const res = await GET(req("users"), ctx("users"));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown resource", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.users.read"]));
    const res = await GET(req("not-a-resource"), ctx("not-a-resource"));
    expect(res.status).toBe(404);
  });
});

describe("GET /export/[resource] — truncation signal (bug-3)", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      created_at: "2026-01-01T00:00:00Z",
      primary_email: `u${i}@x.com`,
      display_name: `User ${i}`,
      status: "active",
    }));

  afterEach(() => {
    delete process.env.ADMIN_EXPORT_MAX_ROWS;
  });

  it("appends a `# export_truncated:` sentinel when the row cap is hit", async () => {
    // Lower the cap (read at module load) so a tiny dataset overflows it —
    // the cap is operator-tunable via ADMIN_EXPORT_MAX_ROWS. The mock returns
    // the same page on every fetch, so the source looks infinite; the route
    // must mark the body (a header can't — truncation is only known
    // mid-stream, after the 200 + headers are sent).
    vi.resetModules();
    process.env.ADMIN_EXPORT_MAX_ROWS = "5";
    const { GET: cappedGET } = await import("@/app/api/administrator/export/[resource]/route");
    state.dataRows = rows(10);
    accessGetter.mockResolvedValue(superadmin(["admin.users.read"]));
    const res = await cappedGET(req("users"), ctx("users"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# export_truncated:");
  });

  it("does NOT add the sentinel when the export fits under the cap", async () => {
    // A single short page (< PAGE_SIZE) exhausts the source immediately.
    state.dataRows = rows(1);
    accessGetter.mockResolvedValue(superadmin(["admin.users.read"]));
    const res = await GET(req("users"), ctx("users"));
    const body = await res.text();
    expect(body).not.toContain("# export_truncated:");
  });
});
