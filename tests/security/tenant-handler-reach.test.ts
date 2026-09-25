import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ResolveCallerModule from "@/lib/api-auth/resolve-caller.server";
import { SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/**
 * F-42 — THE TENANT BOUNDARY OF EACH HANDLER METHOD IS PINNED BY BEHAVIOUR,
 * NOT BY AN IMPORT.
 *
 * The review found tenant-data handler methods whose tenant boundary no test
 * exercised. `GET`/`DELETE /api/v1/admin/oauth-clients/[id]`,
 * `DELETE /api/administrator/api-keys/[id]`, `GET /api/administrator/users/[id]`,
 * `GET /api/administrator/email/templates/[id]`,
 * `GET /api/administrator/permissions` and `GET
 * /api/administrator/groups/[id]/roles` were never called by the
 * coverage-gated suite (the live-Postgres tests/db suite calls two of them,
 * but it feeds no coverage). `GET /api/v1/audit-events` and `PATCH
 * /api/v1/admin/oauth-clients/[id]` ran only behind a mocked guard, `PATCH
 * /api/administrator/users/[id]` only for input validation, and `DELETE
 * /api/v1/admin/api-keys/[id]` only for the caller's own org. What watched
 * them was `tests/unit/admin-route-scope-invariant.test.ts`, which checks that
 * each route FILE imports a scope helper. It still passes when a handler drops
 * its `canAccessOrg` check or its org predicate, because the import stays
 * behind for the sibling methods.
 *
 * This file calls each of those methods. It drives the REAL guards
 * (`requireApiPermission`, `requireAdminPermission`), the REAL access-scope
 * helpers and the REAL credential stores (`getOauthClientById`,
 * `revokeApiKey`, ...), exactly as tests/security/bound-credential-org-reach
 * does. Only the caller resolver (where a request becomes a principal), the
 * database and the audit sink are stubbed. The database stub RECORDS every
 * builder call, so a cross-tenant request is proven to write nothing, and a
 * list is proven to carry the caller's org predicate into SQL. Asserting on
 * the returned rows would prove nothing, because the stub returns its primed
 * rows whatever the `where`.
 *
 * What is checked depends on the handler. A tenant resource (`[id]`) gets the
 * cross-org 404 and the MACHINE-2 bound-key case; a tenant list gets the org
 * predicate in SQL; the two platform catalogs (email templates, permissions)
 * have no tenant column, so their boundary is the read permission (a 403 that
 * never queries). Each 404 / 403 / predicate case fails when the guard line it
 * pins is removed (checked one guard at a time for F-42). The 200 cases (the
 * caller's own org or a holder of the read permission, and for most tenant
 * methods a superadmin at a browser) must succeed, so the file cannot pass by
 * denying everyone.
 * `vitest.config.ts` also gives every `/api/v1` route file, and each
 * administrator file here, a coverage floor of its own, so a handler method
 * that no test invokes fails CI even when this file is not updated.
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** An app user whose ONLY membership is in org A. */
const USER_IN_A = "11111111-1111-4111-8111-11111111111a";
/** An app user whose ONLY membership is in org B. */
const USER_IN_B = "11111111-1111-4111-8111-11111111111b";
/** The id of whichever single resource (key, client, group, template) a case reads. */
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";

const auditMock = vi.fn();
const updateBetterAuthUser = vi.fn();

type Verb = "select" | "update";
interface BuilderCall {
  table: string;
  verb: Verb;
  method: string;
  args: unknown[];
}

/**
 * Recording query stub. Every builder method call is logged with its table
 * and verb (`selectFrom` vs `updateTable`), and every scalar a builder saw,
 * including inside a nested `eb => ...` callback, is kept for that builder.
 *
 * `app_organization_memberships` is the one table that has to ANSWER
 * truthfully, because `canAccessUser` derives its 404 from it: a membership
 * row exists only when the query names a user AND an org that user belongs to
 * in `state.memberships`. Every other `executeTakeFirst` returns the first
 * row primed for its table, and an update reports one row changed.
 */
const state: {
  calls: BuilderCall[];
  rows: Record<string, Record<string, unknown>[]>;
  memberships: Record<string, string[]>;
} = { calls: [], rows: {}, memberships: {} };

function tableName(raw: unknown): string {
  // `"app_api_keys as k"` → `"app_api_keys"`.
  return String(raw).split(" ")[0] ?? "";
}

function builderFor(table: string, verb: Verb): unknown {
  const values: unknown[] = [];
  const collect = (args: unknown[]) => {
    for (const a of args) {
      if (typeof a === "string") values.push(a);
      else if (Array.isArray(a)) collect(a);
      else if (typeof a === "function") {
        // An `eb => eb.exists(eb.selectFrom(...).where(...))` callback: its
        // predicate lives INSIDE it, so run it against a recorder of its own.
        try {
          (a as (eb: unknown) => unknown)(builderFor(table, verb));
        } catch {
          /* best-effort */
        }
      }
    }
  };
  const record = (method: string, args: unknown[]) => {
    state.calls.push({ table, verb, method, args });
    collect(args);
  };
  const first = (): unknown => {
    if (verb === "update") return { numUpdatedRows: BigInt(1) };
    if (table === "app_organization_memberships") {
      const member = Object.entries(state.memberships).some(
        ([user, orgs]) => values.includes(user) && orgs.some((org) => values.includes(org)),
      );
      return member ? { id: "membership-row" } : undefined;
    }
    return state.rows[table]?.[0];
  };
  const proxy: unknown = new Proxy(function () {}, {
    apply(_t, _this, args) {
      record("(eb)", args);
      return proxy;
    },
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "execute") {
        return async () => (verb === "select" ? (state.rows[table] ?? []) : []);
      }
      if (prop === "executeTakeFirst") return async () => first();
      if (prop === "executeTakeFirstOrThrow") {
        return async () => {
          const row = first();
          if (row === undefined) throw new Error(`no row in ${table}`);
          return row;
        };
      }
      return (...args: unknown[]) => {
        record(String(prop), args);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("@/db/database", () => ({
  pgPool: {},
  db: {
    selectFrom: (table: unknown) => builderFor(tableName(table), "select"),
    updateTable: (table: unknown) => builderFor(tableName(table), "update"),
  },
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
// The admin guard module also exports the RSC gate, which reads the session
// through `auth-guard` (and so Better Auth). `requireAdminPermission` never
// calls it: it resolves the caller through the seam below.
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: vi.fn() }));
// `users/[id]` mirrors a display name to Better Auth; the auth instance is not
// what this file exercises.
vi.mock("@/lib/admin/auth-admin.server", () => ({
  banBetterAuthUser: vi.fn(),
  unbanBetterAuthUser: vi.fn(),
  updateBetterAuthUser: (...a: unknown[]) => updateBetterAuthUser(...a),
}));

// The caller resolver is the ONE auth seam: it is where a real request turns
// into a principal. Guards, scope helpers, stores and routes all run for real.
// `hasBearerCredential` answers true for every caller, so the cookie-only CSRF
// origin check is skipped here; it has suites of its own.
const caller: { value: ResolveCallerModule.ResolvedCaller | null } = { value: null };
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  hasBearerCredential: () => true,
  resolveCaller: async () => caller.value,
  resolveCallerDetailed: async () =>
    caller.value ? { ok: true, caller: caller.value } : { ok: false, reason: "no_credential" },
}));

function accessContext(opts: {
  organizationId: string | null;
  permissions: ReadonlyArray<string>;
  orgBound: boolean;
}): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "actor-app-user",
    primaryEmail: "actor@example.com",
    status: "active",
    organizationId: opts.organizationId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: [...opts.permissions],
    orgBound: opts.orgBound,
  };
}

