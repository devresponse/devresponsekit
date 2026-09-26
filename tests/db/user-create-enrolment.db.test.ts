import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type SqlBool } from "kysely";
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
 * F-480 adds three things only Postgres can prove:
 *   - a create-only creator is refused before ANY row exists, the Better Auth
 *     identity included;
 *   - a failed membership insert (a real foreign-key violation inside the
 *     transaction) leaves no `app_users` row behind: the rollback the fake
 *     only simulates;
 *   - a pending user a confined creator made stays pending when it signs in
 *     (a real Better Auth sign-in, which runs the `session.create` hook) in
 *     an `auto_active` org, while a sign-up membership there is activated.
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
const { auth } = await import("@/lib/auth");
const adminUsers = await import("@/app/api/administrator/users/route");
const adminUser = await import("@/app/api/administrator/users/[id]/route");
const v1Users = await import("@/app/api/v1/users/route");
const v1User = await import("@/app/api/v1/users/[id]/route");

const PREFIX = "__dbtest_enrol_";
const RUN = randomUUID().slice(0, 8);
/** Plain text (no FK) on audit rows: the handle cleanup finds them by. */
const ACTOR = `${PREFIX}admin`;
const PASSWORD = "ci-only-enrol-password-not-for-production";
/**
 * Create, read, and the membership and approval permissions a confined
 * creator's enrolment stands in for (F-480).
 */
const PERMISSIONS = [
  "admin.users.create",
  "admin.users.read",
  "admin.users.update",
  "admin.users.manage",
];

let orgId: string;
let orgSlug: string;
/** An org whose own sign-up policy is `auto_active`. */
let autoOrgId: string;

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

/** The rows a failed or refused create wrote: they name the address, never a user. */
async function auditRowsFor(eventType: string, email: string) {
  return db
    .selectFrom("app_audit_events")
    .select(["organization_id", "app_user_id", "outcome", "reason", "metadata"])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .where("event_type", "=", eventType)
    .where("email", "=", email)
    .execute();
}

async function appUsersFor(email: string) {
  return db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("primary_email", "=", email)
    .execute();
}

async function authUserCount(email: string): Promise<number> {
  const { rows } = await pgPool.query<{ n: string }>(
    `select count(*) as n from "user" where email = $1`,
    [email],
  );
  return Number(rows[0]!.n);
}

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the retention GUC is the one sanctioned path
  // that may delete them. They go first: they name the users and the org. A
  // sign-in writes rows as the signed-in user (the login, an activation), so
  // those are found by that user too.
  const pattern = `${PREFIX}%`;
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    const users = trx.selectFrom("app_users").select("id").where("primary_email", "like", pattern);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("actor_better_auth_user_id", "=", ACTOR),
          eb("app_user_id", "in", users),
          sql<SqlBool>`actor_better_auth_user_id in (select id from "user" where email like ${pattern})`,
        ]),
      )
      .execute();
  });
  const users = db.selectFrom("app_users").select("id").where("primary_email", "like", pattern);
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_users").where("primary_email", "like", pattern).execute();
  // `account` and `session` rows cascade with their user.
  await pgPool.query(`delete from "user" where email like $1`, [pattern]);
}

