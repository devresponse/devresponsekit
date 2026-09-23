import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as UserTargetModule from "@/lib/admin/user-target.server";
import { ANY_ADMIN_PERMISSION, SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/**
 * F-12 — deleting a membership takes the member's grants in that org with it.
 *
 * Before the fix both membership DELETE routes removed only the
 * `app_organization_memberships` row. The member's `app_user_roles` rows for
 * that org and their `app_group_memberships` in its groups stayed behind,
 * dormant, and re-adding or re-inviting the user revived every one of them
 * (`superuser` included) with no conferral check and no audit row. Now:
 *
 *   - the grant rows are deleted in the SAME transaction as the membership;
 *   - REVOKE-2 is read BEFORE those deletes (after them it would find nothing
 *     left to protect);
 *   - REVOKE-1 runs on exactly the rows the deletes returned, with the P1-1
 *     wiring (a bearer credential is bounded by its scopes and never takes the
 *     SUPERADMIN fast-path), and a refusal rolls the deletes back;
 *   - every removed grant is audited under the event type its single-row
 *     route writes, with `cause: "membership_removed"`.
 *
 * Both routes are driven through the same cases. The admin guard is stubbed so
 * a bearer credential's `grantedScopes` can be injected (the security suite's
 * real guard cannot), and the rank guard is stubbed open: it is pinned in
 * `administrator-organization-members.test.ts` and `user-memberships.test.ts`,
 * and this file is about what happens once it has passed. The conferral and
 * last-superadmin helpers run for real against the stubbed db below.
 * `tests/db/membership-delete-grants.db.test.ts` runs the real SQL.
 */
const requireAdminMock = vi.fn();
const auditMock = vi.fn();

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MEMBERSHIP_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: () => requireAdminMock(),
  isAdminPermissionDenial: (result: unknown) =>
    typeof result === "object" && result !== null && "response" in result,
}));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
  auditOrgAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/admin/user-target.server", async () => {
  const actual = await vi.importActual<typeof UserTargetModule>("@/lib/admin/user-target.server");
  return {
    ...actual,
    // Literals, not the consts above: a `vi.mock` factory is hoisted.
    resolveTargetUser: async () => ({
      appUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      betterAuthUserId: "ba-target",
      primaryEmail: "target@x.com",
      displayName: null,
      status: "active",
    }),
    isResolvedUserResponse: (v: unknown) => v instanceof Response,
    refuseOutrankingTarget: async () => null,
  };
});

type Row = Record<string, unknown>;
const state: {
  /** The membership row both routes resolve (org-centric and user-centric columns). */
  memberships: Row[];
  /** Rows `activeGlobalSuperuserGrants` sees (REVOKE-2). */
  superuserGrants: Row[];
  /** What the grant deletes' `returning(...)` gives back. */
  roles: Row[];
  groups: Row[];
  /** What `permissionKeysForRoles` / `permissionKeysForGroups` resolve. */
  roleKeys: Array<{ key: string }>;
  groupKeys: Array<{ key: string }>;
  /** Tables the transaction deleted from, in order. */
  deleted: string[];
  txn: "none" | "committed" | "rolled_back";
} = {
  memberships: [],
  superuserGrants: [],
  roles: [],
  groups: [],
  roleKeys: [],
  groupKeys: [],
  deleted: [],
  txn: "none",
};