/** An org-A administrator's API key: bound to org A, scoped to what its owner holds. */
function orgAdminKey(
  permissions: string[],
  organizationId: string | null = ORG_A,
): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "api_key",
    betterAuthUserId: "ba-org-admin",
    access: accessContext({ organizationId, permissions, orgBound: true }),
    grantedScopes: permissions,
    isBearer: true,
    credentialId: "key-org-admin",
    boundOrganizationId: organizationId,
    impersonatorId: null,
  };
}

/** The same org-A administrator at a browser: a cookie session, not a key. */
function orgAdminSession(permissions: string[]): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "session",
    betterAuthUserId: "ba-org-admin",
    access: accessContext({ organizationId: ORG_A, permissions, orgBound: false }),
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
    boundOrganizationId: null,
    impersonatorId: null,
  };
}

/**
 * MACHINE-2: a key minted in org A whose OWNER is a global superuser. Its
 * access context is the one `getUserAccessContext` really produces for it, the
 * full superuser set with `orgBound: true`, so only the tenant cap confines it.
 */
function boundSuperuserKey(scopes: string[]): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "api_key",
    betterAuthUserId: "ba-superuser",
    access: accessContext({
      organizationId: ORG_A,
      permissions: SUPERUSER_PERMISSIONS,
      orgBound: true,
    }),
    grantedScopes: scopes,
    isBearer: true,
    credentialId: "key-superuser-org-a",
    boundOrganizationId: ORG_A,
    impersonatorId: null,
  };
}

