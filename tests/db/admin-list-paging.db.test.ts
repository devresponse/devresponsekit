import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

/**
 * DB-BACKED test for F-41's server side: every OFFSET list orders by a unique
 * tiebreaker, and the roles search reaches a role by its org's name.
 *
 * Each admin list page is its own `LIMIT … OFFSET` query, and Postgres returns
 * rows that tie on the sort in no particular order, so a client paging a list
 * (the pickers' catalogs, `fetchAllPages`) could see a row twice and another
 * never. `applySortAndPagination` now appends `id` (or a list's own unique
 * key) after the requested sort. This drives the REAL handlers against real
 * Postgres and asserts:
 *   1. rows that tie on the sort come back in tiebreaker order, and walking the
 *      pages yields each row exactly once — for the roles default sort (`key`,
 *      which ties across every org holding an `admin` role), a groups sort on
 *      a shared name, and both membership lists, whose tiebreaker is their own
 *      key because their rows carry no `id`;
 *   2. every admin list endpoint still answers 200 with the tiebreaker in its
 *      ORDER BY. The tiebreaker is referenced by output-column name, so a list
 *      whose SELECT had no `id` column, or two, would fail here as a 500;
 *   3. `GET /roles?q=` (the superadmin role picker's search) and the roles CSV
 *      export match the owning org's name, so one org's `admin` role can be
 *      found among every org's;
 *   4. `GET /groups?q=` matches the owning org's name too, and a repeated
 *      `filter[organization]` (the user-detail group picker's scope: the
 *      target user's orgs) lists exactly those orgs' groups.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_tie_`
 * and self-clean. Only auth is mocked; `@/db/database` is the real pool.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
// The export budget is 3 per actor per minute; reruns must not trip it.
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

const { db, pgPool } = await import("@/db/database");

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** Every admin list handler that pages through `applySortAndPagination` (or its api-keys twin). */
const ROUTES: Record<string, Handler> = {
  audit: (await import("@/app/api/administrator/audit/route")).GET as Handler,
  "email/outbox": (await import("@/app/api/administrator/email/outbox/route")).GET as Handler,
  "enterprise-apps": (await import("@/app/api/administrator/enterprise-apps/route")).GET as Handler,
  groups: (await import("@/app/api/administrator/groups/route")).GET as Handler,
  "groups/[id]/members": (await import("@/app/api/administrator/groups/[id]/members/route"))
    .GET as Handler,
  memberships: (await import("@/app/api/administrator/memberships/route")).GET as Handler,
  organizations: (await import("@/app/api/administrator/organizations/route")).GET as Handler,
  "organizations/[id]/invitations": (
    await import("@/app/api/administrator/organizations/[id]/invitations/route")
  ).GET as Handler,
  "organizations/[id]/members": (
    await import("@/app/api/administrator/organizations/[id]/members/route")
  ).GET as Handler,
  "organizations/[id]/provider-bindings": (
    await import("@/app/api/administrator/organizations/[id]/provider-bindings/route")
  ).GET as Handler,
  permissions: (await import("@/app/api/administrator/permissions/route")).GET as Handler,
  roles: (await import("@/app/api/administrator/roles/route")).GET as Handler,
  "roles/[id]/members": (await import("@/app/api/administrator/roles/[id]/members/route"))
    .GET as Handler,
  users: (await import("@/app/api/administrator/users/route")).GET as Handler,
  "users/[id]/audit": (await import("@/app/api/administrator/users/[id]/audit/route"))
    .GET as Handler,
  "users/[id]/memberships": (await import("@/app/api/administrator/users/[id]/memberships/route"))
    .GET as Handler,
  "users/[id]/roles": (await import("@/app/api/administrator/users/[id]/roles/route"))
    .GET as Handler,
  "api-keys": (await import("@/app/api/administrator/api-keys/route")).GET as Handler,
};

const PREFIX = "__dbtest_tie_";

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["superuser"],
};

function listReq(path: string, qs = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}?${qs}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
}

async function get(path: string, qs = "", id = "") {
  const route = ROUTES[path];
  if (!route) throw new Error(`no handler for ${path}`);
  const res = await route(listReq(path.replace("[id]", id), qs), {
    params: Promise.resolve({ id }),
  });
  return res;
}

