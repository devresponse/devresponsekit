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
  grantsSuperuser: { id: string } | undefined;
  eligibleMembers: Array<{ app_user_id: string }>;
  membership: { id: string } | undefined;
  listExec: unknown[];
} = {
  group: undefined,
  org: undefined,
  roles: [],
  grantsSuperuser: undefined,
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
  if (table === "app_role_permissions") return state.grantsSuperuser;
  if (table === "app_organization_memberships") return state.membership;
  if (table === "app_group_roles" || table === "app_group_memberships")
    return { c: "0", total: "0" };
  return { total: "0", c: "0" };
}
function execFor(table: string): unknown[] {
  if (table === "app_roles") return state.roles;
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
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    insertInto: (t: unknown) => makeChain(tableKey(t)),
    updateTable: (t: unknown) => makeChain(tableKey(t)),
    deleteFrom: (t: unknown) => makeChain(tableKey(t)),
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
  state.grantsSuperuser = undefined;
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
    state.grantsSuperuser = { id: "perm-su" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.assign"]));
    expect(
      (await roles.POST(req(`groups/${GROUP}/roles`, { method: "POST", body }), groupCtx)).status,
    ).toBe(403);
  });

  it("SUPERADMIN MAY bundle a `superuser`-granting role (200)", async () => {
    state.grantsSuperuser = { id: "perm-su" };
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

  it("404 for a foreign group", async () => {
    state.group = { ...state.group!, organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.groups.read"]));
    expect((await members.GET(req(`groups/${GROUP}/members`), groupCtx)).status).toBe(404);
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
});
