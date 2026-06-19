import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * ADR-0001 — administrator LIST-route org-scoping (TEST-1, gap "d").
 *
 * The cross-tenant list/bulk tests pass on pre-seeded rows regardless of the
 * SQL `WHERE`, so a dropped org filter would still pass. As with the CSV
 * exporter, the only way to PROVE the filter reaches SQL is to record every
 * value handed to the query builder and assert the caller's org id appears in
 * a clause for an ORG ADMIN — and does NOT for a SUPERADMIN.
 *
 * This drives the real list handlers (users / organizations / roles) with the
 * real resolveOrgScope + list-query helpers over a recording `db` stub; only
 * the auth layer is mocked to inject the caller's scope.
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
// The users route imports auth-admin.server for its POST handler, which eagerly
// constructs Better Auth (reads env) at import. The GET list path never touches
// it — stub it so importing the route module doesn't require auth env.
vi.mock("@/lib/admin/auth-admin.server", () => ({ createBetterAuthUser: vi.fn() }));

// Recording query-builder stub — same pattern as export-org-scope.test.ts:
// every string/number passed to any builder method is captured; function args
// (eb callbacks) are invoked with the recorder so nested clause values (e.g.
// the org id inside `eb.exists(... where organization_id = orgId)`) are caught.
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

function listReq(path: string): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return { nextUrl: url, url: url.toString(), headers: new Headers() } as unknown as NextRequest;
}

// route module path → required read permission + the list endpoint path.
const ROUTES = [
  { name: "users", mod: "@/app/api/administrator/users/route", perm: "admin.users.read" },
  {
    name: "organizations",
    mod: "@/app/api/administrator/organizations/route",
    perm: "admin.orgs.read",
  },
  { name: "roles", mod: "@/app/api/administrator/roles/route", perm: "admin.roles.read" },
] as const;

beforeEach(() => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  // One row carrying a window-count so executeListWithTotal returns a page.
  state.dataRows = [{ id: "r1", __total: "1", created_at: "2026-01-01T00:00:00Z" }];
  state.whereValues = [];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
});
afterEach(() => vi.resetModules());

describe("administrator list routes — ADR-0001 org filter reaches SQL", () => {
  for (const r of ROUTES) {
    describe(`GET /api/administrator/${r.name}`, () => {
      it("ORG ADMIN: the caller's org id reaches a WHERE clause", async () => {
        accessGetter.mockResolvedValue(orgAdmin([r.perm]));
        const { GET } = await import(r.mod);
        const res = await GET(listReq(`/api/administrator/${r.name}`));
        expect(res.status).toBe(200);
        expect(state.whereValues).toContain(ORG_A);
      });

      it("SUPERADMIN: the query is never narrowed to a specific org", async () => {
        accessGetter.mockResolvedValue(superadmin([r.perm]));
        const { GET } = await import(r.mod);
        const res = await GET(listReq(`/api/administrator/${r.name}`));
        expect(res.status).toBe(200);
        expect(state.whereValues).not.toContain(ORG_A);
      });
    });
  }
});