/** Walks `path` page by page (size `pageSize`) and returns every row in order. */
async function walk<T>(path: string, qs: string, pageSize: number, id = ""): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await get(path, `${qs}&pageSize=${pageSize}&page=${page}`, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: T[]; total: number };
    rows.push(...body.items);
    if (rows.length >= body.total || body.items.length === 0) break;
  }
  return rows;
}

async function cleanup(): Promise<void> {
  const groupIds = db.selectFrom("app_groups").select("id").where("key", "like", `${PREFIX}%`);
  const roleIds = db.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`);
  const orgIds = db
    .selectFrom("app_organizations")
    .select("id")
    .where("slug", "like", `${PREFIX}%`);
  await db.deleteFrom("app_group_memberships").where("group_id", "in", groupIds).execute();
  await db.deleteFrom("app_group_roles").where("group_id", "in", groupIds).execute();
  await db.deleteFrom("app_user_roles").where("role_id", "in", roleIds).execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("organization_id", "in", orgIds)
    .execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function insertOrg(slug: string, name = `DBTest ${slug}`): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertUser(suffix: string, displayName: string | null = null): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${suffix}`,
      primary_email: `${PREFIX}${suffix}@dbtest.local`,
      display_name: displayName,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertRole(orgId: string | null, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertGroup(orgId: string, key: string, name: string): Promise<string> {
  const row = await db
    .insertInto("app_groups")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** `ids` in ascending order, as Postgres orders uuids (lowercase hex, bytewise). */
function ascending(ids: string[]): string[] {
  return [...ids].sort();
}

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockResolvedValue({ user: { id: "dbtest-ba" } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("OFFSET lists order ties by a unique tiebreaker (DB-backed, F-41)", () => {
  it("roles: one key in six orgs pages out in id order, each role once", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await insertRole(await insertOrg(`o${i}`), "admin"));

    // The default sort (`key`) ties on every row: the finding's "every org
    // has an `admin` role" case.
    const rows = await walk<{ id: string }>("roles", `q=${PREFIX}admin`, 2);
    expect(rows.map((r) => r.id)).toEqual(ascending(ids));
  });

  it("groups: a shared name sorts by id within the tie", async () => {
    const orgId = await insertOrg("g");
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await insertGroup(orgId, `g${i}`, `${PREFIX}same`));

    const rows = await walk<{ id: string }>("groups", `q=${PREFIX}same&sort=name.asc`, 4);
    expect(rows.map((r) => r.id)).toEqual(ascending(ids));
  });

  it("role members: a user holding a global role in several orgs is ordered by (user, org)", async () => {
    const role = await insertRole(null, "global");
    const user = await insertUser("u");
    const orgs: string[] = [];
    for (let i = 1; i <= 6; i++) orgs.push(await insertOrg(`m${i}`));
    await db
      .insertInto("app_user_roles")
      .values(
        orgs.map((organization_id) => ({ app_user_id: user, organization_id, role_id: role })),
      )
      .execute();

    // The default sort (`primary_email`) ties on all six rows.
    const rows = await walk<{ app_user_id: string; organization_id: string }>(
      "roles/[id]/members",
      "",
      4,
      role,
    );
    expect(rows.map((r) => r.organization_id)).toEqual(ascending(orgs));
    expect(new Set(rows.map((r) => r.app_user_id))).toEqual(new Set([user]));
  });

  it("group members: a shared display name is ordered by user id", async () => {
    const orgId = await insertOrg("gm");
    const group = await insertGroup(orgId, "gm", "Group members");
    const users: string[] = [];
    for (let i = 1; i <= 6; i++) users.push(await insertUser(`gm${i}`, "Same Name"));
    await db
      .insertInto("app_group_memberships")
      .values(users.map((app_user_id) => ({ group_id: group, app_user_id })))
      .execute();

    const rows = await walk<{ app_user_id: string }>(
      "groups/[id]/members",
      "sort=display_name.asc",
      4,
      group,
    );
    expect(rows.map((r) => r.app_user_id)).toEqual(ascending(users));
  });
});

describe("every admin list answers with the tiebreaker in its ORDER BY (DB-backed, F-41)", () => {
  // Every handler in ROUTES is covered: these ten plus the seven below.
  const COLLECTIONS = [
    "audit",
    "email/outbox",
    "enterprise-apps",
    "groups",
    "memberships",
    "organizations",
    "permissions",
    "roles",
    "users",
    "api-keys",
  ];
  const PER_ORG = ["organizations/[id]/invitations", "organizations/[id]/members"];
  const PER_ORG_BINDINGS = "organizations/[id]/provider-bindings";
  const PER_USER = ["users/[id]/audit", "users/[id]/memberships", "users/[id]/roles"];

  it.each(COLLECTIONS)("%s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
  });

  it("the per-org, per-user, per-group and per-role lists", async () => {
    const orgId = await insertOrg("each");
    const user = await insertUser("each");
    const role = await insertRole(orgId, "each");
    const group = await insertGroup(orgId, "each", "Each");
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: orgId, app_user_id: user, status: "active" })
      .execute();
    await db
      .insertInto("app_user_roles")
      .values({ app_user_id: user, organization_id: orgId, role_id: role })
      .execute();
    await db
      .insertInto("app_group_memberships")
      .values({ group_id: group, app_user_id: user })
      .execute();

    const cases: Array<[string, string]> = [
      ...PER_ORG.map((p): [string, string] => [p, orgId]),
      [PER_ORG_BINDINGS, orgId],
      ...PER_USER.map((p): [string, string] => [p, user]),
      ["groups/[id]/members", group],
      ["roles/[id]/members", role],
    ];
    for (const [path, id] of cases) {
      const res = await get(path, "", id);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      const body = (await res.json()) as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
    }
  });
});

