import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

/**
 * DB-BACKED test for F-63: a list query Postgres cannot run is a 400, not a
 * 500, on every admin list and CSV export.
 *
 *   1. `page` had no upper bound. `page=99999999999999999999` made the OFFSET
 *      overflow `bigint` (22003) and a longer one rendered as `2.4…e+24`
 *      (22P02), so every OFFSET list answered 500. Past `MAX_PAGE` it is now
 *      `400 invalid_query`, and `MAX_PAGE` itself is an empty page.
 *   2. The filters on a `uuid` column passed their value straight through, so
 *      `filter[app_user_id]=abc` failed the cast: 500 on the list, 502
 *      `export_failed` on the export. The groups and roles lists dropped such a
 *      value instead, listing every org's rows. Each is now a 400.
 *   3. The export read the list's keywords as ids: `filter[organization]=
 *      global` (roles) and `filter[organization_id]=null` (enterprise apps)
 *      were a 502, so the global rows the grid showed could not be exported.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f63_`
 * and self-clean. Only auth, audit and the export rate limit are mocked;
 * `@/db/database` is the real pool.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
// The export budget is 3 per actor per minute; this file exports far more.
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

const { db, pgPool } = await import("@/db/database");
const { MAX_PAGE } = await import("@/lib/admin/list-query.server");

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<{ id: string; resource: string }> },
) => Promise<Response>;

/** Every admin handler that pages with OFFSET (`offsetFor`). */
const LISTS: Record<string, Handler> = {
  audit: (await import("@/app/api/administrator/audit/route")).GET as Handler,
  "email/outbox": (await import("@/app/api/administrator/email/outbox/route")).GET as Handler,
  "enterprise-apps": (await import("@/app/api/administrator/enterprise-apps/route")).GET as Handler,
  groups: (await import("@/app/api/administrator/groups/route")).GET as Handler,
  "groups/[id]/members": (await import("@/app/api/administrator/groups/[id]/members/route"))
    .GET as Handler,
  "mcp-agents": (await import("@/app/api/administrator/mcp-agents/route")).GET as Handler,
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
const EXPORT = (await import("@/app/api/administrator/export/[resource]/route")).GET as Handler;

const PREFIX = "__dbtest_f63_";
const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["superuser"],
};

function request(path: string, qs: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}?${qs}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
}

async function list(path: string, qs: string, id = ""): Promise<Response> {
  const route = LISTS[path];
  if (!route) throw new Error(`no handler for ${path}`);
  return route(request(path.replace("[id]", id), qs), {
    params: Promise.resolve({ id, resource: "" }),
  });
}

async function exportCsv(resource: string, qs: string): Promise<Response> {
  return EXPORT(request(`export/${resource}`, qs), {
    params: Promise.resolve({ id: "", resource }),
  });
}

/** Asserts the F-63 refusal and returns its `detail`. */
async function expectInvalidQuery(res: Response, label: string): Promise<string> {
  const body = (await res.json()) as { error?: string; detail?: string };
  expect({ label, status: res.status, error: body.error }).toEqual({
    label,
    status: 400,
    error: "invalid_query",
  });
  return body.detail ?? "";
}