/** The control: a superadmin at a browser keeps its cross-tenant reach. */
function cookieSuperadmin(): ResolveCallerModule.ResolvedCaller {
  return {
    kind: "session",
    betterAuthUserId: "ba-superuser",
    access: accessContext({
      organizationId: ORG_A,
      permissions: SUPERUSER_PERMISSIONS,
      orgBound: false,
    }),
    grantedScopes: null,
    isBearer: false,
    credentialId: null,
    boundOrganizationId: null,
    impersonatorId: null,
  };
}

function req(path: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  const url = new URL(`http://test.local${path}`);
  const raw = init.body === undefined ? "" : JSON.stringify(init.body);
  return {
    nextUrl: url,
    url: url.toString(),
    method: init.method ?? "GET",
    headers: new Headers({
      authorization: "Bearer drk_live_test",
      "content-type": "application/json",
    }),
    json: async () => (raw ? JSON.parse(raw) : undefined),
    text: async () => raw,
  } as unknown as NextRequest;
}

const idCtx = (id: string = RESOURCE_ID) => ({ params: Promise.resolve({ id }) });

/** Every call made on `table`'s builders with `verb`. */
function callsOn(table: string, verb: Verb = "select"): BuilderCall[] {
  return state.calls.filter((c) => c.table === table && c.verb === verb);
}

/** The argument lists of every `.where(...)` on `table`. */
function wheresOn(table: string): unknown[][] {
  return callsOn(table).flatMap((c) => (c.method === "where" ? [c.args] : []));
}

/** True when any `updateTable(table)` was issued: the request WROTE. */
function wrote(table: string): boolean {
  return callsOn(table, "update").length > 0;
}

beforeEach(() => {
  auditMock.mockReset();
  updateBetterAuthUser.mockReset();
  updateBetterAuthUser.mockResolvedValue({});
  state.calls = [];
  state.rows = {};
  state.memberships = { [USER_IN_A]: [ORG_A], [USER_IN_B]: [ORG_B] };
  caller.value = null;
});
afterEach(() => vi.resetModules());

/* -------------------------------------------------------------------------- */
/*  /api/v1                                                                    */
/* -------------------------------------------------------------------------- */