describe("the roles search matches the owning org's name (DB-backed, F-41)", () => {
  const exportGET = async (qs: string) => {
    const { GET } = await import("@/app/api/administrator/export/[resource]/route");
    const url = new URL(`http://test.local/api/administrator/export/roles?${qs}`);
    const request = {
      nextUrl: url,
      url: url.toString(),
      headers: new Headers(),
      method: "GET",
    } as unknown as NextRequest;
    return GET(request, { params: Promise.resolve({ resource: "roles" }) });
  };

  it("list and CSV export find one org's `admin` role by the org's name", async () => {
    const zenith = await insertRole(await insertOrg("zen", "Zenith Corp (dbtest)"), "admin");
    const other = await insertRole(await insertOrg("oth", "Other Corp (dbtest)"), "admin");

    const res = await get("roles", `q=${encodeURIComponent("Zenith Corp (dbtest)")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((r) => r.id)).toEqual([zenith]);
    expect(body.total).toBe(1);

    const csv = await exportGET(`q=${encodeURIComponent("Zenith Corp (dbtest)")}`);
    const text = await csv.text();
    expect(csv.status, text.slice(0, 300)).toBe(200);
    expect(text).toContain(zenith);
    expect(text).not.toContain(other);
  });
});

describe("the groups list finds a group by its org (DB-backed, F-41)", () => {
  it("`q` matches the owning org's name, so one org's `engineering` is found among every org's", async () => {
    const zenith = await insertGroup(
      await insertOrg("gzen", "Zenith Groups (dbtest)"),
      "engineering",
      "Engineering",
    );
    await insertGroup(
      await insertOrg("goth", "Other Groups (dbtest)"),
      "engineering",
      "Engineering",
    );

    const res = await get("groups", `q=${encodeURIComponent("Zenith Groups (dbtest)")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((g) => g.id)).toEqual([zenith]);
    expect(body.total).toBe(1);
  });

  it("a repeated `filter[organization]` lists the groups of every named org and no other", async () => {
    // The user-detail group picker asks for the groups of the target user's
    // orgs this way. A repeated value used to be ignored, listing every org's.
    const orgA = await insertOrg("fa");
    const orgB = await insertOrg("fb");
    const inA = await insertGroup(orgA, "fa", "Engineering");
    const inB = await insertGroup(orgB, "fb", "Engineering");
    await insertGroup(await insertOrg("fc"), "fc", "Engineering");

    const qs = new URLSearchParams([
      ["filter[organization]", orgA],
      ["filter[organization]", orgB],
    ]);
    const res = await get("groups", qs.toString());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((g) => g.id).sort()).toEqual([inA, inB].sort());
    expect(body.total).toBe(2);
  });
});
