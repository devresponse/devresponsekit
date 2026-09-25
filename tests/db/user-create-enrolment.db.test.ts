import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for tenant-aware user creation: a creator without cross-org
 * reach enrols the new user in the org it acts in, so its follow-up on
 * `/users/{id}` is a 200 and not the 404 `canAccessUser` gave a user with no
 * membership. The route suites run the same rule over an in-memory fake
 * (tests/integration/user-create-enrolment.test.ts); this runs the real
 * transaction, the real membership and audit foreign keys, and the real
 * `canAccessUser` query.
 *
 * Only the caller is stubbed (a cookie session whose access context is set per
 * test). Better Auth, the routes, the guards, the audit writer and Postgres are
 * real. Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use
 * `__dbtest_enrol_` and clean up after themselves.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const adminUsers = await import("@/app/api/administrator/users/route");
const adminUser = await import("@/app/api/administrator/users/[id]/route");
const v1Users = await import("@/app/api/v1/users/route");
const v1User = await import("@/app/api/v1/users/[id]/route");

const PREFIX = "__dbtest_enrol_";
const RUN = randomUUID().slice(0, 8);
/** Plain text (no FK) on audit rows: the handle cleanup finds them by. */
const ACTOR = `${PREFIX}admin`;
const PASSWORD = "ci-only-enrol-password-not-for-production";
const PERMISSIONS = ["admin.users.create", "admin.users.read"];

let orgId: string;
let orgSlug: string;

function access(
  overrides: Partial<AuthStatusModule.UserAccessContext>,
): AuthStatusModule.UserAccessContext {
  return {
    appUserId: `${PREFIX}actor`,
    primaryEmail: "actor@dbtest.local",
    status: "active",
    organizationId: orgId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: PERMISSIONS,
    ...overrides,
  };
}
const orgAdmin = () => access({});
/** A key or JWT bound to the org, owned by a superuser: still confined (MACHINE-2). */
const boundCredential = () =>
  access({ permissions: [...PERMISSIONS, "superuser"], orgBound: true });
const superadmin = () => access({ permissions: [...PERMISSIONS, "superuser"], orgBound: false });

let seq = 0;
function address(tag: string): string {
  seq += 1;
  return `${PREFIX}${tag}_${RUN}_${seq}@dbtest.local`;
}

function request(path: string, method = "GET", body?: unknown): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

async function membershipsOf(appUserId: string) {
  return db
    .selectFrom("app_organization_memberships")
    .select(["id", "organization_id", "status"])
    .where("app_user_id", "=", appUserId)
    .execute();
}

async function auditRows(eventType: string, appUserId: string) {
  return db
    .selectFrom("app_audit_events")
    .select(["organization_id", "metadata"])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .where("event_type", "=", eventType)
    .where("app_user_id", "=", appUserId)
    .execute();
}

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the retention GUC is the one sanctioned path
  // that may delete them. They go first: they name the users and the org.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  const users = db
    .selectFrom("app_users")
    .select("id")
    .where("primary_email", "like", `${PREFIX}%`);
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_users").where("primary_email", "like", `${PREFIX}%`).execute();
  // `account` and `session` rows cascade with their user.
  await pgPool.query(`delete from "user" where email like $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await cleanup();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  orgSlug = `${PREFIX}org_${RUN}`;
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: orgSlug, name: "DBTest enrolment" })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;
});

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR }, session: { id: `${PREFIX}session` } });
});

afterAll(async () => {
  await cleanup();
  await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();
  await pgPool.end();
});

describe.each([
  {
    surface: "POST /api/administrator/users",
    create: (email: string, initialAppStatus: string) =>
      adminUsers.POST(
        request("/api/administrator/users", "POST", {
          email,
          password: PASSWORD,
          initialAppStatus,
        }),
      ),
    read: (id: string) =>
      adminUser.GET(request(`/api/administrator/users/${id}`), {
        params: Promise.resolve({ id }),
      }),
  },
  {
    surface: "POST /api/v1/users",
    create: (email: string, initialAppStatus: string) =>
      v1Users.POST(
        request("/api/v1/users", "POST", { email, password: PASSWORD, initialAppStatus }),
      ),
    read: (id: string) =>
      v1User.GET(request(`/api/v1/users/${id}`), { params: Promise.resolve({ id }) }),
  },
])("$surface", ({ create, read }) => {
  it.each([
    ["an org admin", orgAdmin, "pending_approval"],
    ["an org-bound credential", boundCredential, "active"],
  ] as const)(
    "%s enrols the user in its org, and reads it back with a 200",
    async (_label, caller, initialAppStatus) => {
      accessGetter.mockResolvedValue(caller());
      const res = await create(address("confined"), initialAppStatus);
      expect(res.status, await res.clone().text()).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const memberships = await membershipsOf(id);
      expect(memberships).toEqual([
        expect.objectContaining({ organization_id: orgId, status: initialAppStatus }),
      ]);
      const [userRow] = await auditRows("admin.user.membership_added", id);
      expect(userRow).toMatchObject({
        organization_id: orgId,
        metadata: expect.objectContaining({ slug: orgSlug, membershipId: memberships[0]!.id }),
      });

      expect((await read(id)).status).toBe(200);
    },
  );

  it("a superadmin's session enrols nobody, so a confined caller gets 404 for that user", async () => {
    accessGetter.mockResolvedValue(superadmin());
    const res = await create(address("superadmin"), "pending_approval");
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await membershipsOf(id)).toEqual([]);

    accessGetter.mockResolvedValue(orgAdmin());
    expect((await read(id)).status).toBe(404);
  });
});
