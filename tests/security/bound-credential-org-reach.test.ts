import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ResolveCallerModule from "@/lib/api-auth/resolve-caller.server";
import { SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/**
 * MACHINE-2 — a BEARER CREDENTIAL BOUND TO ONE ORG CANNOT REACH ANOTHER,
 * even when its owner is a GLOBAL SUPERUSER.
 *
 * The vulnerability this pins closed: `resolveCaller` resolves an API key /
 * JWT against the org it was minted in and never the `active_org` cookie
 * (MACHINE-1) — but `getUserAccessContext` then expands a global superuser
 * principal to the FULL superuser permission set on that same bound path, and
 * `resolveOrgScope` / `canAccessOrg` / `canAccessUser` answered "every org" to
 * anyone holding the marker. A key minted in org A therefore administered the
 * whole platform, and an org admin holding `admin.apikeys.manage` who shared an
 * org with ANY superuser (support staff parked in a customer tenant, or the
 * seeded default admin) could mint exactly such a key on their behalf and
 * pocket the one-time plaintext.
 *
 * This drives the REAL `/api/v1` routes over the REAL guard
 * (`requireApiPermission`) and the REAL access-scope helpers; only the caller
 * resolver and the database are stubbed. The injected access context is the
 * one `getUserAccessContext` genuinely produces for this case — the full
 * superuser permission set, `organizationId: ORG_A`, `orgBound: true` (the
 * marker itself is pinned against the real resolver in
 * tests/unit/auth-status-db.test.ts).
 *
 * Every assertion below FAILS without the fix: with the old
 * `isSuperadmin`-only bypass the list query carried no org predicate, and both
 * `[id]` routes answered 200 for an org-B user. The paired
 * `orgBound: false` cases are the control — a human superadmin at a browser
 * must keep cross-org reach, so this cannot pass by simply denying everyone.
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** A user whose ONLY membership is in org B. */
const ORG_B_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const auditMock = vi.fn();

/**
 * Recording query stub. Every scalar handed to any builder method — including
 * the ones inside a nested `eb => eb.exists(...)` callback — is captured, so we
 * can assert the org predicate actually REACHED SQL. Asserting on returned rows
 * would not: a route whose `where` was silently dropped still gets the rows the
 * stub was primed with (same reasoning as
 * tests/security/admin-list-org-scope.test.ts).
 *
 * `app_organization_memberships` is the one table that also has to ANSWER
 * truthfully, because `canAccessUser` derives its 404 from it: the target user
 * holds a membership in ORG_B and nowhere else.
 */
const state: {
  /** Every scalar ANY builder saw, including inside nested `eb` callbacks. */
  values: string[];
  listRows: unknown[];
  userRow: Record<string, unknown> | undefined;
} = { values: [], listRows: [], userRow: undefined };

function builderFor(table: string): unknown {
  const values: string[] = [];
  const record = (args: unknown[]) => {
    for (const a of args) {
      if (typeof a === "string") {
        values.push(a);
        state.values.push(a);
      } else if (typeof a === "function") {
        // An `eb => eb.exists(eb.selectFrom(...).where(...))` callback: the org
        // predicate lives INSIDE it, so invoke it with a recorder of its own.
        try {
          (a as (eb: unknown) => unknown)(builderFor(table));
        } catch {
          /* best-effort */
        }
      } else if (Array.isArray(a)) record(a);
    }
  };
  const proxy: unknown = new Proxy(function () {}, {
    apply(_t, _this, args) {
      record(args);
      return proxy;
    },
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "execute") {
        return async () => state.listRows;
      }
      if (prop === "executeTakeFirst") {
        return async () => {
          if (table === "app_users") return state.userRow;
          if (table === "app_organization_memberships") {
            // The target is a member of ORG_B only.
            return values.includes(ORG_B) ? { id: "m-org-b" } : undefined;
          }
          return state.listRows[0];
        };
      }
      return (...args: unknown[]) => {
        record(args);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("@/db/database", () => ({
  pgPool: {},
  db: { selectFrom: (table: string) => builderFor(table) },
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
// `/api/v1/users` imports the Better Auth admin helper for its POST handler,
// which constructs Better Auth (and a real DB adapter) at import time. The GET
// path under test never touches it.
vi.mock("@/lib/admin/auth-admin.server", () => ({ createBetterAuthUser: vi.fn() }));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
}));
// The status route's mutation core opens a transaction; it must never be
// reached for an out-of-scope target, and this stub makes that observable.
const statusChangeMock = vi.fn();
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: (...a: unknown[]) => statusChangeMock(...a),
}));

// The caller resolver is the ONE seam: it is where a real request turns into a
// bearer principal. Everything downstream — guard, scope helpers, routes — runs
// for real.
const caller: { value: ResolveCallerModule.ResolvedCaller | null } = { value: null };
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  hasBearerCredential: () => true,
  resolveCaller: async () => caller.value,
  resolveCallerDetailed: async () =>
    caller.value ? { ok: true, caller: caller.value } : { ok: false, reason: "no_credential" },
}));