async function cleanup(): Promise<void> {
  const orgIds = db
    .selectFrom("app_organizations")
    .select("id")
    .where("slug", "like", `${PREFIX}%`);
  const roleIds = db.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`);
  await db.deleteFrom("app_user_roles").where("role_id", "in", roleIds).execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("organization_id", "in", orgIds)
    .execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

interface Fixture {
  orgId: string;
  userId: string;
  groupId: string;
  globalRoleId: string;
  orgRoleId: string;
  globalAppId: string;
  orgAppId: string;
}

async function seed(): Promise<Fixture> {
  const { id: orgId } = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "F-63 org" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id: userId } = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}user`,
      primary_email: `${PREFIX}user@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: userId, status: "active" })
    .execute();
  const { id: groupId } = await db
    .insertInto("app_groups")
    .values({ organization_id: orgId, key: `${PREFIX}group`, name: "F-63 group" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id: globalRoleId } = await db
    .insertInto("app_roles")
    .values({ organization_id: null, key: `${PREFIX}global`, name: "F-63 global role" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id: orgRoleId } = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}scoped`, name: "F-63 org role" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const app = (id: string, organizationId: string | null) => ({
    id: `${PREFIX}${id}`,
    organization_id: organizationId,
    label: `F-63 ${id}`,
    origin: `https://${id}.dbtest.local`,
    subdomain: `f63-${id}`,
    sso_audience: `${PREFIX}${id}`,
  });
  await db
    .insertInto("app_enterprise_applications")
    .values([app("global-app", null), app("org-app", orgId)])
    .execute();
  return {
    orgId,
    userId,
    groupId,
    globalRoleId,
    orgRoleId,
    globalAppId: `${PREFIX}global-app`,
    orgAppId: `${PREFIX}org-app`,
  };
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

/** Each list, with the fixture id its path needs. */
function listCases(f: Fixture): Array<[string, string]> {
  return Object.keys(LISTS).map((path): [string, string] => {
    if (path.startsWith("organizations/[id]")) return [path, f.orgId];
    if (path.startsWith("users/[id]")) return [path, f.userId];
    if (path === "groups/[id]/members") return [path, f.groupId];
    if (path === "roles/[id]/members") return [path, f.orgRoleId];
    return [path, ""];
  });
}

describe("`page` past MAX_PAGE is a 400 on every OFFSET list (DB-backed, F-63)", () => {
  it("each list refuses it, and still serves MAX_PAGE itself as an empty page", async () => {
    const f = await seed();
    for (const [path, id] of listCases(f)) {
      // 20 digits: an OFFSET past bigint (22003). 25 digits: `2.4…e+24` (22P02).
      for (const page of ["99999999999999999999", "1000000000000000000000000"]) {
        const detail = await expectInvalidQuery(await list(path, `page=${page}`, id), path);
        expect(detail).toBe(`\`page\` must be at most ${MAX_PAGE}.`);
      }
      const deepest = await list(path, `page=${MAX_PAGE}&pageSize=200`, id);
      expect({ path, status: deepest.status }).toEqual({ path, status: 200 });
      expect(((await deepest.json()) as { items: unknown[] }).items).toEqual([]);
    }
  });
});

describe("a malformed id in a uuid filter is a 400 on the list and the export (DB-backed, F-63)", () => {
  const LIST_FILTERS: Array<[string, string]> = [
    ["audit", "app_user_id"],
    ["audit", "organization_id"],
    ["api-keys", "app_user_id"],
    ["api-keys", "organization_id"],
    ["memberships", "organization_id"],
    ["enterprise-apps", "organization_id"],
    ["groups", "organization"],
    ["roles", "organization"],
    ["users/[id]/memberships", "organization_id"],
    ["users/[id]/roles", "organization_id"],
  ];
  const EXPORT_FILTERS: Array<[string, string]> = [
    ["audit", "app_user_id"],
    ["audit", "organization_id"],
    ["memberships", "organization_id"],
    ["enterprise-apps", "organization_id"],
    ["roles", "organization"],
  ];

  it("every list refuses it before querying, and filters on a well-formed one", async () => {
    const f = await seed();
    for (const [path, filter] of LIST_FILTERS) {
      const id = path.startsWith("users/[id]") ? f.userId : "";
      const label = `${path} filter[${filter}]`;
      const detail = await expectInvalidQuery(await list(path, `filter[${filter}]=abc`, id), label);
      expect(detail, label).toMatch(new RegExp(`^\`filter\\[${filter}\\]\` must be a UUID`));
      const ok = await list(path, `filter[${filter}]=${f.orgId}`, id);
      expect({ label, status: ok.status }).toEqual({ label, status: 200 });
    }
  });

  it("every export refuses it before the preflight, where it was a 502", async () => {
    const f = await seed();
    for (const [resource, filter] of EXPORT_FILTERS) {
      const label = `export/${resource} filter[${filter}]`;
      await expectInvalidQuery(await exportCsv(resource, `filter[${filter}]=abc`), label);
      const ok = await exportCsv(resource, `filter[${filter}]=${f.orgId}`);
      expect({ label, status: ok.status }).toEqual({ label, status: 200 });
      await ok.text();
    }
  });

  it("an empty value is no filter on the export too, where it was a 502", async () => {
    await seed();
    for (const [resource, filter] of EXPORT_FILTERS) {
      const res = await exportCsv(resource, `filter[${filter}]=`);
      const label = `export/${resource} filter[${filter}]=`;
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      await res.text();
    }
  });
});

describe("the export honours the list's global keywords (DB-backed, F-63)", () => {
  it("roles: `filter[organization]=global` lists and exports the global roles only", async () => {
    const f = await seed();
    const qs = `filter[organization]=global&q=${PREFIX}`;

    const res = await list("roles", qs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id)).toEqual([f.globalRoleId]);

    const csv = await exportCsv("roles", qs);
    const text = await csv.text();
    expect(csv.status, text.slice(0, 300)).toBe(200);
    expect(text).toContain(f.globalRoleId);
    expect(text).not.toContain(f.orgRoleId);
  });

  it("enterprise apps: `filter[organization_id]=null` lists and exports the global apps only", async () => {
    const f = await seed();
    const qs = `filter[organization_id]=null&q=${PREFIX}`;

    const res = await list("enterprise-apps", qs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((a) => a.id)).toEqual([f.globalAppId]);

    const csv = await exportCsv("enterprise-apps", qs);
    const text = await csv.text();
    expect(csv.status, text.slice(0, 300)).toBe(200);
    expect(text).toContain(f.globalAppId);
    expect(text).not.toContain(f.orgAppId);
  });
});
