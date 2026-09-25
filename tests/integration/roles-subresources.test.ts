import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as PermsRoute from "@/app/api/administrator/roles/[id]/permissions/route";
import type * as MembersRoute from "@/app/api/administrator/roles/[id]/members/route";
import type * as DuplicateRoute from "@/app/api/administrator/roles/[id]/duplicate/route";

/**
 * ADR-0001 — role sub-resource scoping (0% covered before this suite).
 *
 * `roles/[id]/{permissions,members,duplicate}` must confine an ORG ADMIN to
 * roles owned by their org; a global role (organization_id null) or another
 * org's role is SUPERADMIN-only and returns 404 (no existence leak).
 * Additionally, attaching the `superuser` marker to a role is SUPERADMIN-only
 * (privilege escalation → 403).
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  role:
    | {
        id: string;
        organization_id: string | null;
        key: string;
        name: string;
        description: string | null;
      }
    | undefined;
  whereCols: string[];
  /** Permission keys the DELETE body resolves to in the catalog. */
  catalogPerms: { id: string; key: string }[];
  /**
   * Rows `activeGlobalSuperuserGrants` sees (REVOKE-2). Empty by default so a
   * platform with nothing to protect behaves exactly as before — and so the
   * `roles/[id]/members` feed, which reads the same table in this stub, keeps
   * returning an empty item list.
   */
  superuserGrants: { app_user_id: string; organization_id: string; role_id: string }[];
  /**
   * What the permissions write's `RETURNING` reports (F-38): the rows the
   * insert actually created / the delete actually removed. The audit must
   * record these, not the keys the body named.
   */
  insertReturning: { permission_id: string }[];
  deleteReturning: { permission_id: string }[];
} = {
  role: undefined,
  whereCols: [],
  catalogPerms: [{ id: "p1", key: "admin.users.read" }],
  superuserGrants: [],
  insertReturning: [],
  deleteReturning: [],
};

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function firstFor(table: string) {
  if (table === "app_roles") return state.role;
  if (table === "app_user_roles") return { total: "0" }; // members count
  if (table === "trx") return { id: "new-role", key: "editor-copy" };
  return undefined;
}
function execFor(table: string): unknown[] {
  if (table === "trx:insert") return state.insertReturning;
  if (table === "trx:delete") return state.deleteReturning;
  if (table === "app_role_permissions") return [{ key: "admin.users.read" }];
  if (table === "app_permissions") return state.catalogPerms;
  if (table === "app_user_roles") return state.superuserGrants;
  return []; // app_roles duplicate-candidates
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow") return async () => firstFor("trx");
        if (prop === "execute") return async () => execFor(table);
        return (...args: unknown[]) => {
          if (prop === "where" && typeof args[0] === "string") state.whereCols.push(args[0]);
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (x: unknown) => unknown)(makeChain(table));
            } catch {
              /* eb/oc/expression stub best-effort */
            }
          }
          return makeChain(table);
        };
      },
    },
  );
}
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({
          insertInto: () => makeChain("trx:insert"),
          deleteFrom: () => makeChain("trx:delete"),
          // REVOKE-2 reads the surviving grants on the ENCLOSING transaction.
          selectFrom: (t: unknown) => makeChain(tableKey(t)),
        }),
    }),
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  const url = `http://test.local/api/administrator/roles/${ROLE}/${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: ROLE }) };

let permsGET: typeof PermsRoute.GET;
let permsPOST: typeof PermsRoute.POST;
let permsDELETE: typeof PermsRoute.DELETE;
let membersGET: typeof MembersRoute.GET;
let duplicatePOST: typeof DuplicateRoute.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.whereCols = [];
  state.catalogPerms = [{ id: "p1", key: "admin.users.read" }];
  state.superuserGrants = [];
  state.insertReturning = [];
  state.deleteReturning = [];
  state.role = {
    id: ROLE,
    organization_id: ORG_A,
    key: "editor",
    name: "Editor",
    description: null,
  };
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({
    GET: permsGET,
    POST: permsPOST,
    DELETE: permsDELETE,
  } = await import("@/app/api/administrator/roles/[id]/permissions/route"));
  ({ GET: membersGET } = await import("@/app/api/administrator/roles/[id]/members/route"));
  ({ POST: duplicatePOST } = await import("@/app/api/administrator/roles/[id]/duplicate/route"));
});
afterEach(() => vi.resetModules());

describe("roles/[id]/permissions — org scoping + superuser guard", () => {
  it("GET 200 for an ORG ADMIN's own-org role", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await permsGET(req("permissions"), ctx)).status).toBe(200);
  });

  it("GET 404 for a foreign-org role", async () => {
    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await permsGET(req("permissions"), ctx)).status).toBe(404);
  });

  it("GET 404 for a GLOBAL role (org admin)", async () => {
    state.role = { ...state.role!, organization_id: null };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await permsGET(req("permissions"), ctx)).status).toBe(404);
  });

  it("POST 200 attaching a permission the actor holds, in own org", async () => {
    // AUTHZ-3: the actor must HOLD a permission to attach it.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update", "admin.users.read"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["admin.users.read"] } }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("POST 403 attaching a permission the actor does NOT hold (AUTHZ-3)", async () => {
    // Org admin holds only admin.roles.update; cannot grant admin.users.delete
    // (which they lack) and then assign the role to themselves.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["admin.users.delete"] } }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("POST 200 — a SUPERADMIN may attach any permission", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["admin.users.delete"] } }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("POST 404 for a foreign-org role", async () => {
    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["admin.users.read"] } }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("POST 403 when a non-superadmin attaches `superuser`", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["superuser"] } }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("POST 200 when a SUPERADMIN attaches `superuser`", async () => {
    state.role = { ...state.role!, organization_id: null };
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["superuser"] } }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("DELETE 200 in own org; 404 for a foreign-org role", async () => {
    // REVOKE-1: detaching is now bounded by the same subset test as attaching,
    // so the actor must HOLD `admin.users.read` to remove it. The assertion
    // under test is unchanged — this suite pins SCOPING (200 own / 404
    // foreign), and the held permission just keeps the conferral guard out of
    // the way. The guard itself is pinned in the REVOKE-1 suite below.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update", "admin.users.read"]));
    expect(
      (
        await permsDELETE(
          req("permissions", { method: "DELETE", body: { ids: ["admin.users.read"] } }),
          ctx,
        )
      ).status,
    ).toBe(200);
    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect(
      (
        await permsDELETE(
          req("permissions", { method: "DELETE", body: { ids: ["admin.users.read"] } }),
          ctx,
        )
      ).status,
    ).toBe(404);
  });
});

/**
 * REVOKE-1 / REVOKE-2 on `DELETE roles/[id]/permissions` — the mirror image of
 * the POST guards above. Detaching a permission is a mutation of authority, so
 * it takes the same AUTHZ-3 subset test; and stripping `superuser` off the
 * last role that carries it would leave the platform unadministrable.
 */
describe("DELETE roles/[id]/permissions — revocation guards", () => {
  const del = (ids: string[]) =>
    permsDELETE(req("permissions", { method: "DELETE", body: { ids } }), ctx);

  it("403 when a non-superadmin detaches a permission they do NOT hold (REVOKE-1)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect((await del(["admin.users.delete"])).status).toBe(403);
  });

  it("403 when a non-superadmin detaches `superuser`", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect((await del(["superuser"])).status).toBe(403);
  });

  it("200 — a SUPERADMIN may detach `superuser` while another grant survives", async () => {
    state.catalogPerms = [{ id: "p-super", key: "superuser" }];
    state.superuserGrants = [{ app_user_id: "u-1", organization_id: ORG_A, role_id: "other-role" }];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    expect((await del(["superuser"])).status).toBe(200);
  });

  it("409 `last_superadmin` when every surviving grant runs through this role (REVOKE-2)", async () => {
    state.catalogPerms = [{ id: "p-super", key: "superuser" }];
    state.superuserGrants = [
      { app_user_id: "u-1", organization_id: ORG_A, role_id: ROLE },
      { app_user_id: "u-2", organization_id: ORG_A, role_id: ROLE },
    ];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await del(["superuser"]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "last_superadmin",
      message: "errors.last_superadmin",
    });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.superuser.revocation_denied",
      "denied",
      expect.objectContaining({ reason: "last_global_superuser" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.role.permissions_changed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("200 detaching an ordinary permission even while superuser grants exist", async () => {
    // The invariant must not turn into "a role carrying superuser is frozen":
    // only a removal that actually strips the marker is gated.
    state.superuserGrants = [{ app_user_id: "u-1", organization_id: ORG_A, role_id: ROLE }];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    expect((await del(["admin.users.read"])).status).toBe(200);
  });
});

/**
 * F-38: the `admin.role.permissions_changed` row records the delta the write
 * APPLIED, as its `RETURNING` reported it. It used to record the requested
 * keys: a re-POST of an attached key was logged as added again, and a DELETE
 * naming a never-attached key was logged as removed although it is a no-op.
 * (The real `ON CONFLICT DO NOTHING ... RETURNING` semantics are pinned against
 * Postgres in tests/db/dual-list-audit-delta.db.test.ts.)
 */
describe("roles/[id]/permissions — audit records the applied delta (F-38)", () => {
  const READ = { id: "p1", key: "admin.users.read" };
  const UPDATE = { id: "p2", key: "admin.users.update" };

  function changedMetadata(): Record<string, unknown> {
    const call = auditMock.mock.calls.find((c) => c[0] === "admin.role.permissions_changed");
    expect(call, "an admin.role.permissions_changed row").toBeDefined();
    return (call![2] as { metadata: Record<string, unknown> }).metadata;
  }

  it("POST audits only the keys the insert created, not an already-attached one", async () => {
    state.catalogPerms = [READ, UPDATE];
    state.insertReturning = [{ permission_id: UPDATE.id }]; // READ was already attached
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: [READ.key, UPDATE.key] } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(changedMetadata()).toMatchObject({ added: [UPDATE.key], removed: [] });
  });

  it("DELETE audits only the keys the delete removed, not a never-attached one", async () => {
    state.catalogPerms = [READ, UPDATE];
    state.deleteReturning = [{ permission_id: READ.id }]; // UPDATE was never attached
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await permsDELETE(
      req("permissions", { method: "DELETE", body: { ids: [READ.key, UPDATE.key] } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(changedMetadata()).toMatchObject({ added: [], removed: [READ.key] });
  });

  it("a request that changes nothing is still audited, with empty deltas", async () => {
    state.catalogPerms = [READ];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const post = await permsPOST(
      req("permissions", { method: "POST", body: { ids: [READ.key] } }),
      ctx,
    );
    expect(post.status).toBe(200);
    expect(changedMetadata()).toMatchObject({ added: [], removed: [] });

    auditMock.mockReset();
    const del = await permsDELETE(
      req("permissions", { method: "DELETE", body: { ids: [READ.key] } }),
      ctx,
    );
    expect(del.status).toBe(200);
    expect(changedMetadata()).toMatchObject({ added: [], removed: [] });
  });
});

describe("roles/[id]/members — org scoping", () => {
  it("GET 200 for own-org role; 404 foreign; 200 SUPERADMIN", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await membersGET(req("members"), ctx)).status).toBe(200);

    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await membersGET(req("members"), ctx)).status).toBe(404);

    accessGetter.mockResolvedValue(superadmin(["admin.roles.read"]));
    expect((await membersGET(req("members"), ctx)).status).toBe(200);
  });

  it("confines an ORG ADMIN's feed to ur.organization_id but not a SUPERADMIN's (audit #26)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    await membersGET(req("members"), ctx);
    expect(state.whereCols).toContain("ur.organization_id");

    state.whereCols = [];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.read"]));
    await membersGET(req("members"), ctx);
    expect(state.whereCols).not.toContain("ur.organization_id");
  });
});

describe("roles/[id]/duplicate — org scoping", () => {
  it("POST 201 for own-org role whose permissions the actor holds", async () => {
    // The mock source role confers admin.users.read; the actor must hold it.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create", "admin.users.read"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(201);
  });

  it("POST 403 duplicating a role that confers a permission the actor lacks (AUTHZ-3)", async () => {
    // Source role confers admin.users.read (mock); actor does not hold it, so
    // the clone would hand them an editable role exceeding their authority.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(403);
  });

  it("POST 404 for a foreign-org role", async () => {
    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(404);
  });

  it("POST 404 for a GLOBAL role (org admin cannot clone into a tenant)", async () => {
    state.role = { ...state.role!, organization_id: null };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(404);
  });

  it("POST 201 when a SUPERADMIN duplicates a global role", async () => {
    state.role = { ...state.role!, organization_id: null };
    accessGetter.mockResolvedValue(superadmin(["admin.roles.create"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(201);
  });
});