vi.mock("@/db/database", () => {
  const tableKey = (t: unknown) => String(t).split(" ")[0] ?? "";
  function selectRows(table: string): unknown[] {
    if (table === "app_organization_memberships") return state.memberships;
    if (table === "app_user_roles") return state.superuserGrants;
    if (table === "app_role_permissions") return state.roleKeys;
    if (table === "app_group_roles") return state.groupKeys;
    return [];
  }
  function deleteRows(table: string): unknown[] {
    state.deleted.push(table);
    if (table === "app_user_roles") return state.roles;
    if (table === "app_group_memberships") return state.groups;
    return [];
  }
  function chain(table: string, kind: "select" | "delete"): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") {
            return async () => (kind === "delete" ? deleteRows(table) : selectRows(table));
          }
          if (prop === "executeTakeFirst") {
            return async () =>
              table === "app_organizations" ? { id: ORG_ID, slug: "org-a" } : undefined;
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  const trx = {
    selectFrom: (t: unknown) => chain(tableKey(t), "select"),
    deleteFrom: (t: unknown) => chain(tableKey(t), "delete"),
  };
  return {
    db: {
      ...trx,
      transaction: () => ({
        execute: async (cb: (t: unknown) => Promise<unknown>) => {
          try {
            const result = await cb(trx);
            state.txn = "committed";
            return result;
          } catch (err) {
            state.txn = "rolled_back";
            throw err;
          }
        },
      }),
    },
  };
});

const ROLE_ROW = {
  app_user_id: USER_ID,
  organization_id: ORG_ID,
  role_id: "r-org-admin",
  role_key: "org-admin",
};
const GROUP_ROW = {
  app_user_id: USER_ID,
  group_id: "g-admins",
  group_key: "admins",
  organization_id: ORG_ID,
};

/** The admin guard's grant: a cookie session when `grantedScopes` is null. */
function grant(permissions: string[], grantedScopes: string[] | null) {
  return {
    betterAuthUserId: "ba-actor",
    access: {
      appUserId: "actor-1",
      primaryEmail: "a@x.com",
      status: "active",
      organizationId: ORG_ID,
      membershipStatus: "active",
      preferredLocale: "en",
      permissions,
      orgBound: grantedScopes !== null,
    } satisfies AuthStatusModule.UserAccessContext,
    requestId: "req-f12",
    callerKind: grantedScopes === null ? ("cookie" as const) : ("api_key" as const),
    credentialId: grantedScopes === null ? null : "key-1",
    grantedScopes,
  };
}

interface RouteCase {
  name: string;
  /** The permission the route gates on. */
  gate: string;
  /** The `admin.user.membership_removed` row's metadata, grant ids included. */
  userRowMetadata: Record<string, unknown>;
  call: () => Promise<Response>;
}

