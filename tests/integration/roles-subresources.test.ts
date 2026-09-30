import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as PermsRoute from "@/app/api/administrator/roles/[id]/permissions/route";
import type * as MembersRoute from "@/app/api/administrator/roles/[id]/members/route";
import type * as DuplicateRoute from "@/app/api/administrator/roles/[id]/duplicate/route";
import { expectResponseMatchesSpec } from "../helpers/openapi-response";

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
  /** The writes a transaction issued, in order (F-38: a refused PATCH issues none). */
  writes: Array<"insert" | "delete">;
} = {
  role: undefined,
  whereCols: [],
  catalogPerms: [{ id: "p1", key: "admin.users.read" }],
  superuserGrants: [],
  insertReturning: [],
  deleteReturning: [],
  writes: [],
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
  if (table === "trx") return { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", key: "editor-copy" };
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
          insertInto: () => {
            state.writes.push("insert");
            return makeChain("trx:insert");
          },
          deleteFrom: () => {
            state.writes.push("delete");
            return makeChain("trx:delete");
          },
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

/**
 * F-58: the refusal's row, filed under the role's org, naming the operation
 * and the keys the actor could not confer. It is the only row.
 */
function expectConferralDenied(metadata: Record<string, unknown>): void {
  expect(auditMock).toHaveBeenCalledTimes(1);
  expect(auditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: "admin.permission.conferral_denied",
      outcome: "denied",
      actorBetterAuthUserId: "ba-actor",
      appUserId: null,
      organizationId: ORG_A,
      reason: "unheld_permissions",
      metadata,
    }),
  );
}