describe("GET /api/v1/audit-events — an org-confined caller reads only its org's rows", () => {
  const AUDIT = ["admin.audit.read"];

  beforeEach(() => {
    state.rows.app_audit_events = [
      { id: "ev-1", organization_id: ORG_A, created_at: "2026-01-01T00:00:00Z", __total: "1" },
    ];
  });

  it("an org admin's key carries `organization_id = <its org>` into SQL", async () => {
    caller.value = orgAdminKey(AUDIT);
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events"));

    expect(res.status).toBe(200);
    expect(wheresOn("app_audit_events")).toContainEqual(["organization_id", "=", ORG_A]);
  });

  it("a superuser-owned key bound to org A is confined to org A (MACHINE-2)", async () => {
    caller.value = boundSuperuserKey(AUDIT);
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events"));

    expect(res.status).toBe(200);
    expect(wheresOn("app_audit_events")).toContainEqual(["organization_id", "=", ORG_A]);
  });

  it("CONTROL: a superadmin at a browser reads the platform-wide log (no org predicate)", async () => {
    caller.value = cookieSuperadmin();
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events"));

    expect(res.status).toBe(200);
    expect(wheresOn("app_audit_events").some((w) => w[0] === "organization_id")).toBe(false);
    // The query did run: the control is not passing by querying nothing.
    expect(callsOn("app_audit_events").length).toBeGreaterThan(0);
  });

  it("a caller with no org gets an empty page and never queries the log", async () => {
    caller.value = orgAdminKey(AUDIT, null);
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [], total: 0 });
    expect(callsOn("app_audit_events")).toHaveLength(0);
  });

  it("a key without `admin.audit.read` is refused by the real guard before any query", async () => {
    caller.value = orgAdminKey(["admin.users.read"]);
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events"));

    expect(res.status).toBe(403);
    expect(callsOn("app_audit_events")).toHaveLength(0);
  });

  it("F-34: an unknown filter is a 400, never an unfiltered page", async () => {
    caller.value = orgAdminKey(AUDIT);
    const { GET } = await import("@/app/api/v1/audit-events/route");
    const res = await GET(req("/api/v1/audit-events?filter[actor]=someone"));

    expect(res.status).toBe(400);
    expect(callsOn("app_audit_events")).toHaveLength(0);
  });
});

describe("GET /api/v1/users?q= — a search narrows the caller's org, never replaces it", () => {
  it("the org's membership predicate and the search predicate both reach SQL", async () => {
    state.rows.app_users = [{ id: USER_IN_A, created_at: "2026-01-01T00:00:00Z", __total: "1" }];
    caller.value = orgAdminKey(["admin.users.read"]);
    const { GET } = await import("@/app/api/v1/users/route");
    const res = await GET(req("/api/v1/users?q=ann"));

    expect(res.status).toBe(200);
    // Both live inside `eb => ...` callbacks, recorded against `app_users`.
    expect(wheresOn("app_users")).toContainEqual(["m.organization_id", "=", ORG_A]);
    const predicates = state.calls
      .filter((c) => c.table === "app_users" && c.method === "(eb)")
      .map((c) => c.args);
    expect(predicates).toContainEqual(["primary_email", "ilike", "%ann%"]);
    expect(predicates).toContainEqual(["display_name", "ilike", "%ann%"]);
  });
});

