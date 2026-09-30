import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED proof of F-38: the dual-list editors' save is ONE atomic
 * `PATCH { add, remove }` on `/roles/[id]/permissions` and
 * `/groups/[id]/roles`.
 *
 * The editors used to save through a POST of the additions and then a DELETE
 * of the removals. When the DELETE was refused (an org admin removing a key
 * they do not hold, REVOKE-1) the POST had already committed, so the addition
 * stayed live for every holder of the role or member of the group. Here the
 * REAL handlers run against Postgres, and a refusal of EITHER side leaves the
 * collection exactly as it was; a clean save applies both sides and audits
 * the delta Postgres reports (`RETURNING`), not the one the body named.
 *
 * Only auth, the rate limiter and the audit sink are stubbed. Driven by
 * `pnpm test:db` (vitest.db.config.ts); fixtures use `__dbtest_dlp_<run>_` and
 * self-clean.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditRoleMock = vi.fn();
const auditOrgMock = vi.fn();
/** F-58: a refusal writes through `auditEvent` (`refuseUnconferrable`). */
const auditEventMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/http/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 1000, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: (...a: unknown[]) => auditRoleMock(...a),
  auditOrgAction: (...a: unknown[]) => auditOrgMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditEventMock(...a),
}));

const { db, pgPool } = await import("@/db/database");
const permissionsRoute = await import("@/app/api/administrator/roles/[id]/permissions/route");
const groupRolesRoute = await import("@/app/api/administrator/groups/[id]/roles/route");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `__dbtest_dlp_${RUN}_`;
const ACTOR = `${PREFIX}admin`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-dlp-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.roles.update", "admin.groups.assign", "superuser"],
};

/** An org admin of `orgId` holding `held` besides the route's own permission. */
function orgAdmin(orgId: string, held: string[]): AuthStatusModule.UserAccessContext {
  return {
    ...SUPERADMIN,
    organizationId: orgId,
    permissions: ["admin.roles.update", "admin.groups.assign", ...held],
  };
}

function patch(path: string, body: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "PATCH",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function cleanup(): Promise<void> {
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

let seq = 0;
async function newOrg(): Promise<string> {
  seq += 1;
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org${seq}`, name: `DBTest DLP Org ${seq}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newRole(orgId: string, key: string, permissionIds: string[] = []): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const permission_id of permissionIds) {
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: row.id, permission_id })
      .execute();
  }
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

async function roleKeys(roleId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select("p.key")
    .where("rp.role_id", "=", roleId)
    .execute();
  return rows.map((r) => r.key.slice(PREFIX.length)).sort();
}

