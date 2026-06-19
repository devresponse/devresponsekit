import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for P2-17 (aggregate-column sort rework).
 *
 * The roles/organizations list endpoints compute `permission_count` /
 * `member_count` and let callers sort by them. The counts were correlated
 * scalar sub-selects; P2-17 precomputes them via `LEFT JOIN (… GROUP BY)`.
 * The unit/integration suites mock the DB, so they can't catch a malformed
 * derived-table join or a count that no longer matches the old semantics.
 * This drives the REAL handlers against real Postgres and asserts:
 *   1. the counts are exactly right (join ≡ old correlated sub-select), and
 *   2. sorting by a count column actually orders by it — fixtures are named
 *      so the count order is the REVERSE of the default key/slug order, so a
 *      pass can only come from the count sort, not insertion/default order.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean. Only auth is mocked; `@/db/database` is the real pool.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));

const { db, pgPool } = await import("@/db/database");
const { GET: rolesGET } = await import("@/app/api/administrator/roles/route");
const { GET: orgsGET } = await import("@/app/api/administrator/organizations/route");

const PREFIX = "__dbtest_listcnt_";

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.roles.read", "admin.orgs.read", "superuser"],
};

function listReq(resource: string, qs: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${resource}?${qs}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
}

async function cleanup(): Promise<void> {
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_user_roles")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("organization_id", "in", (eb) =>
      eb.selectFrom("app_organizations").select("id").where("slug", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function insertOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertUser(suffix: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${suffix}`,
      primary_email: `${PREFIX}${suffix}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertRole(orgId: string, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertPermission(key: string): Promise<string> {
  const row = await db
    .insertInto("app_permissions")
    .values({ key: `${PREFIX}${key}`, description: null })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

interface CountedRow {
  key?: string;
  slug?: string;
  permission_count?: number;
  member_count?: number;
}

describe("admin list count columns (DB-backed, P2-17)", () => {
  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "dbtest-ba" } });
    accessGetter.mockResolvedValue(SUPERADMIN);
  });

  it("roles: counts are exact and `permission_count` sort beats key order", async () => {
    const orgId = await insertOrg("o_roles");
    const [u1, u2] = [await insertUser("u1"), await insertUser("u2")];
    // `aaa` sorts FIRST by key but has the FEWER permissions/members; `zzz`
    // sorts LAST yet has more. A count-desc sort must therefore invert key order.
    const aaa = await insertRole(orgId, "aaa");
    const zzz = await insertRole(orgId, "zzz");
    const [p1, p2, p3] = [
      await insertPermission("p1"),
      await insertPermission("p2"),
      await insertPermission("p3"),
    ];
    await db
      .insertInto("app_role_permissions")
      .values([
        { role_id: aaa, permission_id: p1 },
        { role_id: zzz, permission_id: p1 },
        { role_id: zzz, permission_id: p2 },
        { role_id: zzz, permission_id: p3 },
      ])
      .execute();
    await db
      .insertInto("app_user_roles")
      .values([
        { app_user_id: u1, organization_id: orgId, role_id: zzz },
        { app_user_id: u2, organization_id: orgId, role_id: zzz },
      ])
      .execute();

    const res = await rolesGET(listReq("roles", "q=__dbtest_listcnt&sort=permission_count.desc"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: CountedRow[] };
    expect(body.items).toHaveLength(2);
    // permission_count desc → zzz(3) before aaa(1): the REVERSE of key asc.
    expect(body.items[0]).toMatchObject({
      key: `${PREFIX}zzz`,
      permission_count: 3,
      member_count: 2,
    });
    expect(body.items[1]).toMatchObject({
      key: `${PREFIX}aaa`,
      permission_count: 1,
      member_count: 0,
    });
  });

  it("roles: `member_count` sort orders by the distinct-user count", async () => {
    const orgId = await insertOrg("o_roles2");
    const [u1, u2] = [await insertUser("u1"), await insertUser("u2")];
    await insertRole(orgId, "aaa"); // exists in the list with member_count 0
    const zzz = await insertRole(orgId, "zzz");
    // zzz has 2 distinct members, aaa 0.
    await db
      .insertInto("app_user_roles")
      .values([
        { app_user_id: u1, organization_id: orgId, role_id: zzz },
        { app_user_id: u2, organization_id: orgId, role_id: zzz },
      ])
      .execute();

    const res = await rolesGET(listReq("roles", "q=__dbtest_listcnt&sort=member_count.desc"));
    const body = (await res.json()) as { items: CountedRow[] };
    expect(body.items.map((r) => r.key)).toEqual([`${PREFIX}zzz`, `${PREFIX}aaa`]);
    expect(body.items[0]?.member_count).toBe(2);
    expect(body.items[1]?.member_count).toBe(0);
  });

  it("organizations: `member_count` sort beats slug order and counts memberships", async () => {
    const aaa = await insertOrg("o_aaa");
    const zzz = await insertOrg("o_zzz");
    const [u1, u2] = [await insertUser("u1"), await insertUser("u2")];
    // aaa(1 member) sorts first by slug; zzz(2 members) sorts last.
    await db
      .insertInto("app_organization_memberships")
      .values([
        { organization_id: aaa, app_user_id: u1, status: "active" },
        { organization_id: zzz, app_user_id: u1, status: "active" },
        { organization_id: zzz, app_user_id: u2, status: "active" },
      ])
      .execute();

    const res = await orgsGET(
      listReq("organizations", "q=__dbtest_listcnt&sort=member_count.desc"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: CountedRow[] };
    expect(body.items).toHaveLength(2);
    // member_count desc → zzz(2) before aaa(1): the REVERSE of slug asc.
    expect(body.items[0]).toMatchObject({ slug: `${PREFIX}o_zzz`, member_count: 2 });
    expect(body.items[1]).toMatchObject({ slug: `${PREFIX}o_aaa`, member_count: 1 });
  });
});
