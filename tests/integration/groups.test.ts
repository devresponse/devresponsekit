import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ListRoute from "@/app/api/administrator/groups/route";
import type * as IdRoute from "@/app/api/administrator/groups/[id]/route";
import type * as RolesRoute from "@/app/api/administrator/groups/[id]/roles/route";
import type * as MembersRoute from "@/app/api/administrator/groups/[id]/members/route";
import type * as UserGroupsRoute from "@/app/api/administrator/users/[id]/groups/route";
import type * as UserTargetModule from "@/lib/admin/user-target.server";

/**
 * ADR-0002 organization groups — handler contract + ADR-0001 tenant
 * isolation: org-scoped CRUD, the same-org constraint on bundled roles, the
 * SUPERADMIN-only superuser-bundle guard, and the org-membership constraint
 * on group membership.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  group: Record<string, unknown> | undefined;
  org: { id: string } | undefined;
  roles: Array<{ id: string; organization_id: string | null }>;
  /** Permission keys the bundled roles confer (AUTHZ-3 subset check). */
  conferredPermKeys: { key: string }[];
  eligibleMembers: Array<{ app_user_id: string }>;
  membership: { id: string } | undefined;
  listExec: unknown[];
} = {
  group: undefined,
  org: undefined,
  roles: [],
  conferredPermKeys: [],
  eligibleMembers: [],
  membership: undefined,
  listExec: [],
};

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditOrgAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/admin/user-target.server", async () => {
  const actual = await vi.importActual<typeof UserTargetModule>("@/lib/admin/user-target.server");
  return {
    ...actual, // keep the real isUuid
    resolveTargetUser: async () => ({
      appUserId: "u-target",
      betterAuthUserId: "ba-target",
      primaryEmail: "t@x.com",
    }),
    isResolvedUserResponse: (v: unknown) => v instanceof Response,
  };
});

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function firstFor(table: string): unknown {
  if (table === "app_groups") return state.group;
  if (table === "app_organizations") return state.org;
  if (table === "app_organization_memberships") return state.membership;
  if (table === "app_group_roles" || table === "app_group_memberships")
    return { c: "0", total: "0" };
  return { total: "0", c: "0" };
}
function execFor(table: string): unknown[] {
  if (table === "app_roles") return state.roles;
  // permissionKeysForRoles(...) selects the bundled roles' conferred keys.
  if (table === "app_role_permissions") return state.conferredPermKeys;
  // permissionKeysForGroup(...) selects from app_group_roles → the keys the
  // group confers to its members (AUTHZ-3 membership escalation guard).
  if (table === "app_group_roles") return state.conferredPermKeys;
  if (table === "app_organization_memberships") return state.eligibleMembers;
  return state.listExec;
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow") return async () => ({ id: "g-new", key: "new" });
        if (prop === "execute") return async () => execFor(table);
        return (...args: unknown[]) => {
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (x: unknown) => unknown)(makeChain(table));
            } catch {
              /* eb/oc stub */
            }
          }
          return makeChain(table);
        };
      },
    },
  );
}
/** Tables a handler issued a DELETE against — a refusal must leave this empty. */
const deletedTables: string[] = [];
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    insertInto: (t: unknown) => makeChain(tableKey(t)),
    updateTable: (t: unknown) => makeChain(tableKey(t)),
    deleteFrom: (t: unknown) => {
      deletedTables.push(tableKey(t));
      return makeChain(tableKey(t));
    },
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP = "11111111-1111-4111-8111-111111111111";
const ROLE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

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

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  const url = `http://test.local/api/administrator/${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const groupCtx = { params: Promise.resolve({ id: GROUP }) };
const userCtx = { params: Promise.resolve({ id: USER }) };

let list: typeof ListRoute;
let byId: typeof IdRoute;
let roles: typeof RolesRoute;
let members: typeof MembersRoute;
let userGroups: typeof UserGroupsRoute;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  deletedTables.length = 0;
  state.group = {
    id: GROUP,
    organization_id: ORG_A,
    key: "marketing",
    name: "Marketing",
    description: null,
    created_at: "2026-01-01",
  };
  state.org = { id: ORG_A };
  state.roles = [{ id: ROLE, organization_id: ORG_A }];
  state.conferredPermKeys = [];
  state.eligibleMembers = [{ app_user_id: USER }];
  state.membership = { id: "m-1" };
  state.listExec = [];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  list = await import("@/app/api/administrator/groups/route");
  byId = await import("@/app/api/administrator/groups/[id]/route");
  roles = await import("@/app/api/administrator/groups/[id]/roles/route");
  members = await import("@/app/api/administrator/groups/[id]/members/route");
  userGroups = await import("@/app/api/administrator/users/[id]/groups/route");
});
afterEach(() => vi.resetModules());

describe("groups list + create", () => {
  it("null-scope admin gets an EMPTY list", async () => {
    accessGetter.mockResolvedValue(nullScopeAdmin(["admin.groups.read"]));
    state.group = { total: "5" };
    const res = await list.GET(req("groups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("ORG ADMIN list is org-scoped (200)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    state.group = { total: "0" };
    expect((await list.GET(req("groups"))).status).toBe(200);
  });

  it("ORG ADMIN creates a group in their own org (201)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.create"]));
    const res = await list.POST(
      req("groups", { method: "POST", body: { key: "team.x", name: "Team X" } }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERADMIN must name a target org (400 when omitted)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.groups.create"]));
    const res = await list.POST(
      req("groups", { method: "POST", body: { key: "team.x", name: "Team X" } }),
    );
    expect(res.status).toBe(400);
  });

  it("403 when caller lacks admin.groups.create", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    expect(
      (await list.POST(req("groups", { method: "POST", body: { key: "k", name: "N" } }))).status,
    ).toBe(403);
  });
});

describe("groups/[id] GET/PATCH/DELETE", () => {
  it("GET 200 own-org; 404 foreign", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    expect((await byId.GET(req(`groups/${GROUP}`), groupCtx)).status).toBe(200);
    state.group = { ...state.group!, organization_id: ORG_B };
    expect((await byId.GET(req(`groups/${GROUP}`), groupCtx)).status).toBe(404);
  });

  it("PATCH 200 own-org; 404 foreign", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.update"]));
    expect(
      (
        await byId.PATCH(
          req(`groups/${GROUP}`, { method: "PATCH", body: { name: "Renamed" } }),
          groupCtx,
        )
      ).status,
    ).toBe(200);
    state.group = { ...state.group!, organization_id: ORG_B };
    expect(
      (
        await byId.PATCH(
          req(`groups/${GROUP}`, { method: "PATCH", body: { name: "Renamed" } }),
          groupCtx,
        )
      ).status,
    ).toBe(404);
  });

  it("DELETE 200 own-org; 404 foreign", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.delete"]));
    expect((await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx)).status).toBe(
      200,
    );
    state.group = { ...state.group!, organization_id: ORG_B };
    expect((await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx)).status).toBe(
      404,
    );
  });
});

describe("groups/[id]/roles — same-org + superuser guards", () => {
  const body = { roleIds: [ROLE] };
  it("attaches an own-org role (200)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(200);
  });

  it("404 when a role belongs to another org (cannot bundle foreign/global roles)", async () => {
    state.roles = [{ id: ROLE, organization_id: ORG_B }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(404);
  });

  it("404 when a role is GLOBAL (organization_id null)", async () => {
    state.roles = [{ id: ROLE, organization_id: null }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(404);
  });

  it("403 when a non-superadmin bundles a role granting `superuser`", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(403);
  });

  it("403 when a non-superadmin bundles a role conferring a permission they lack (AUTHZ-3)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(403);
  });

  it("200 when the bundled role's permissions are a subset the actor holds (AUTHZ-3)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(200);
  });

  it("SUPERADMIN MAY bundle a `superuser`-granting role (200)", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(200);
  });

  it("404 for a foreign group", async () => {
    state.group = { ...state.group!, organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(404);
  });
});

describe("groups/[id]/members — org-membership constraint", () => {
  it("adds an eligible org member (200)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(200);
  });

  it("404 when no requested user is an active member of the group's org", async () => {
    state.eligibleMembers = []; // cross-org ids → none eligible
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(404);
  });

  it("403 when the group confers a permission the actor lacks (AUTHZ-3 membership)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(403);
  });

  it("403 when the group confers `superuser` to a non-superadmin", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(403);
  });

  it("200 when the group's conferred permissions are a subset the actor holds", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(200);
  });

  it("SUPERADMIN MAY add members to a `superuser`-conferring group (200)", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, { method: "POST", body: { appUserIds: [USER] } }),
      groupCtx,
    );
    expect(res.status).toBe(200);
  });

  it("404 for a foreign group", async () => {
    state.group = { ...state.group!, organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    expect((await members.GET(req(`groups/${GROUP}/members`), groupCtx)).status).toBe(404);
  });
});

describe("groups/[id] body-id validation (review #70)", () => {
  // A body id is used verbatim in `where(... "in", ids)` against a `uuid`
  // column, so anything that is not UUID-shaped reaches Postgres as a 22P02
  // and surfaces as an opaque 500. Every one of these must be a 400 instead.
  const badRoleIds = ["not-a-uuid", "", "------------------------------------"];
  for (const bad of badRoleIds) {
    it(`roles POST rejects ${JSON.stringify(bad)} with 400`, async () => {
      accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
      const res = await roles.POST(
        req(`groups/${GROUP}/roles`, { method: "POST", body: { roleIds: [bad] } }),
        groupCtx,
      );
      expect(res.status).toBe(400);
    });
    it(`roles DELETE rejects ${JSON.stringify(bad)} with 400`, async () => {
      accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
      const res = await roles.DELETE(
        req(`groups/${GROUP}/roles`, { method: "DELETE", body: { roleIds: [bad] } }),
        groupCtx,
      );
      expect(res.status).toBe(400);
    });
  }

  // The old members schema was /^[0-9a-f-]{36}$/i — 36 hyphens passed it.
  it("members POST rejects a 36-character non-UUID with 400", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.POST(
      req(`groups/${GROUP}/members`, {
        method: "POST",
        body: { appUserIds: ["------------------------------------"] },
      }),
      groupCtx,
    );
    expect(res.status).toBe(400);
  });

  it("members DELETE rejects a 36-character non-UUID with 400", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.DELETE(
      req(`groups/${GROUP}/members`, {
        method: "DELETE",
        body: { appUserIds: ["------------------------------------"] },
      }),
      groupCtx,
    );
    expect(res.status).toBe(400);
  });

  // The DB returns one row per DISTINCT id, so the pre-#70 length compare
  // turned a duplicated (but real) role id into a false role_not_found 404.
  it("roles POST accepts a duplicated role id (no false 404) and audits it once", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await roles.POST(
      req(`groups/${GROUP}/roles`, { method: "POST", body: { roleIds: [ROLE, ROLE] } }),
      groupCtx,
    );
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.group.roles_changed",
      "success",
      expect.objectContaining({ metadata: expect.objectContaining({ added: [ROLE] }) }),
    );
  });
});

describe("users/[id]/groups", () => {
  it("GET 200 (scoped to the actor's org)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    expect((await userGroups.GET(req(`users/${USER}/groups`), userCtx)).status).toBe(200);
  });

  it("POST 201 adds the user to an own-org group they belong to", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(201);
  });

  it("POST 404 for a foreign-org group", async () => {
    state.group = { ...state.group!, organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(404);
  });

  it("POST 404 when the user is not a member of the group's org", async () => {
    state.membership = undefined; // userHasMembershipInOrg → false
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(404);
  });

  it("POST 403 when the group confers a permission the actor lacks (AUTHZ-3 — self-escalation)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(403);
  });

  it("POST 201 when the group's conferred permissions are a subset the actor holds", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(201);
  });

  it("SUPERADMIN bypasses the conferral guard (201) even for a `superuser` group", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    const res = await userGroups.POST(
      req(`users/${USER}/groups`, { method: "POST", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(201);
  });
});

/**
 * REVOKE-1 (review #444) — group REVOCATION is bounded by the same AUTHZ-3
 * subset test as the grant.
 *
 * The conferral guard was applied only to the three POSTs above, so the grant
 * side and the revoke side disagreed about who is trusted with a group: an
 * admin holding nothing but `admin.groups.assign` could not BUILD a group
 * carrying authority they lack, but could dismantle one with a single DELETE —
 * and AUTHZ-3 then forbade them from putting it back. On a deployment that
 * models administrative authority as a group, that is a one-request,
 * unrecoverable lockout, one route over from the four the branch already
 * closed. Each DELETE is checked against what the removal destroys:
 * `permissionKeysForRoles` for the role detach, `permissionKeysForGroup` for
 * both membership removals and for deleting the group itself.
 *
 * F-11: `DELETE /groups/[id]` was the one group revocation left out. Its
 * cascade takes every bundled role from every member at once, so an admin
 * holding only `admin.groups.delete` could do in one request what the two
 * guarded DELETEs refuse piecemeal.
 */
describe("group revocation carries the conferral guard (REVOKE-1)", () => {
  const rolesBody = { roleIds: [ROLE] };
  const membersBody = { appUserIds: [USER] };

  it("roles DELETE → 403 when the detached role confers `superuser`", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await roles.DELETE(
      req(`groups/${GROUP}/roles`, { method: "DELETE", body: rolesBody }),
      groupCtx,
    );
    expect(res.status).toBe(403);
  });

  it("roles DELETE → 403 when the detached role confers a permission the actor lacks", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await roles.DELETE(
      req(`groups/${GROUP}/roles`, { method: "DELETE", body: rolesBody }),
      groupCtx,
    );
    expect(res.status).toBe(403);
  });

  it("roles DELETE → 200 when the removed permissions are a subset the actor holds", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    const res = await roles.DELETE(
      req(`groups/${GROUP}/roles`, { method: "DELETE", body: rolesBody }),
      groupCtx,
    );
    expect(res.status).toBe(200);
  });

  it("roles DELETE → SUPERADMIN may still detach a `superuser`-granting role (200)", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    const res = await roles.DELETE(
      req(`groups/${GROUP}/roles`, { method: "DELETE", body: rolesBody }),
      groupCtx,
    );
    expect(res.status).toBe(200);
  });

  it("members DELETE → 403 when the group confers a permission the actor lacks", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await members.DELETE(
      req(`groups/${GROUP}/members`, { method: "DELETE", body: membersBody }),
      groupCtx,
    );
    expect(res.status).toBe(403);
  });

  it("members DELETE → 200 for a subset group, and SUPERADMIN is never gated", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    expect(
      (
        await members.DELETE(
          req(`groups/${GROUP}/members`, { method: "DELETE", body: membersBody }),
          groupCtx,
        )
      ).status,
    ).toBe(200);

    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    expect(
      (
        await members.DELETE(
          req(`groups/${GROUP}/members`, { method: "DELETE", body: membersBody }),
          groupCtx,
        )
      ).status,
    ).toBe(200);
  });

  it("users/[id]/groups DELETE → 403 when the group confers a permission the actor lacks", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    const res = await userGroups.DELETE(
      req(`users/${USER}/groups`, { method: "DELETE", body: { groupId: GROUP } }),
      userCtx,
    );
    expect(res.status).toBe(403);
  });

  it("group DELETE → 403 when the group confers a permission the actor lacks, deletes nothing, and audits the denial (F-11)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }, { key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.delete", "admin.users.read"]));
    const res = await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    expect(deletedTables).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.group.delete_denied",
      "denied",
      expect.objectContaining({
        organizationId: ORG_A,
        reason: "unheld_permissions",
        metadata: expect.objectContaining({
          groupId: GROUP,
          key: "marketing",
          // Only what the actor could not confer, not the whole bundle.
          unheldPermissions: ["admin.users.delete"],
        }),
      }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.group.deleted",
      expect.anything(),
      expect.anything(),
    );
  });

  it("group DELETE → 403 when the group confers `superuser` (F-11)", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.delete"]));
    const res = await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx);
    expect(res.status).toBe(403);
    expect(deletedTables).toEqual([]);
  });

  it("group DELETE → 200 for a subset group, and SUPERADMIN is never gated (F-11)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.delete", "admin.users.read"]));
    expect((await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx)).status).toBe(
      200,
    );
    expect(deletedTables).toEqual(["app_groups"]);

    deletedTables.length = 0;
    // The SUPERADMIN fast-path, not the subset test, must be what lets this
    // through: the group confers a CUSTOM key (POST /permissions can mint one)
    // that the superadmin does not literally hold, as getUserAccessContext
    // expands a superadmin only to the static admin catalog. Without the
    // fast-path this is a 403.
    state.conferredPermKeys = [{ key: "crm.deals.write" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.delete"]));
    expect((await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx)).status).toBe(
      200,
    );
    expect(deletedTables).toEqual(["app_groups"]);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.group.deleted",
      "success",
      expect.objectContaining({ organizationId: ORG_A }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.group.delete_denied",
      expect.anything(),
      expect.anything(),
    );
  });

  it("group DELETE → a foreign group stays 404 even when it confers `superuser` (no existence leak)", async () => {
    state.group = { ...state.group!, organization_id: ORG_B };
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.delete"]));
    const res = await byId.DELETE(req(`groups/${GROUP}`, { method: "DELETE" }), groupCtx);
    expect(res.status).toBe(404);
    expect(deletedTables).toEqual([]);
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.group.delete_denied",
      expect.anything(),
      expect.anything(),
    );
  });

  it("users/[id]/groups DELETE → 200 for a subset group, and SUPERADMIN is never gated", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign", "admin.users.read"]));
    expect(
      (
        await userGroups.DELETE(
          req(`users/${USER}/groups`, { method: "DELETE", body: { groupId: GROUP } }),
          userCtx,
        )
      ).status,
    ).toBe(200);

    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.groups.assign"]));
    expect(
      (
        await userGroups.DELETE(
          req(`users/${USER}/groups`, { method: "DELETE", body: { groupId: GROUP } }),
          userCtx,
        )
      ).status,
    ).toBe(200);
  });
});