async function newGroup(orgId: string, bundled: string[]): Promise<string> {
  const group = await db
    .insertInto("app_groups")
    .values({ organization_id: orgId, key: `${PREFIX}grp${seq}`, name: "DBTest Group" })
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

async function groupRoleIds(groupId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_group_roles")
    .select("role_id")
    .where("group_id", "=", groupId)
    .execute();
  return rows.map((r) => r.role_id).sort();
}

function successMetadata(mock: ReturnType<typeof vi.fn>, eventType: string) {
  const calls = mock.mock.calls.filter((c) => c[0] === eventType);
  expect(calls, `exactly one ${eventType} row`).toHaveLength(1);
  return (calls[0]![2] as { metadata: Record<string, unknown> }).metadata;
}

function refusalAction(): unknown {
  expect(auditEventMock).toHaveBeenCalledTimes(1);
  const row = auditEventMock.mock.calls[0]![0] as {
    eventType: string;
    metadata: { action: string };
  };
  expect(row.eventType).toBe("admin.permission.conferral_denied");
  return row.metadata.action;
}

beforeEach(async () => {
  await cleanup();
  for (const m of [sessionGetter, accessGetter, auditRoleMock, auditOrgMock, auditEventMock]) {
    m.mockReset();
  }
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("PATCH /roles/[id]/permissions (DB-backed, F-38)", () => {
  it("applies both sides in one request and audits the delta Postgres reports", async () => {
    const orgId = await newOrg();
    const perm = await newPermissions("a", "b", "c", "d");
    const roleId = await newRole(orgId, "role", [perm.a!, perm.c!]);

    const res = await permissionsRoute.PATCH(
      patch(`roles/${roleId}/permissions`, {
        // `c` is already attached, `d` never was: neither is part of the delta.
        add: [`${PREFIX}b`, `${PREFIX}c`],
        remove: [`${PREFIX}a`, `${PREFIX}d`],
      }),
      ctx(roleId),
    );

    expect(res.status).toBe(200);
    expect(await roleKeys(roleId)).toEqual(["b", "c"]);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions.sort()).toEqual([`${PREFIX}b`, `${PREFIX}c`]);
    expect(successMetadata(auditRoleMock, "admin.role.permissions_changed")).toEqual({
      roleId,
      key: `${PREFIX}role`,
      added: [`${PREFIX}b`],
      removed: [`${PREFIX}a`],
      resulting: expect.arrayContaining([`${PREFIX}b`, `${PREFIX}c`]),
    });
  });

  it("a refused removal (REVOKE-1) lands the addition NOWHERE: the role is unchanged", async () => {
    // The review's scenario: the admin holds `b` and adds it, and removes `a`,
    // which they do not hold. Sent as POST then DELETE, `b` was committed for
    // every holder of the role before the DELETE was refused.
    const orgId = await newOrg();
    const perm = await newPermissions("a", "b");
    const roleId = await newRole(orgId, "role", [perm.a!]);
    accessGetter.mockResolvedValue(orgAdmin(orgId, [`${PREFIX}b`]));

    const res = await permissionsRoute.PATCH(
      patch(`roles/${roleId}/permissions`, { add: [`${PREFIX}b`], remove: [`${PREFIX}a`] }),
      ctx(roleId),
    );

    expect(res.status).toBe(403);
    expect(await roleKeys(roleId)).toEqual(["a"]);
    expect(refusalAction()).toBe("role_permissions_remove");
    expect(auditRoleMock).not.toHaveBeenCalled();
  });

  it("a refused addition (AUTHZ-3) removes nothing", async () => {
    const orgId = await newOrg();
    const perm = await newPermissions("a", "lacked");
    const roleId = await newRole(orgId, "role", [perm.a!]);
    accessGetter.mockResolvedValue(orgAdmin(orgId, [`${PREFIX}a`]));

    const res = await permissionsRoute.PATCH(
      patch(`roles/${roleId}/permissions`, { add: [`${PREFIX}lacked`], remove: [`${PREFIX}a`] }),
      ctx(roleId),
    );

    expect(res.status).toBe(403);
    expect(await roleKeys(roleId)).toEqual(["a"]);
    expect(refusalAction()).toBe("role_permissions_add");
  });

  it.each([
    ["an empty body", {}],
    ["two empty sides", { add: [], remove: [] }],
    ["a key on both sides", { add: [`${PREFIX}a`], remove: [`${PREFIX}a`] }],
    ["an unknown field", { add: [`${PREFIX}b`], ids: [`${PREFIX}b`] }],
  ])("400 invalid_body for %s, and nothing changes", async (_label, body) => {
    const orgId = await newOrg();
    const perm = await newPermissions("a", "b");
    const roleId = await newRole(orgId, "role", [perm.a!]);

    const res = await permissionsRoute.PATCH(
      patch(`roles/${roleId}/permissions`, body),
      ctx(roleId),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(await roleKeys(roleId)).toEqual(["a"]);
  });
});

describe("PATCH /groups/[id]/roles (DB-backed, F-38)", () => {
  it("applies both sides in one request and audits the delta Postgres reports", async () => {
    const orgId = await newOrg();
    const [r1, r2, r3, r4] = [
      await newRole(orgId, "r1"),
      await newRole(orgId, "r2"),
      await newRole(orgId, "r3"),
      await newRole(orgId, "r4"),
    ];
    const groupId = await newGroup(orgId, [r1!, r3!]);

    const res = await groupRolesRoute.PATCH(
      // `r3` is already bundled, `r4` never was: neither is part of the delta.
      patch(`groups/${groupId}/roles`, { add: [r2, r3, r2], remove: [r1, r4] }),
      ctx(groupId),
    );

    expect(res.status).toBe(200);
    expect(await groupRoleIds(groupId)).toEqual([r2!, r3!].sort());
    expect(((await res.json()) as { roleIds: string[] }).roleIds.sort()).toEqual([r2!, r3!].sort());
    expect(successMetadata(auditOrgMock, "admin.group.roles_changed")).toEqual({
      groupId,
      key: expect.stringContaining(`${PREFIX}grp`),
      added: [r2],
      removed: [r1],
    });
  });

  it("a refused removal (REVOKE-1) bundles nothing: the group is unchanged", async () => {
    const orgId = await newOrg();
    const perm = await newPermissions("held", "lacked");
    const lackedRole = await newRole(orgId, "lacked-role", [perm.lacked!]);
    const heldRole = await newRole(orgId, "held-role", [perm.held!]);
    const groupId = await newGroup(orgId, [lackedRole]);
    accessGetter.mockResolvedValue(orgAdmin(orgId, [`${PREFIX}held`]));

    const res = await groupRolesRoute.PATCH(
      patch(`groups/${groupId}/roles`, { add: [heldRole], remove: [lackedRole] }),
      ctx(groupId),
    );

    expect(res.status).toBe(403);
    expect(await groupRoleIds(groupId)).toEqual([lackedRole]);
    expect(refusalAction()).toBe("group_roles_remove");
    expect(auditOrgMock).not.toHaveBeenCalled();
  });

  it("a role to add from another organization is 404 role_not_found, and nothing is removed", async () => {
    const orgId = await newOrg();
    const otherOrgId = await newOrg();
    const bundled = await newRole(orgId, "bundled");
    const foreign = await newRole(otherOrgId, "foreign");
    const groupId = await newGroup(orgId, [bundled]);

    const res = await groupRolesRoute.PATCH(
      patch(`groups/${groupId}/roles`, { add: [foreign], remove: [bundled] }),
      ctx(groupId),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "role_not_found" });
    expect(await groupRoleIds(groupId)).toEqual([bundled]);
  });
});