/** The access context `getUserAccessContext` produces for a global superuser. */
function superuserAccess(
  organizationId: string | null,
  orgBound: boolean,
): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "su-1",
    primaryEmail: "superuser@platform.local",
    status: "active",
    organizationId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: [...SUPERUSER_PERMISSIONS],
    orgBound,
  };
}

/** A key minted in org A, owned by a global superuser (the exploit's product). */
function boundSuperuserKey(): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "api_key",
    betterAuthUserId: "ba-superuser",
    access: superuserAccess(ORG_A, true),
    // Scopes the minting org admin could legitimately hold themselves, so the
    // existing scope bounds (design §7) are all satisfied — scope names never
    // bounded REACH, which is the whole point.
    grantedScopes: ["admin.users.read", "admin.users.manage", "admin.apikeys.read"],
    isBearer: true,
    credentialId: "key-org-a",
    boundOrganizationId: ORG_A,
    impersonatorId: null,
  };
}

/** The control: the same human, at a browser. */
function cookieSuperadmin(): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "session",
    betterAuthUserId: "ba-superuser",
    access: superuserAccess(ORG_A, false),
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
    boundOrganizationId: null,
    impersonatorId: null,
  };
}

function req(path: string, init: { body?: unknown } = {}): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers({
      authorization: "Bearer drk_live_test",
      "content-type": "application/json",
    }),
    method: init.body === undefined ? "GET" : "POST",
    json: async () => init.body,
  } as unknown as NextRequest;
}

/** Every scalar the route handed to the query builder, nested clauses included. */
function sqlValues(): string[] {
  return state.values;
}

beforeEach(() => {
  auditMock.mockReset();
  statusChangeMock.mockReset();
  statusChangeMock.mockResolvedValue({ ok: true, status: "blocked" });
  state.values = [];
  state.listRows = [{ id: "r1", __total: "1", created_at: "2026-01-01T00:00:00Z" }];
  state.userRow = {
    id: ORG_B_USER,
    better_auth_user_id: "ba-victim",
    primary_email: "victim@org-b.example",
    display_name: null,
    status: "active",
    status_reason: null,
    preferred_locale: "en",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  caller.value = boundSuperuserKey();
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/users — a superuser-owned key minted in org A lists ONLY org A", () => {
  it("emits an org-A predicate instead of an unscoped cross-tenant query", async () => {
    const { GET } = await import("@/app/api/v1/users/route");
    const res = await GET(req("/api/v1/users"));

    expect(res.status).toBe(200);
    // The bound org reached SQL; the other tenant is nowhere in the query.
    expect(sqlValues()).toContain(ORG_A);
    expect(sqlValues()).not.toContain(ORG_B);
  });

  it("CONTROL: the same principal on a cookie session still lists every tenant", async () => {
    caller.value = cookieSuperadmin();
    const { GET } = await import("@/app/api/v1/users/route");
    const res = await GET(req("/api/v1/users"));

    expect(res.status).toBe(200);
    // `{ kind: "all" }` → no membership-exists subquery at all.
    expect(sqlValues()).not.toContain(ORG_A);
  });
});

describe("GET /api/v1/users/[id] — no cross-tenant READ through a bound credential", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B_USER }) };

  it("404s for a user who holds a membership only in org B", async () => {
    const { GET } = await import("@/app/api/v1/users/[id]/route");
    const res = await GET(req(`/api/v1/users/${ORG_B_USER}`), ctx);
    expect(res.status).toBe(404);
  });

  it("CONTROL: a cookie superadmin still reads that user (200)", async () => {
    caller.value = cookieSuperadmin();
    const { GET } = await import("@/app/api/v1/users/[id]/route");
    const res = await GET(req(`/api/v1/users/${ORG_B_USER}`), ctx);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/users/[id]/status — no cross-tenant MUTATION through a bound credential", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B_USER }) };

  it("404s and never reaches the status-change core for an org-B target", async () => {
    const { POST } = await import("@/app/api/v1/users/[id]/status/route");
    const res = await POST(
      req(`/api/v1/users/${ORG_B_USER}/status`, { body: { action: "block" } }),
      ctx,
    );

    expect(res.status).toBe(404);
    expect(statusChangeMock).not.toHaveBeenCalled();
  });

  it("CONTROL: a cookie superadmin blocks that user (200) through the same route", async () => {
    caller.value = cookieSuperadmin();
    const { POST } = await import("@/app/api/v1/users/[id]/status/route");
    const res = await POST(
      req(`/api/v1/users/${ORG_B_USER}/status`, { body: { action: "block" } }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(statusChangeMock).toHaveBeenCalledTimes(1);
    // A cookie superadmin is unscoped — the core receives `{ kind: "all" }`.
    expect(statusChangeMock.mock.calls[0]?.[0]).toMatchObject({ scope: { kind: "all" } });
  });
});