beforeAll(async () => {
  await cleanup();
  // The auth-settings row cascades with its org.
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  orgSlug = `${PREFIX}org_${RUN}`;
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: orgSlug, name: "DBTest enrolment" })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;
  const autoOrg = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}auto_${RUN}`, name: "DBTest enrolment auto_active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  autoOrgId = autoOrg.id;
  await db
    .insertInto("app_organization_auth_settings")
    .values({
      organization_id: autoOrgId,
      require_email_verification: true,
      signup_approval_mode: "auto_active",
    })
    .execute();
});

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR }, session: { id: `${PREFIX}session` } });
});

afterAll(async () => {
  await cleanup();
  await db.deleteFrom("app_organizations").where("id", "in", [orgId, autoOrgId]).execute();
  await pgPool.end();
});

describe.each([
  {
    surface: "POST /api/administrator/users",
    failedStatus: 500,
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
    failedStatus: 502,
    create: (email: string, initialAppStatus: string) =>
      v1Users.POST(
        request("/api/v1/users", "POST", { email, password: PASSWORD, initialAppStatus }),
      ),
    read: (id: string) =>
      v1User.GET(request(`/api/v1/users/${id}`), { params: Promise.resolve({ id }) }),
  },
])("$surface", ({ create, read, failedStatus }) => {
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

  it("F-480: a create-only org admin is refused before anything exists, identity included", async () => {
    accessGetter.mockResolvedValue(
      access({ permissions: ["admin.users.create", "admin.users.read"] }),
    );
    const email = address("create_only");
    const res = await create(email, "active");
    expect(res.status, await res.clone().text()).toBe(403);

    expect(await authUserCount(email)).toBe(0);
    expect(await appUsersFor(email)).toEqual([]);
    expect(await auditRowsFor("admin.user.create_denied", email)).toEqual([
      expect.objectContaining({
        organization_id: orgId,
        app_user_id: null,
        outcome: "denied",
        reason: "enrolment_not_permitted",
      }),
    ]);
  });

  it("F-480: a membership insert that fails inside the transaction leaves no app_users row", async () => {
    // The creator's org names no row, so the membership's foreign key fails
    // (23503) on the transaction's connection, after the `app_users` insert
    // on that same connection succeeded. Only a real rollback removes it.
    const missingOrg = randomUUID();
    accessGetter.mockResolvedValue(access({ organizationId: missingOrg }));
    const email = address("rollback");
    const res = await create(email, "pending_approval");
    expect(res.status, await res.clone().text()).toBe(failedStatus);

    expect(await appUsersFor(email)).toEqual([]);
    // The Better Auth identity is left for reconciliation, as documented.
    expect(await authUserCount(email)).toBe(1);
    const [failed] = await auditRowsFor("admin.user.create_failed", email);
    expect(failed).toMatchObject({
      app_user_id: null,
      reason: "db_insert_failed",
      // The audit's own org reference cannot resolve either; the id is kept.
      organization_id: null,
      metadata: expect.objectContaining({ unresolvedOrganizationId: missingOrg }),
    });
  });
});

describe("F-480: an admin-created pending user is not activated by the org's sign-up policy", () => {
  async function createPending(email: string): Promise<string> {
    accessGetter.mockResolvedValue(access({ organizationId: autoOrgId }));
    const res = await adminUsers.POST(
      request("/api/administrator/users", "POST", { email, password: PASSWORD }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  /** A real email/password sign-in: Better Auth runs `session.create.after`. */
  async function signIn(email: string): Promise<void> {
    await auth.api.signInEmail({ body: { email, password: PASSWORD }, headers: new Headers() });
  }

  it("stays pending at its first sign-in in an auto_active org, membership and user", async () => {
    const email = address("pending_signin");
    const id = await createPending(email);

    await signIn(email);

    expect(await appUsersFor(email)).toEqual([{ id, status: "pending_approval" }]);
    expect(await membershipsOf(id)).toEqual([
      expect.objectContaining({ organization_id: autoOrgId, status: "pending_approval" }),
    ]);
  });

  it("CONTROL: the same sign-in activates a membership a sign-up created there", async () => {
    // The same account, but its membership carries the source provisioning
    // stamps on a sign-up. The sign-in hook runs and re-decides it, so the
    // case above stays pending because of the source, not because nothing ran.
    const email = address("signup_signin");
    const id = await createPending(email);
    await db
      .updateTable("app_organization_memberships")
      .set({ source_provider: "email" })
      .where("app_user_id", "=", id)
      .execute();

    await signIn(email);

    expect(await appUsersFor(email)).toEqual([{ id, status: "active" }]);
    expect(await membershipsOf(id)).toEqual([
      expect.objectContaining({ organization_id: autoOrgId, status: "active" }),
    ]);
  });
});
