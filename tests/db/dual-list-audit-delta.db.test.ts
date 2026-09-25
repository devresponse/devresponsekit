import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-38: the two dual-list write pairs audit the delta they
 * APPLIED.
 *
 * `POST`/`DELETE /roles/[id]/permissions` and `POST`/`DELETE
 * /groups/[id]/roles` used to audit what the request NAMED: a re-POST of an
 * attached key logged it as added again, and a DELETE naming something never
 * attached logged it as removed (the group DELETE even logged duplicates).
 * The fix reads the delta from `RETURNING` on the insert and the delete. The
 * mocked suites (roles-subresources, groups) pin that the handlers audit
 * whatever `RETURNING` reports; this file pins what Postgres actually reports
 * — `ON CONFLICT DO NOTHING ... RETURNING` yields ONLY the rows it inserted,
 * and `DELETE ... RETURNING` only the rows it removed — by driving the REAL
 * handlers against real Postgres. Only auth, the rate limiter and the audit
 * sink are stubbed; the audit sink is captured so the assertion reads the
 * exact metadata the handler wrote.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditRoleMock = vi.fn();
const auditOrgMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 1000, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: (...a: unknown[]) => auditRoleMock(...a),
  auditOrgAction: (...a: unknown[]) => auditOrgMock(...a),
}));

const { db, pgPool } = await import("@/db/database");
const permissionsRoute = await import("@/app/api/administrator/roles/[id]/permissions/route");
const groupRolesRoute = await import("@/app/api/administrator/groups/[id]/roles/route");

const PREFIX = "__dbtest_duallist_";
const ACTOR = `${PREFIX}admin`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-duallist-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.roles.update", "admin.groups.assign", "superuser"],
};

function req(path: string, method: "POST" | "DELETE", body: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function cleanup(): Promise<void> {
  // Child → parent. app_group_roles cascades off app_groups; app_role_permissions
  // has no ON DELETE, so it goes before both of its parents.
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "DBTest DualList Org" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newRole(orgId: string, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Catalog permissions keyed by suffix; the keys themselves carry the prefix. */
async function newPermissions(...suffixes: string[]): Promise<Record<string, string>> {
  const rows = await db
    .insertInto("app_permissions")
    .values(suffixes.map((s) => ({ key: `${PREFIX}${s}`, description: null })))
    .returning(["id", "key"])
    .execute();
  return Object.fromEntries(rows.map((r) => [r.key.slice(PREFIX.length), r.id]));
}

function lastMetadata(mock: ReturnType<typeof vi.fn>, eventType: string) {
  const calls = mock.mock.calls.filter((c) => c[0] === eventType);
  expect(calls, `exactly one ${eventType} row`).toHaveLength(1);
  return (calls[0]![2] as { metadata: Record<string, unknown> }).metadata;
}

beforeEach(async () => {
  await cleanup();
  for (const m of [sessionGetter, accessGetter, auditRoleMock, auditOrgMock]) m.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("roles/[id]/permissions audits the applied delta (DB-backed, F-38)", () => {
  it("POST records only the key it attached, not one the role already carried", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "role");
    const perm = await newPermissions("a", "b");
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: roleId, permission_id: perm.a! })
      .execute();

    const res = await permissionsRoute.POST(
      req(`roles/${roleId}/permissions`, "POST", { ids: [`${PREFIX}a`, `${PREFIX}b`] }),
      ctx(roleId),
    );

    expect(res.status).toBe(200);
    expect(lastMetadata(auditRoleMock, "admin.role.permissions_changed")).toMatchObject({
      added: [`${PREFIX}b`],
      removed: [],
      resulting: expect.arrayContaining([`${PREFIX}a`, `${PREFIX}b`]),
    });
  });

  it("DELETE records only the key it detached, not one the role never carried", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "role");
    const perm = await newPermissions("a", "b");
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: roleId, permission_id: perm.a! })
      .execute();

    const res = await permissionsRoute.DELETE(
      req(`roles/${roleId}/permissions`, "DELETE", { ids: [`${PREFIX}a`, `${PREFIX}b`] }),
      ctx(roleId),
    );

    expect(res.status).toBe(200);
    expect(lastMetadata(auditRoleMock, "admin.role.permissions_changed")).toMatchObject({
      added: [],
      removed: [`${PREFIX}a`],
      resulting: [],
    });
  });
});

describe("groups/[id]/roles audits the applied delta (DB-backed, F-38)", () => {
  async function groupWith(orgId: string, bundled: string[]): Promise<string> {
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgId, key: `${PREFIX}grp`, name: "DBTest Group" })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const roleId of bundled) {
      await db
        .insertInto("app_group_roles")
        .values({ group_id: group.id, role_id: roleId, organization_id: orgId })
        .execute();
    }
    return group.id;
  }

  it("POST records only the role it bundled, once, not one already bundled", async () => {
    const orgId = await newOrg();
    const bundled = await newRole(orgId, "bundled");
    const fresh = await newRole(orgId, "fresh");
    const groupId = await groupWith(orgId, [bundled]);

    const res = await groupRolesRoute.POST(
      req(`groups/${groupId}/roles`, "POST", { roleIds: [bundled, fresh, fresh] }),
      ctx(groupId),
    );

    expect(res.status).toBe(200);
    expect(lastMetadata(auditOrgMock, "admin.group.roles_changed")).toEqual({
      groupId,
      key: `${PREFIX}grp`,
      added: [fresh],
    });
  });

  it("DELETE records only the role it unbundled — no duplicate, no never-bundled role", async () => {
    const orgId = await newOrg();
    const bundled = await newRole(orgId, "bundled");
    const never = await newRole(orgId, "never");
    const groupId = await groupWith(orgId, [bundled]);

    const res = await groupRolesRoute.DELETE(
      req(`groups/${groupId}/roles`, "DELETE", { roleIds: [bundled, bundled, never] }),
      ctx(groupId),
    );

    expect(res.status).toBe(200);
    expect(lastMetadata(auditOrgMock, "admin.group.roles_changed")).toEqual({
      groupId,
      key: `${PREFIX}grp`,
      removed: [bundled],
    });
  });

  it("a request that changes nothing still writes one row, with an empty delta", async () => {
    const orgId = await newOrg();
    const bundled = await newRole(orgId, "bundled");
    const groupId = await groupWith(orgId, [bundled]);

    const res = await groupRolesRoute.POST(
      req(`groups/${groupId}/roles`, "POST", { roleIds: [bundled] }),
      ctx(groupId),
    );

    expect(res.status).toBe(200);
    expect(lastMetadata(auditOrgMock, "admin.group.roles_changed")).toMatchObject({ added: [] });
  });
});