describe("/api/v1/admin/oauth-clients/[id] — no cross-tenant read, edit or revoke", () => {
  const CLIENT_SCOPES = ["admin.clients.read", "admin.clients.manage"];

  function primeClient(organizationId: string | null) {
    state.rows.app_oauth_clients = [
      {
        id: RESOURCE_ID,
        client_id: "drkc_test",
        name: "svc",
        app_user_id: USER_IN_A,
        organization_id: organizationId,
        scopes: ["admin.clients.read"],
        status: "active",
      },
    ];
  }

  describe("GET", () => {
    it("200 for a client in the caller's own org", async () => {
      primeClient(ORG_A);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { GET } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await GET(req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`), idCtx());

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ client: { id: RESOURCE_ID } });
    });

    it("404 (not 403) for another org's client", async () => {
      primeClient(ORG_B);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { GET } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await GET(req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`), idCtx());

      expect(res.status).toBe(404);
    });

    it("404 for another org's client through a superuser-owned key bound to org A", async () => {
      primeClient(ORG_B);
      caller.value = boundSuperuserKey(CLIENT_SCOPES);
      const { GET } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await GET(req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`), idCtx());

      expect(res.status).toBe(404);
    });

    it("CONTROL: a superadmin at a browser reads it (200)", async () => {
      primeClient(ORG_B);
      caller.value = cookieSuperadmin();
      const { GET } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await GET(req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`), idCtx());

      expect(res.status).toBe(200);
    });
  });

  describe("PATCH", () => {
    const patch = (body: unknown) =>
      req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`, { method: "PATCH", body });

    it("404 and no write for another org's client", async () => {
      primeClient(ORG_B);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { PATCH } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await PATCH(patch({ name: "renamed" }), idCtx());

      expect(res.status).toBe(404);
      expect(wrote("app_oauth_clients")).toBe(false);
    });

    it("404 and no write through a superuser-owned key bound to org A", async () => {
      primeClient(ORG_B);
      caller.value = boundSuperuserKey(CLIENT_SCOPES);
      const { PATCH } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await PATCH(patch({ name: "renamed" }), idCtx());

      expect(res.status).toBe(404);
      expect(wrote("app_oauth_clients")).toBe(false);
    });

    it("403 invalid_scope and no write when widening past what the caller could grant", async () => {
      // The scenario the review named: an org admin holding
      // `admin.clients.manage` puts `admin.users.manage` on a client whose
      // secret it may already hold.
      primeClient(ORG_A);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { PATCH } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await PATCH(
        patch({ scopes: ["admin.clients.read", "admin.users.manage"] }),
        idCtx(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "invalid_scope",
        ungrantableScopes: ["admin.users.manage"],
      });
      expect(wrote("app_oauth_clients")).toBe(false);
    });

    it("200 for the caller's own org and scopes it holds; the audit row names the client's org", async () => {
      primeClient(ORG_A);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { PATCH } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await PATCH(patch({ scopes: ["admin.clients.read"] }), idCtx());

      expect(res.status).toBe(200);
      const set = callsOn("app_oauth_clients", "update").find((c) => c.method === "set");
      expect(set?.args[0]).toEqual({ scopes: ["admin.clients.read"] });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "oauth_client.updated", organizationId: ORG_A }),
      );
    });
  });

  describe("DELETE", () => {
    const del = () => req(`/api/v1/admin/oauth-clients/${RESOURCE_ID}`, { method: "DELETE" });

    it("404 and no revocation for another org's client", async () => {
      primeClient(ORG_B);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { DELETE } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await DELETE(del(), idCtx());

      expect(res.status).toBe(404);
      expect(wrote("app_oauth_clients")).toBe(false);
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("404 and no revocation through a superuser-owned key bound to org A", async () => {
      primeClient(ORG_B);
      caller.value = boundSuperuserKey(CLIENT_SCOPES);
      const { DELETE } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await DELETE(del(), idCtx());

      expect(res.status).toBe(404);
      expect(wrote("app_oauth_clients")).toBe(false);
    });

    it("404 for a platform (org-less) client: a bound key never reaches a null-org row", async () => {
      primeClient(null);
      caller.value = boundSuperuserKey(CLIENT_SCOPES);
      const { DELETE } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await DELETE(del(), idCtx());

      expect(res.status).toBe(404);
      expect(wrote("app_oauth_clients")).toBe(false);
    });

    it("200 for a client in the caller's own org: it is revoked and audited against that org", async () => {
      primeClient(ORG_A);
      caller.value = orgAdminKey(CLIENT_SCOPES);
      const { DELETE } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await DELETE(del(), idCtx());

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id: RESOURCE_ID, revoked: true });
      expect(wrote("app_oauth_clients")).toBe(true);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "oauth_client.revoked", organizationId: ORG_A }),
      );
    });

    it("CONTROL: a superadmin at a browser revokes another org's client (200)", async () => {
      primeClient(ORG_B);
      caller.value = cookieSuperadmin();
      const { DELETE } = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
      const res = await DELETE(del(), idCtx());

      expect(res.status).toBe(200);
      expect(wrote("app_oauth_clients")).toBe(true);
    });
  });
});

describe("DELETE /api/v1/admin/api-keys/[id] — no cross-tenant revocation", () => {
  const KEY_SCOPES = ["admin.apikeys.manage"];
  const del = () => req(`/api/v1/admin/api-keys/${RESOURCE_ID}`, { method: "DELETE" });

  function primeKey(organizationId: string | null) {
    state.rows.app_api_keys = [
      {
        id: RESOURCE_ID,
        app_user_id: USER_IN_A,
        organization_id: organizationId,
        name: "ci",
        key_prefix: "drk_live_abcd",
        scopes: [],
        status: "active",
      },
    ];
  }

  it("404 and no revocation for another org's key", async () => {
    primeKey(ORG_B);
    caller.value = orgAdminKey(KEY_SCOPES);
    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(404);
    expect(wrote("app_api_keys")).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("404 and no revocation through a superuser-owned key bound to org A", async () => {
    primeKey(ORG_B);
    caller.value = boundSuperuserKey(KEY_SCOPES);
    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(404);
    expect(wrote("app_api_keys")).toBe(false);
  });

  it("200 for a key in the caller's own org: it is revoked and audited against that org", async () => {
    primeKey(ORG_A);
    caller.value = orgAdminKey(KEY_SCOPES);
    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(200);
    expect(wrote("app_api_keys")).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "api_key.revoked", organizationId: ORG_A }),
    );
  });

  it("CONTROL: a superadmin at a browser revokes another org's key (200)", async () => {
    primeKey(ORG_B);
    caller.value = cookieSuperadmin();
    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(200);
    expect(wrote("app_api_keys")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  /api/administrator                                                         */
/* -------------------------------------------------------------------------- */

describe("/api/administrator/users/[id] — GET and PATCH stay inside the caller's org", () => {
  function primeUser(id: string) {
    state.rows.app_users = [
      {
        id,
        better_auth_user_id: `ba-${id}`,
        primary_email: "target@example.com",
        display_name: "Target",
        status: "active",
        status_reason: null,
        preferred_locale: "en",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
  }
  const patch = (id: string) =>
    req(`/api/administrator/users/${id}`, { method: "PATCH", body: { displayName: "Renamed" } });

  it("GET: 404 for a user who is a member of another org only", async () => {
    primeUser(USER_IN_B);
    caller.value = orgAdminSession(["admin.users.read"]);
    const { GET } = await import("@/app/api/administrator/users/[id]/route");
    const res = await GET(req(`/api/administrator/users/${USER_IN_B}`), idCtx(USER_IN_B));

    expect(res.status).toBe(404);
  });

  it("GET: 200 for a member of the caller's own org", async () => {
    primeUser(USER_IN_A);
    caller.value = orgAdminSession(["admin.users.read"]);
    const { GET } = await import("@/app/api/administrator/users/[id]/route");
    const res = await GET(req(`/api/administrator/users/${USER_IN_A}`), idCtx(USER_IN_A));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: USER_IN_A } });
  });

  it("GET: 404 through a superuser-owned key bound to org A", async () => {
    primeUser(USER_IN_B);
    caller.value = boundSuperuserKey(["admin.users.read"]);
    const { GET } = await import("@/app/api/administrator/users/[id]/route");
    const res = await GET(req(`/api/administrator/users/${USER_IN_B}`), idCtx(USER_IN_B));

    expect(res.status).toBe(404);
  });

  it("PATCH: 404 for another org's member, with no write and no Better Auth mirror", async () => {
    primeUser(USER_IN_B);
    caller.value = orgAdminSession(["admin.users.update"]);
    const { PATCH } = await import("@/app/api/administrator/users/[id]/route");
    const res = await PATCH(patch(USER_IN_B), idCtx(USER_IN_B));

    expect(res.status).toBe(404);
    expect(wrote("app_users")).toBe(false);
    expect(updateBetterAuthUser).not.toHaveBeenCalled();
  });

  it("PATCH: 404 and no write through a superuser-owned key bound to org A", async () => {
    primeUser(USER_IN_B);
    caller.value = boundSuperuserKey(["admin.users.update"]);
    const { PATCH } = await import("@/app/api/administrator/users/[id]/route");
    const res = await PATCH(patch(USER_IN_B), idCtx(USER_IN_B));

    expect(res.status).toBe(404);
    expect(wrote("app_users")).toBe(false);
  });

  it("PATCH: 200 for the caller's own member; the write and the audit row are org A's", async () => {
    primeUser(USER_IN_A);
    caller.value = orgAdminSession(["admin.users.update"]);
    const { PATCH } = await import("@/app/api/administrator/users/[id]/route");
    const res = await PATCH(patch(USER_IN_A), idCtx(USER_IN_A));

    expect(res.status).toBe(200);
    expect(wrote("app_users")).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.updated", organizationId: ORG_A }),
    );
  });

  it("CONTROL: a superadmin at a browser edits another org's member (200)", async () => {
    primeUser(USER_IN_B);
    caller.value = cookieSuperadmin();
    const { PATCH } = await import("@/app/api/administrator/users/[id]/route");
    const res = await PATCH(patch(USER_IN_B), idCtx(USER_IN_B));

    expect(res.status).toBe(200);
    expect(wrote("app_users")).toBe(true);
  });
});

describe("DELETE /api/administrator/api-keys/[id] — no cross-tenant revocation", () => {
  const del = () =>
    req(`/api/administrator/api-keys/${RESOURCE_ID}`, {
      method: "DELETE",
      body: { reason: "rotated" },
    });

  function primeKey(organizationId: string | null) {
    state.rows.app_api_keys = [
      {
        id: RESOURCE_ID,
        app_user_id: USER_IN_A,
        status: "active",
        key_prefix: "drk_live_abcd",
        organization_id: organizationId,
      },
    ];
  }

  it("404 and no revocation for another org's key", async () => {
    primeKey(ORG_B);
    caller.value = orgAdminSession(["admin.apikeys.manage"]);
    const { DELETE } = await import("@/app/api/administrator/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "api_key_not_found" });
    expect(wrote("app_api_keys")).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("404 and no revocation through a superuser-owned key bound to org A", async () => {
    primeKey(ORG_B);
    caller.value = boundSuperuserKey(["admin.apikeys.manage"]);
    const { DELETE } = await import("@/app/api/administrator/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(404);
    expect(wrote("app_api_keys")).toBe(false);
  });

  it("200 for a key in the caller's own org: revoked with the reason, audited against that org", async () => {
    primeKey(ORG_A);
    caller.value = orgAdminSession(["admin.apikeys.manage"]);
    const { DELETE } = await import("@/app/api/administrator/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(200);
    const set = callsOn("app_api_keys", "update").find((c) => c.method === "set");
    expect(set?.args[0]).toMatchObject({ status: "revoked", revoked_reason: "rotated" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.api_key.revoked", organizationId: ORG_A }),
    );
  });

  it("CONTROL: a superadmin at a browser revokes another org's key (200)", async () => {
    primeKey(ORG_B);
    caller.value = cookieSuperadmin();
    const { DELETE } = await import("@/app/api/administrator/api-keys/[id]/route");
    const res = await DELETE(del(), idCtx());

    expect(res.status).toBe(200);
    expect(wrote("app_api_keys")).toBe(true);
  });
});

describe("GET /api/administrator/groups/[id]/roles — no cross-tenant group read", () => {
  function primeGroup(organizationId: string | null) {
    state.rows.app_groups = [{ id: RESOURCE_ID, organization_id: organizationId, key: "ops" }];
    state.rows.app_group_roles = [{ id: "role-1", key: "member", name: "Member" }];
  }

  it("404 for another org's group, and its roles are never read", async () => {
    primeGroup(ORG_B);
    caller.value = orgAdminSession(["admin.groups.read"]);
    const { GET } = await import("@/app/api/administrator/groups/[id]/roles/route");
    const res = await GET(req(`/api/administrator/groups/${RESOURCE_ID}/roles`), idCtx());

    expect(res.status).toBe(404);
    expect(callsOn("app_group_roles")).toHaveLength(0);
  });

  it("404 through a superuser-owned key bound to org A", async () => {
    primeGroup(ORG_B);
    caller.value = boundSuperuserKey(["admin.groups.read"]);
    const { GET } = await import("@/app/api/administrator/groups/[id]/roles/route");
    const res = await GET(req(`/api/administrator/groups/${RESOURCE_ID}/roles`), idCtx());

    expect(res.status).toBe(404);
  });

  it("200 with the group's roles for the caller's own org", async () => {
    primeGroup(ORG_A);
    caller.value = orgAdminSession(["admin.groups.read"]);
    const { GET } = await import("@/app/api/administrator/groups/[id]/roles/route");
    const res = await GET(req(`/api/administrator/groups/${RESOURCE_ID}/roles`), idCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roles: [{ id: "role-1", key: "member", name: "Member" }] });
  });
});

/**
 * The two platform-global catalogs have no tenant column, so their boundary is
 * the PERMISSION gate alone: any admin reader may load them, and nobody else.
 */
describe("GET /api/administrator/email/templates/[id] — the read permission is the boundary", () => {
  beforeEach(() => {
    state.rows.app_email_templates = [
      {
        id: RESOURCE_ID,
        key: "password_reset",
        locale: "en",
        subject: "Reset",
        body_html: "<p>Reset</p>",
        body_text: "Reset",
        description: null,
      },
    ];
  });

  it("403 without `admin.email.read`, and the template is never read", async () => {
    caller.value = orgAdminSession(["admin.users.read"]);
    const { GET } = await import("@/app/api/administrator/email/templates/[id]/route");
    const res = await GET(req(`/api/administrator/email/templates/${RESOURCE_ID}`), idCtx());

    expect(res.status).toBe(403);
    expect(callsOn("app_email_templates")).toHaveLength(0);
  });

  it("200 for an org admin who holds `admin.email.read` (a platform row, not a tenant one)", async () => {
    caller.value = orgAdminSession(["admin.email.read"]);
    const { GET } = await import("@/app/api/administrator/email/templates/[id]/route");
    const res = await GET(req(`/api/administrator/email/templates/${RESOURCE_ID}`), idCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: RESOURCE_ID, key: "password_reset" });
  });

  it("404 for a malformed id, before any query", async () => {
    caller.value = orgAdminSession(["admin.email.read"]);
    const { GET } = await import("@/app/api/administrator/email/templates/[id]/route");
    const res = await GET(req("/api/administrator/email/templates/nope"), idCtx("nope"));

    expect(res.status).toBe(404);
    expect(callsOn("app_email_templates")).toHaveLength(0);
  });

  it("404 for an id with no template", async () => {
    state.rows.app_email_templates = [];
    caller.value = orgAdminSession(["admin.email.read"]);
    const { GET } = await import("@/app/api/administrator/email/templates/[id]/route");
    const res = await GET(req(`/api/administrator/email/templates/${RESOURCE_ID}`), idCtx());

    expect(res.status).toBe(404);
  });
});

describe("GET /api/administrator/permissions — the read permission is the boundary", () => {
  beforeEach(() => {
    state.rows.app_permissions = [
      {
        id: "perm-1",
        key: "admin.users.read",
        description: "Read users",
        used_by_role_count: "2",
        __total: "1",
      },
    ];
  });

  it("403 without `admin.roles.read`, and the catalog is never read", async () => {
    caller.value = orgAdminSession(["admin.users.read"]);
    const { GET } = await import("@/app/api/administrator/permissions/route");
    const res = await GET(req("/api/administrator/permissions"));

    expect(res.status).toBe(403);
    expect(callsOn("app_permissions")).toHaveLength(0);
  });

  it("200 for an `admin.roles.read` holder, with the usage count as a number", async () => {
    caller.value = orgAdminSession(["admin.roles.read"]);
    const { GET } = await import("@/app/api/administrator/permissions/route");
    const res = await GET(req("/api/administrator/permissions"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [
        { id: "perm-1", key: "admin.users.read", description: "Read users", used_by_role_count: 2 },
      ],
      total: 1,
    });
  });

  it("a search term reaches SQL as a key OR description match", async () => {
    caller.value = orgAdminSession(["admin.roles.read"]);
    const { GET } = await import("@/app/api/administrator/permissions/route");
    const res = await GET(req("/api/administrator/permissions?q=users"));

    expect(res.status).toBe(200);
    const predicates = state.calls
      .filter((c) => c.table === "app_permissions" && c.method === "(eb)")
      .map((c) => c.args);
    expect(predicates).toContainEqual(["p.key", "ilike", "%users%"]);
    expect(predicates).toContainEqual(["p.description", "ilike", "%users%"]);
  });
});