function req(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const ROUTES: RouteCase[] = [
  {
    name: "DELETE /organizations/[id]/members",
    gate: "admin.orgs.update",
    userRowMetadata: {
      membershipId: MEMBERSHIP_ID,
      revokedRoleIds: ["r-org-admin"],
      removedGroupIds: ["g-admins"],
    },
    call: async () => {
      const { DELETE } = await import("@/app/api/administrator/organizations/[id]/members/route");
      return DELETE(
        req(`http://test.local/api/administrator/organizations/${ORG_ID}/members`, {
          membershipIds: [MEMBERSHIP_ID],
        }),
        { params: Promise.resolve({ id: ORG_ID }) },
      );
    },
  },
  {
    name: "DELETE /users/[id]/memberships",
    gate: "admin.users.update",
    userRowMetadata: {
      membershipIds: [MEMBERSHIP_ID],
      revokedRoleIds: ["r-org-admin"],
      removedGroupIds: ["g-admins"],
    },
    call: async () => {
      const { DELETE } = await import("@/app/api/administrator/users/[id]/memberships/route");
      return DELETE(
        req(`http://test.local/api/administrator/users/${USER_ID}/memberships`, {
          membershipIds: [MEMBERSHIP_ID],
        }),
        { params: Promise.resolve({ id: USER_ID }) },
      );
    },
  },
];

beforeEach(() => {
  requireAdminMock.mockReset();
  auditMock.mockReset();
  state.memberships = [
    {
      id: MEMBERSHIP_ID,
      app_user_id: USER_ID,
      organization_id: ORG_ID,
      slug: "org-a",
      better_auth_user_id: "ba-target",
      primary_email: "target@x.com",
      display_name: null,
      status: "active",
    },
  ];
  state.superuserGrants = [];
  state.roles = [ROLE_ROW];
  state.groups = [GROUP_ROW];
  state.roleKeys = [];
  state.groupKeys = [];
  state.deleted = [];
  state.txn = "none";
});
afterEach(() => vi.resetModules());

const GRANTS_THEN_MEMBERSHIP = [
  "app_user_roles",
  "app_group_memberships",
  "app_organization_memberships",
];

function successAuditTypes(): string[] {
  return auditMock.mock.calls.filter((c) => c[1] === "success").map((c) => String(c[0]));
}

describe.each(ROUTES)("$name — the member's grants leave with the membership (F-12)", (route) => {
  it("deletes the role and group rows in the membership's transaction (SUPERADMIN at a browser)", async () => {
    requireAdminMock.mockResolvedValue(grant([route.gate, "superuser"], null));
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual(GRANTS_THEN_MEMBERSHIP);
    expect(state.txn).toBe("committed");
  });

  it("audits each removed grant as its own revocation, and lists them on the membership row", async () => {
    requireAdminMock.mockResolvedValue(grant([route.gate, "superuser"], null));
    expect((await route.call()).status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.role_revoked",
      "success",
      expect.objectContaining({
        appUserId: USER_ID,
        metadata: {
          roleId: "r-org-admin",
          roleKey: "org-admin",
          organizationId: ORG_ID,
          cause: "membership_removed",
        },
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "admin.group.members_removed",
      "success",
      expect.objectContaining({
        organizationId: ORG_ID,
        metadata: {
          groupId: "g-admins",
          key: "admins",
          appUserIds: [USER_ID],
          cause: "membership_removed",
        },
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.membership_removed",
      "success",
      expect.objectContaining({
        appUserId: USER_ID,
        metadata: expect.objectContaining(route.userRowMetadata),
      }),
    );
  });

  it("keeps the SUPERADMIN fast-path: a grant conferring a key the superadmin does not literally hold still goes", async () => {
    // `getUserAccessContext` expands a superadmin only to the static admin
    // catalog, so a custom key is never in their set. Only the fast-path lets
    // this through; running the guard for every caller would refuse it.
    requireAdminMock.mockResolvedValue(grant([route.gate, "superuser"], null));
    state.roleKeys = [{ key: "crm.deals.write" }];
    expect((await route.call()).status).toBe(200);
  });

  it("allows an org admin who could confer every removed permission", async () => {
    requireAdminMock.mockResolvedValue(
      grant([route.gate, "admin.roles.update", "shell.view"], null),
    );
    state.roleKeys = [{ key: "admin.roles.update" }];
    state.groupKeys = [{ key: "shell.view" }];
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual(GRANTS_THEN_MEMBERSHIP);
  });

  it("REVOKE-1: 403 + a denial row, and the grant deletes roll back, when a removed ROLE confers a permission the org admin lacks", async () => {
    requireAdminMock.mockResolvedValue(grant([route.gate, "shell.view"], null));
    state.roleKeys = [{ key: "admin.users.delete" }];
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(state.txn).toBe("rolled_back");
    expect(state.deleted).not.toContain("app_organization_memberships");
    expect(auditMock).toHaveBeenCalledWith(
      "admin.membership.revocation_denied",
      "denied",
      expect.objectContaining({
        reason: "unheld_permissions",
        requestId: "req-f12",
        metadata: expect.objectContaining({ unheldPermissions: ["admin.users.delete"] }),
      }),
    );
    expect(successAuditTypes()).toEqual([]);
  });

  it("REVOKE-1: 403 when the member leaves a GROUP conferring a permission the org admin lacks", async () => {
    requireAdminMock.mockResolvedValue(grant([route.gate, "shell.view"], null));
    state.groupKeys = [{ key: "superuser" }];
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(state.txn).toBe("rolled_back");
    expect(successAuditTypes()).toEqual([]);
  });

  it("P1-1: a superuser-owned bearer key is bounded by its scopes, not its owner's authority", async () => {
    requireAdminMock.mockResolvedValue(
      grant([route.gate, "admin.roles.update", "superuser"], [route.gate]),
    );
    state.roleKeys = [{ key: "admin.roles.update" }];
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(state.txn).toBe("rolled_back");
  });

  it("P1-1: a bearer key whose scopes cover the removed grants may remove them", async () => {
    requireAdminMock.mockResolvedValue(
      grant([route.gate, "admin.roles.update", "superuser"], [route.gate, "admin.roles.*"]),
    );
    state.roleKeys = [{ key: "admin.roles.update" }];
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual(GRANTS_THEN_MEMBERSHIP);
  });

  it("REVOKE-2 is read BEFORE the grant deletes: refusing the last superadmin deletes nothing", async () => {
    requireAdminMock.mockResolvedValue(grant([route.gate, "superuser"], null));
    state.superuserGrants = [{ app_user_id: USER_ID, organization_id: ORG_ID, role_id: "r-super" }];
    const res = await route.call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_superadmin" });
    expect(state.deleted).toEqual([]);
  });
});

/**
 * What a BEARER credential may take away with a membership. Its REVOKE-1
 * bound is its scopes (P1-1), but no scope can name `shell.view`, and every
 * seeded role confers it. Measured like any other key, it made every member
 * holding an ordinary role unremovable by any API key or OAuth token, however
 * it was scoped and whoever owned it. The membership implies `shell.view`, so
 * it goes with the membership and is not measured. A key no scope can name
 * (a custom app key) is bounded by the owner's own conferral authority, as the
 * rank guard bounds the member. `superuser` and any key a scope CAN name stay
 * bounded by the scopes.
 */
describe.each(ROUTES)("$name — a bearer credential offboarding a member (F-12)", (route) => {
  /** The seeded `admin.platform` role: an org admin's whole authority. */
  const ORG_ADMIN = ["shell.view", ...ANY_ADMIN_PERMISSION];
  /** The seeded `member`, `admin` and `superuser` roles' permissions. */
  const MEMBER_ROLE = ["shell.view"];
  const ADMIN_ROLE = ["shell.view", "admin.users.read", "admin.users.manage", "admin.audit.read"];
  const SUPERUSER_ROLE = ["shell.view", "superuser"];
  const keys = (list: ReadonlyArray<string>) => list.map((key) => ({ key }));

  function deniedKeys(): unknown {
    const denial = auditMock.mock.calls.find((c) => c[0] === "admin.membership.revocation_denied");
    return (denial?.[2] as { metadata?: { unheldPermissions?: unknown } } | undefined)?.metadata
      ?.unheldPermissions;
  }

  it("an org admin's key scoped admin.* removes a member holding the seeded `member` role", async () => {
    requireAdminMock.mockResolvedValue(grant(ORG_ADMIN, ["admin.*"]));
    state.roleKeys = keys(MEMBER_ROLE);
    state.groupKeys = keys(MEMBER_ROLE);
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual(GRANTS_THEN_MEMBERSHIP);
    expect(state.txn).toBe("committed");
  });

  it("a superuser's key scoped admin.* removes a member holding the seeded `member` role", async () => {
    requireAdminMock.mockResolvedValue(grant([...SUPERUSER_PERMISSIONS], ["admin.*"]));
    state.roleKeys = keys(MEMBER_ROLE);
    expect((await route.call()).status).toBe(200);
  });

  it("an org admin's key scoped admin.* removes a member holding the seeded `admin` role", async () => {
    requireAdminMock.mockResolvedValue(grant(ORG_ADMIN, ["admin.*"]));
    state.roleKeys = keys(ADMIN_ROLE);
    state.groupKeys = keys(MEMBER_ROLE);
    expect((await route.call()).status).toBe(200);
  });

  it("a key scoped only to the route is still refused the member's admin.* grants, and only those", async () => {
    requireAdminMock.mockResolvedValue(grant(ORG_ADMIN, [route.gate]));
    state.roleKeys = keys(ADMIN_ROLE);
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(state.txn).toBe("rolled_back");
    expect(deniedKeys()).toEqual(["admin.users.read", "admin.users.manage", "admin.audit.read"]);
  });

  it("a key never strips `superuser`, even a superuser's key scoped admin.*", async () => {
    requireAdminMock.mockResolvedValue(grant([...SUPERUSER_PERMISSIONS], ["admin.*"]));
    state.roleKeys = keys(SUPERUSER_ROLE);
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(state.txn).toBe("rolled_back");
    expect(deniedKeys()).toEqual(["superuser"]);
  });

  it("a custom app key no scope can name is bounded by the owner's authority: held, it goes", async () => {
    requireAdminMock.mockResolvedValue(grant([...ORG_ADMIN, "crm.deals.write"], ["admin.*"]));
    state.roleKeys = keys([...MEMBER_ROLE, "crm.deals.write"]);
    expect((await route.call()).status).toBe(200);
  });

  it("a custom app key the owner does not hold is refused", async () => {
    requireAdminMock.mockResolvedValue(grant(ORG_ADMIN, ["admin.*"]));
    state.roleKeys = keys([...MEMBER_ROLE, "crm.deals.write"]);
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(deniedKeys()).toEqual(["crm.deals.write"]);
  });

  it("a superuser's key may take a custom app key the superuser could confer", async () => {
    requireAdminMock.mockResolvedValue(grant([...SUPERUSER_PERMISSIONS], ["admin.*"]));
    state.roleKeys = keys([...MEMBER_ROLE, "crm.deals.write"]);
    expect((await route.call()).status).toBe(200);
  });

  it("a custom key a scope CAN name (admin.*) stays bounded by the scopes", async () => {
    requireAdminMock.mockResolvedValue(grant([...ORG_ADMIN, "admin.reports.view"], [route.gate]));
    state.roleKeys = keys([...MEMBER_ROLE, "admin.reports.view"]);
    const res = await route.call();
    expect(res.status).toBe(403);
    expect(deniedKeys()).toEqual(["admin.reports.view"]);
  });
});

describe("DELETE /organizations/[id]/members — a batch audits each member's own grants", () => {
  const OTHER_USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const OTHER_MEMBERSHIP = "22222222-2222-4222-8222-222222222222";

  it("each admin.user.membership_removed row lists only that member's roles and groups", async () => {
    requireAdminMock.mockResolvedValue(grant(["admin.orgs.update", "superuser"], null));
    state.memberships = [
      state.memberships[0]!,
      {
        ...state.memberships[0]!,
        id: OTHER_MEMBERSHIP,
        app_user_id: OTHER_USER,
        better_auth_user_id: "ba-other",
        primary_email: "other@x.com",
      },
    ];
    state.roles = [ROLE_ROW, { ...ROLE_ROW, app_user_id: OTHER_USER, role_id: "r-other" }];
    state.groups = [GROUP_ROW];
    const { DELETE } = await import("@/app/api/administrator/organizations/[id]/members/route");
    const res = await DELETE(
      req(`http://test.local/api/administrator/organizations/${ORG_ID}/members`, {
        membershipIds: [MEMBERSHIP_ID, OTHER_MEMBERSHIP],
      }),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(200);

    const rowFor = (appUserId: string) =>
      auditMock.mock.calls.find(
        (c) =>
          c[0] === "admin.user.membership_removed" &&
          (c[2] as { appUserId?: string }).appUserId === appUserId,
      )?.[2] as { metadata?: Record<string, unknown> } | undefined;
    expect(rowFor(USER_ID)?.metadata).toMatchObject({
      membershipId: MEMBERSHIP_ID,
      revokedRoleIds: ["r-org-admin"],
      removedGroupIds: ["g-admins"],
    });
    expect(rowFor(OTHER_USER)?.metadata).toMatchObject({
      membershipId: OTHER_MEMBERSHIP,
      revokedRoleIds: ["r-other"],
      removedGroupIds: [],
    });
  });
});