let permsGET: typeof PermsRoute.GET;
let permsPOST: typeof PermsRoute.POST;
let permsDELETE: typeof PermsRoute.DELETE;
let permsPATCH: typeof PermsRoute.PATCH;
let membersGET: typeof MembersRoute.GET;
let duplicatePOST: typeof DuplicateRoute.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.whereCols = [];
  state.catalogPerms = [{ id: "p1", key: "admin.users.read" }];
  state.superuserGrants = [];
  state.insertReturning = [];
  state.deleteReturning = [];
  state.writes = [];
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
    PATCH: permsPATCH,
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
    state.catalogPerms = [{ id: "p-del", key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["admin.users.delete"] } }),
      ctx,
    );
    expect(res.status).toBe(403);
    expectConferralDenied({
      action: "role_permissions_add",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: ["admin.users.delete"],
    });
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
    state.catalogPerms = [{ id: "p-super", key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await permsPOST(
      req("permissions", { method: "POST", body: { ids: ["superuser"] } }),
      ctx,
    );
    expect(res.status).toBe(403);
    expectConferralDenied({
      action: "role_permissions_add",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: ["superuser"],
    });
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
 * F-58 / F-15: the subset test measures the raw requested keys, so unknown
 * strings are refused, but the refusal row records only the refused keys the
 * catalog knows and a count of the rest. `ids` take 500 strings of 120
 * characters and the table is append-only: recorded verbatim, one refused
 * request parked about 61 KB of the caller's text in it.
 */
describe("roles/[id]/permissions — a refusal never records the caller's strings", () => {
  const junk = Array.from({ length: 499 }, (_, i) => `${i}`.padStart(120, "x"));

  it.each(["POST", "DELETE"] as const)(
    "%s with 499 unknown 120-character keys and one real one",
    async (method) => {
      state.catalogPerms = [{ id: "p-del", key: "admin.users.delete" }];
      accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
      const handler = method === "POST" ? permsPOST : permsDELETE;
      const res = await handler(
        req("permissions", { method, body: { ids: [...junk, "admin.users.delete"] } }),
        ctx,
      );
      expect(res.status).toBe(403);
      expectConferralDenied({
        action: method === "POST" ? "role_permissions_add" : "role_permissions_remove",
        roleId: ROLE,
        key: "editor",
        unknownPermissionKeyCount: 499,
        unheldPermissions: ["admin.users.delete"],
      });
      const row = auditMock.mock.calls[0]![0] as { metadata: object };
      expect(JSON.stringify(row.metadata).length).toBeLessThan(500);
    },
  );
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
    state.catalogPerms = [{ id: "p-del", key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect((await del(["admin.users.delete"])).status).toBe(403);
    expectConferralDenied({
      action: "role_permissions_remove",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: ["admin.users.delete"],
    });
  });

  it("403 when a non-superadmin detaches `superuser`", async () => {
    state.catalogPerms = [{ id: "p-super", key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect((await del(["superuser"])).status).toBe(403);
    expectConferralDenied({
      action: "role_permissions_remove",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: ["superuser"],
    });
  });

  it("403 for a key the catalog does not know, recorded as a count, not as the string", async () => {
    // A key retired from the catalog is in nobody's held set (review #444).
    state.catalogPerms = [];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect((await del(["crm.retired.key"])).status).toBe(403);
    expectConferralDenied({
      action: "role_permissions_remove",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 1,
      unheldPermissions: [],
    });
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

/**
 * F-38: `PATCH roles/[id]/permissions` is the editor's ONE save. It used to be
 * a POST then a DELETE, and a DELETE refused after the POST had landed left
 * the addition live for every holder of the role. Every guard runs on both
 * sides before the transaction writes anything, so a refusal issues no write
 * at all, and one row records the delta `RETURNING` reported. (What Postgres
 * returns, and that a refusal leaves the role as it was, are pinned in
 * tests/db/dual-list-patch.db.test.ts.)
 */
describe("PATCH roles/[id]/permissions — one atomic save (F-38)", () => {
  const READ = { id: "p1", key: "admin.users.read" };
  const UPDATE = { id: "p2", key: "admin.users.update" };
  const DELETE_KEY = { id: "p3", key: "admin.users.delete" };
  const SUPER = { id: "p-super", key: "superuser" };
  const patch = (body: unknown) => permsPATCH(req("permissions", { method: "PATCH", body }), ctx);

  it("applies both sides in one transaction, audits the applied delta, and answers the spec's shape", async () => {
    state.catalogPerms = [READ, UPDATE];
    state.insertReturning = [{ permission_id: UPDATE.id }];
    state.deleteReturning = [{ permission_id: READ.id }];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));

    const res = await patch({ add: [UPDATE.key], remove: [READ.key] });

    expect(res.status).toBe(200);
    expect(state.writes).toEqual(["insert", "delete"]);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.role.permissions_changed",
      "success",
      expect.objectContaining({
        organizationId: ORG_A,
        metadata: {
          roleId: ROLE,
          key: "editor",
          added: [UPDATE.key],
          removed: [READ.key],
          resulting: ["admin.users.read"],
        },
      }),
    );
    await expectResponseMatchesSpec(res, "admin", "patch", "/roles/{id}/permissions");
  });

  it("an add-only or remove-only save issues only that write", async () => {
    state.catalogPerms = [READ];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    expect((await patch({ add: [READ.key] })).status).toBe(200);
    expect(state.writes).toEqual(["insert"]);

    state.writes = [];
    expect((await patch({ remove: [READ.key] })).status).toBe(200);
    expect(state.writes).toEqual(["delete"]);
  });

  it("403 when the removal names a key the org admin does not hold: the addition is not written either", async () => {
    state.catalogPerms = [READ, DELETE_KEY];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update", READ.key]));

    const res = await patch({ add: [READ.key], remove: [DELETE_KEY.key] });

    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
    expectConferralDenied({
      action: "role_permissions_remove",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: [DELETE_KEY.key],
    });
  });

  it("403 when the addition names a key the org admin does not hold (AUTHZ-3)", async () => {
    state.catalogPerms = [READ, DELETE_KEY];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update", READ.key]));

    const res = await patch({ add: [DELETE_KEY.key], remove: [READ.key] });

    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
    expectConferralDenied({
      action: "role_permissions_add",
      roleId: ROLE,
      key: "editor",
      unknownPermissionKeyCount: 0,
      unheldPermissions: [DELETE_KEY.key],
    });
  });

  it("409 last_superadmin when the removal strips the last superuser grant, and nothing is added", async () => {
    state.catalogPerms = [READ, SUPER];
    state.superuserGrants = [{ app_user_id: "u-1", organization_id: ORG_A, role_id: ROLE }];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));

    const res = await patch({ add: [READ.key], remove: [SUPER.key] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_superadmin" });
    expect(state.writes).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.superuser.revocation_denied",
      "denied",
      expect.objectContaining({
        reason: "last_global_superuser",
        metadata: expect.objectContaining({
          action: "role_permissions_detach",
          added: [READ.key],
          removed: [SUPER.key],
        }),
      }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.role.permissions_changed",
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ["an empty body", {}],
    ["two empty sides", { add: [], remove: [] }],
    ["a key on both sides", { add: [READ.key], remove: [READ.key] }],
    ["the POST/DELETE body shape", { ids: [READ.key] }],
  ])("400 invalid_body for %s", async (_label, body) => {
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(state.writes).toEqual([]);
  });

  it("400 for a body that is not JSON, and for a malformed id", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    const notJson = {
      ...req("permissions", { method: "PATCH" }),
      json: async () => {
        throw new SyntaxError("not json");
      },
    } as unknown as NextRequest;
    expect((await permsPATCH(notJson, ctx)).status).toBe(400);
    const badId = { params: Promise.resolve({ id: "not-a-uuid" }) };
    expect(
      (await permsPATCH(req("permissions", { method: "PATCH", body: {} }), badId)).status,
    ).toBe(400);
  });

  it("404 for a foreign-org role, a global role and a missing one", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update", READ.key]));
    state.role = { ...state.role!, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect((await patch({ add: [READ.key] })).status).toBe(404);
    state.role = { ...state.role!, organization_id: null };
    expect((await patch({ add: [READ.key] })).status).toBe(404);
    state.role = undefined;
    expect((await patch({ add: [READ.key] })).status).toBe(404);
    expect(state.writes).toEqual([]);
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
    const res = await duplicatePOST(req("duplicate", { method: "POST" }), ctx);
    expect(res.status).toBe(201);
    // The spec's KeyCreated, as every create sharing it must answer (F-74).
    await expectResponseMatchesSpec(res, "admin", "post", "/roles/{id}/duplicate");
  });

  it("POST 403 duplicating a role that confers a permission the actor lacks (AUTHZ-3)", async () => {
    // Source role confers admin.users.read (mock); actor does not hold it, so
    // the clone would hand them an editable role exceeding their authority.
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await duplicatePOST(req("duplicate", { method: "POST" }), ctx)).status).toBe(403);
    expectConferralDenied({
      action: "role_duplicate",
      sourceRoleId: ROLE,
      sourceKey: "editor",
      unheldPermissions: ["admin.users.read"],
    });
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
