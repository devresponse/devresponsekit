import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as AuthAdminModule from "@/lib/admin/auth-admin.server";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

/**
 * DB-BACKED test for F-32: an administrator's audit rows name the tenant the
 * action happened in, so that tenant's own auditors can read them and no other
 * tenant's can.
 *
 * Every tenant-facing audit read filters on `organization_id`: the explorer,
 * a user's Audit tab, the CSV export and `GET /api/v1/audit-events` show an org
 * admin only rows stamped with their org. About seventy admin writes stamped
 * none, so a delegated admin's password sets, key revocations, app edits and
 * exports were visible to platform superadmins only. Here the routes, the
 * audit writer and every read path are real, against Postgres; only the caller
 * (a cookie session and its access context) and the rate limiter are stubbed.
 *
 *   1. An org-A delegated admin edits a member who also belongs to org B,
 *      assigns them an org-A role, edits and revokes org-A resources (an
 *      enterprise app, an API key) and exports the users. Every row is stamped
 *      org A: the acting org for the user actions, the resource's org for the
 *      rest.
 *   2. Org A's admin sees all of it in the explorer, on the member's Audit tab,
 *      in `/api/v1/audit-events` and in the audit CSV. Org B's admin, who can
 *      open the same member's Audit tab, sees none of it anywhere.
 *   3. A superadmin whose active org is A edits a user: a platform row (null),
 *      NOT org A. Its active-org cookie says nothing about the target's tenant.
 *   4. A superadmin enrolling a user in org A writes the user-level membership
 *      row stamped org A, so it reaches that user's Audit tab for org A's admin.
 *   5. A superadmin request spanning a member's org-A AND org-B memberships
 *      (PATCH, then DELETE) writes its one user-level row as a platform row
 *      (`soleOrganizationId`), each org's own rows under that org, and nothing
 *      org A can read names org B's membership, role or org (or the reverse).
 *   6. An impersonation stop is filed under the org of the start row it ends:
 *      the real start, found among newer and older decoy rows that each differ
 *      from it in one column the lookup filters or orders on.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f32_`
 * (the enterprise app id `dbtest-f32-…`, since app ids must start with a
 * letter or digit) and clean up after themselves; audit rows are append-only
 * and go through the sanctioned retention GUC.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", async () => {
  // The real (pure) marker reader, so the impersonation stop reads
  // `impersonatedBy` off the stubbed session exactly as it would in production.
  const { readImpersonatorId } = await import("@/lib/impersonation");
  return {
    getCurrentSession: () => sessionGetter(),
    getImpersonatorId: (session: unknown) => readImpersonatorId(session),
  };
});
// Better Auth's cookie swap is not what this file tests; the audit writes and
// the start-row lookup around it are.
vi.mock("@/lib/admin/auth-admin.server", async () => {
  const actual = await vi.importActual<typeof AuthAdminModule>("@/lib/admin/auth-admin.server");
  return {
    ...actual,
    impersonateBetterAuthUser: async () => ({ ok: true }),
    stopBetterAuthImpersonating: async () => ({ ok: true }),
  };
});
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
// Several mutations and an export per actor inside a minute; the budgets are
// not what this file tests.
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

const { db, pgPool } = await import("@/db/database");
const userRoute = await import("@/app/api/administrator/users/[id]/route");
const appRolesRoute = await import("@/app/api/administrator/users/[id]/app-roles/route");
const membershipsRoute = await import("@/app/api/administrator/users/[id]/memberships/route");
const userAuditRoute = await import("@/app/api/administrator/users/[id]/audit/route");
const auditRoute = await import("@/app/api/administrator/audit/route");
const appRoute = await import("@/app/api/administrator/enterprise-apps/[id]/route");
const apiKeyRoute = await import("@/app/api/administrator/api-keys/[id]/route");
const exportRoute = await import("@/app/api/administrator/export/[resource]/route");
const v1AuditRoute = await import("@/app/api/v1/audit-events/route");
const impersonateRoute = await import("@/app/api/administrator/users/[id]/impersonate/route");

const PREFIX = "__dbtest_f32_";
const RUN = randomUUID().slice(0, 8);
const APP_ID = `dbtest-f32-${RUN}`;

/** Better Auth ids (plain text, no FK) — also how cleanup finds the audit rows. */
const BA = {
  adminA: `${PREFIX}ba_admin_a_${RUN}`,
  adminB: `${PREFIX}ba_admin_b_${RUN}`,
  superadmin: `${PREFIX}ba_super_${RUN}`,
  member: `${PREFIX}ba_member_${RUN}`,
  newcomer: `${PREFIX}ba_newcomer_${RUN}`,
  /** In org A and org B, with a role in each; a superadmin removes both. */
  leaver: `${PREFIX}ba_leaver_${RUN}`,
  /** An org-A admin who impersonates, and an unrelated one (decoy rows only). */
  impersonator: `${PREFIX}ba_imp_${RUN}`,
  otherImpersonator: `${PREFIX}ba_imp_other_${RUN}`,
  impTarget: `${PREFIX}ba_imp_target_${RUN}`,
  impOther: `${PREFIX}ba_imp_other_target_${RUN}`,
} as const;
type Actor = "adminA" | "adminB" | "superadmin" | "impersonator";

const ORG_ADMIN_PERMISSIONS = [
  "admin.users.read",
  "admin.users.update",
  "admin.roles.assign",
  "admin.apps.manage",
  "admin.apikeys.manage",
  "admin.audit.read",
];

const ids = {
  orgA: "",
  orgB: "",
  adminA: "",
  adminB: "",
  superadmin: "",
  member: "",
  newcomer: "",
  leaver: "",
  impersonator: "",
  impTarget: "",
  impOther: "",
  role: "",
  roleB: "",
  apiKey: "",
};
const contexts = new Map<string, AuthStatusModule.UserAccessContext>();

function as(actor: Actor): void {
  sessionGetter.mockResolvedValue({
    user: { id: BA[actor] },
    session: { id: `${PREFIX}s_${actor}` },
  });
}

function request(method: string, path: string, body?: unknown): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as NextRequest;
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

interface AuditRow {
  event_type: string;
  organization_id: string | null;
  app_user_id: string | null;
  actor_better_auth_user_id: string | null;
  metadata?: unknown;
}

/** This run's rows written by `actor`, oldest first. */
async function rowsBy(actorBa: string, eventType?: string): Promise<AuditRow[]> {
  let query = db
    .selectFrom("app_audit_events")
    .select([
      "event_type",
      "organization_id",
      "app_user_id",
      "actor_better_auth_user_id",
      "metadata",
    ])
    .where("actor_better_auth_user_id", "=", actorBa);
  if (eventType) query = query.where("event_type", "=", eventType);
  return query.orderBy("created_at").execute();
}

/**
 * The export's completion audit runs in the stream's `finally`, after the body
 * is closed, so a reader can finish before the row lands. Poll for it.
 */
async function waitForRow(actorBa: string, eventType: string): Promise<AuditRow[]> {
  for (let i = 0; i < 80; i += 1) {
    const rows = await rowsBy(actorBa, eventType);
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return rowsBy(actorBa, eventType);
}

async function listItems(res: Response): Promise<AuditRow[]> {
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { items: AuditRow[] }).items;
}

async function explorer(reader: Actor, filters: Record<string, string>): Promise<AuditRow[]> {
  as(reader);
  const qs = new URLSearchParams({ pageSize: "200" });
  for (const [k, v] of Object.entries(filters)) qs.set(`filter[${k}]`, v);
  return listItems(await auditRoute.GET(request("GET", `/api/administrator/audit?${qs}`)));
}

async function userAuditTab(reader: Actor, appUserId: string): Promise<AuditRow[]> {
  as(reader);
  return listItems(
    await userAuditRoute.GET(
      request("GET", `/api/administrator/users/${appUserId}/audit?pageSize=200`),
      params({ id: appUserId }),
    ),
  );
}

async function v1AuditEvents(reader: Actor): Promise<AuditRow[]> {
  as(reader);
  return listItems(await v1AuditRoute.GET(request("GET", "/api/v1/audit-events?pageSize=200")));
}

/** The audit CSV for one actor's rows, as the reader: its `event_type` column. */
async function auditCsvEventTypes(reader: Actor, actorBa: string): Promise<string[]> {
  as(reader);
  const res = await exportRoute.GET(
    request("GET", `/api/administrator/export/audit?filter[actor]=${encodeURIComponent(actorBa)}`),
    params({ resource: "audit" }),
  );
  expect(res.status).toBe(200);
  const lines = (await res.text()).trim().split("\n");
  const header = lines[0]!.split(",");
  const col = header.indexOf("event_type");
  expect(col).toBeGreaterThanOrEqual(0);
  return lines
    .slice(1)
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.split(",")[col]!);
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  const users = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  await db.deleteFrom("app_api_keys").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_user_roles").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", "dbtest-f32-%").execute();
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(tag: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${tag}_${RUN}`, name: `F-32 ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(ba: string, orgIds: string[]): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: ba, primary_email: `${ba}@dbtest.local`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const organizationId of orgIds) {
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: organizationId, app_user_id: row.id, status: "active" })
      .execute();
  }
  return row.id;
}

function context(
  ba: string,
  appUserId: string,
  organizationId: string,
  permissions: string[],
): AuthStatusModule.UserAccessContext {
  return {
    appUserId,
    primaryEmail: `${ba}@dbtest.local`,
    status: "active",
    organizationId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions,
  };
}

beforeAll(async () => {
  await cleanup();
  ids.orgA = await newOrg("org_a");
  ids.orgB = await newOrg("org_b");
  ids.adminA = await newUser(BA.adminA, [ids.orgA]);
  ids.adminB = await newUser(BA.adminB, [ids.orgB]);
  ids.superadmin = await newUser(BA.superadmin, [ids.orgA]);
  // Shared by both tenants: org B's admin can open this member's Audit tab.
  ids.member = await newUser(BA.member, [ids.orgA, ids.orgB]);
  ids.newcomer = await newUser(BA.newcomer, []);
  ids.leaver = await newUser(BA.leaver, [ids.orgA, ids.orgB]);
  ids.impersonator = await newUser(BA.impersonator, [ids.orgA]);
  ids.impTarget = await newUser(BA.impTarget, [ids.orgA]);
  ids.impOther = await newUser(BA.impOther, [ids.orgA]);

  // A role confers nothing, so the AUTHZ-3 conferral test passes for org A's admin.
  ids.role = (
    await db
      .insertInto("app_roles")
      .values({ organization_id: ids.orgA, key: `${PREFIX}role_${RUN}`, name: "F-32 role" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.roleB = (
    await db
      .insertInto("app_roles")
      .values({ organization_id: ids.orgB, key: `${PREFIX}role_b_${RUN}`, name: "F-32 role B" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  // The leaver's grants in each org, which leave with each membership (F-12).
  await db
    .insertInto("app_user_roles")
    .values([
      { app_user_id: ids.leaver, organization_id: ids.orgA, role_id: ids.role },
      { app_user_id: ids.leaver, organization_id: ids.orgB, role_id: ids.roleB },
    ])
    .execute();
  ids.apiKey = (
    await db
      .insertInto("app_api_keys")
      .values({
        app_user_id: ids.member,
        organization_id: ids.orgA,
        name: `${PREFIX}key`,
        key_prefix: `f32${RUN}`,
        key_hash: `${PREFIX}hash_${RUN}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("app_enterprise_applications")
    .values({
      id: APP_ID,
      organization_id: ids.orgA,
      label: "F-32 app",
      origin: "https://f32.dbtest.local",
      subdomain: `f32${RUN}`,
      sso_audience: `${PREFIX}aud_${RUN}`,
    })
    .execute();

  contexts.set(BA.adminA, context(BA.adminA, ids.adminA, ids.orgA, ORG_ADMIN_PERMISSIONS));
  contexts.set(BA.adminB, context(BA.adminB, ids.adminB, ids.orgB, ORG_ADMIN_PERMISSIONS));
  // A cookie superadmin whose ACTIVE org is A.
  contexts.set(
    BA.superadmin,
    context(BA.superadmin, ids.superadmin, ids.orgA, ["superuser", ...ORG_ADMIN_PERMISSIONS]),
  );
  contexts.set(
    BA.impersonator,
    context(BA.impersonator, ids.impersonator, ids.orgA, ["admin.users.impersonate"]),
  );
  accessGetter.mockImplementation(async (ba: string) => {
    const found = contexts.get(ba);
    if (!found) throw new Error(`no access context stubbed for ${ba}`);
    return found;
  });
});

beforeEach(() => {
  sessionGetter.mockReset();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-32: a delegated admin's actions are stamped with their org", () => {
  it("stamps the acting org on user actions and the resource's org on key, app and export events", async () => {
    as("adminA");
    const updated = await userRoute.PATCH(
      request("PATCH", `/api/administrator/users/${ids.member}`, { preferredLocale: "fr" }),
      params({ id: ids.member }),
    );
    expect(updated.status, await updated.clone().text()).toBe(200);

    const assigned = await appRolesRoute.POST(
      request("POST", `/api/administrator/users/${ids.member}/app-roles`, {
        roleId: ids.role,
        organizationId: ids.orgA,
      }),
      params({ id: ids.member }),
    );
    expect(assigned.status, await assigned.clone().text()).toBe(201);

    // Before F-32 this row was stamped only when the edit RE-HOMED the app.
    const appEdited = await appRoute.PATCH(
      request("PATCH", `/api/administrator/enterprise-apps/${APP_ID}`, { label: "F-32 app (ed)" }),
      params({ id: APP_ID }),
    );
    expect(appEdited.status, await appEdited.clone().text()).toBe(200);

    const revoked = await apiKeyRoute.DELETE(
      request("DELETE", `/api/administrator/api-keys/${ids.apiKey}`, { reason: "f32" }),
      params({ id: ids.apiKey }),
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);

    const exported = await exportRoute.GET(
      request("GET", "/api/administrator/export/users"),
      params({ resource: "users" }),
    );
    expect(exported.status).toBe(200);
    await exported.text();
    await waitForRow(BA.adminA, "admin.export.completed");

    const rows = await rowsBy(BA.adminA);
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, r]));
    expect(Object.keys(byType).sort()).toEqual([
      "admin.api_key.revoked",
      "admin.app.updated",
      "admin.export.completed",
      "admin.user.role_assigned",
      "admin.user.updated",
    ]);
    for (const row of rows) {
      expect(row.organization_id, `${row.event_type} must be stamped org A`).toBe(ids.orgA);
    }
    expect(byType["admin.user.updated"]!.app_user_id).toBe(ids.member);
    expect(byType["admin.user.role_assigned"]!.app_user_id).toBe(ids.member);
  });

  it("shows those rows to org A's auditors on every read path", async () => {
    const expected = [
      "admin.api_key.revoked",
      "admin.app.updated",
      "admin.export.completed",
      "admin.user.role_assigned",
      "admin.user.updated",
    ];
    const inExplorer = await explorer("adminA", { actor: BA.adminA });
    expect(inExplorer.map((r) => r.event_type).sort()).toEqual(expected);

    // The member's Audit tab: the events ABOUT them, including the revocation
    // of the key they own.
    const tab = (await userAuditTab("adminA", ids.member)).filter(
      (r) => r.actor_better_auth_user_id === BA.adminA,
    );
    expect(tab.map((r) => r.event_type).sort()).toEqual([
      "admin.api_key.revoked",
      "admin.user.role_assigned",
      "admin.user.updated",
    ]);

    const v1 = (await v1AuditEvents("adminA")).filter(
      (r) => r.actor_better_auth_user_id === BA.adminA,
    );
    expect(v1.map((r) => r.event_type).sort()).toEqual(expected);

    const csv = await auditCsvEventTypes("adminA", BA.adminA);
    for (const eventType of expected) expect(csv).toContain(eventType);
  });

  it("shows none of them to another org's auditors, even on a member the two orgs share", async () => {
    expect(await explorer("adminB", { actor: BA.adminA })).toEqual([]);
    expect(await explorer("adminB", { organization_id: ids.orgA })).toEqual([]);

    // Org B's admin CAN open the shared member's tab (they are a member of B)…
    const tab = await userAuditTab("adminB", ids.member);
    // …and sees nothing org A's admin did there.
    expect(tab.filter((r) => r.actor_better_auth_user_id === BA.adminA)).toEqual([]);
    expect(tab.every((r) => r.organization_id === ids.orgB)).toBe(true);

    const v1 = await v1AuditEvents("adminB");
    expect(v1.filter((r) => r.actor_better_auth_user_id === BA.adminA)).toEqual([]);

    expect(await auditCsvEventTypes("adminB", BA.adminA)).toEqual([]);
  });
});

describe("F-32: a platform actor's rows", () => {
  it("files a superadmin's edit of a user as a platform row, never under its active org", async () => {
    as("superadmin");
    const res = await userRoute.PATCH(
      request("PATCH", `/api/administrator/users/${ids.member}`, { preferredLocale: "es" }),
      params({ id: ids.member }),
    );
    expect(res.status, await res.clone().text()).toBe(200);

    const [row] = await rowsBy(BA.superadmin, "admin.user.updated");
    expect(row).toBeDefined();
    // The superadmin's active org is A, and the member IS in A, but the member
    // is in B too and nothing about the action says which tenant it was for.
    expect(row!.organization_id).toBeNull();
    expect(await explorer("adminA", { actor: BA.superadmin })).toEqual([]);
    expect(
      (await userAuditTab("adminA", ids.member)).filter(
        (r) => r.actor_better_auth_user_id === BA.superadmin,
      ),
    ).toEqual([]);
    // Platform auditors still see it.
    expect(
      (await explorer("superadmin", { actor: BA.superadmin })).map((r) => r.event_type),
    ).toContain("admin.user.updated");
  });

  it("stamps a superadmin's membership change with the membership's org", async () => {
    as("superadmin");
    const res = await membershipsRoute.POST(
      request("POST", `/api/administrator/users/${ids.newcomer}/memberships`, {
        organizationId: ids.orgA,
      }),
      params({ id: ids.newcomer }),
    );
    expect(res.status, await res.clone().text()).toBe(201);

    const [userRow] = await rowsBy(BA.superadmin, "admin.user.membership_added");
    expect(userRow).toMatchObject({ organization_id: ids.orgA, app_user_id: ids.newcomer });
    const [orgRow] = await rowsBy(BA.superadmin, "admin.organization.member_added");
    expect(orgRow).toMatchObject({ organization_id: ids.orgA, app_user_id: null });

    // The user-level row is what reaches the newcomer's Audit tab for org A.
    const tab = await userAuditTab("adminA", ids.newcomer);
    expect(tab.map((r) => r.event_type)).toEqual(["admin.user.membership_added"]);
  });
});

describe("F-32: a superadmin request spanning two orgs' memberships", () => {
  /**
   * `soleOrganizationId`: one request can name memberships in several orgs
   * only for a superadmin, and it writes ONE user-level row whose metadata
   * lists every membership, role and group id it touched. Stamped with either
   * org, that row would show it the other's ids; it is a platform row instead,
   * and each org reads its own `admin.organization.member_*` row and its own
   * F-12 `role_revoked` rows.
   */
  async function leaverMemberships(): Promise<{ a: string; b: string }> {
    const rows = await db
      .selectFrom("app_organization_memberships")
      .select(["id", "organization_id"])
      .where("app_user_id", "=", ids.leaver)
      .execute();
    const a = rows.find((r) => r.organization_id === ids.orgA)?.id;
    const b = rows.find((r) => r.organization_id === ids.orgB)?.id;
    expect(a && b, "the leaver starts with a membership in each org").toBeTruthy();
    return { a: a!, b: b! };
  }

  /** What `reader` can read of the superadmin's rows, as one searchable string. */
  async function visibleTo(reader: "adminA" | "adminB"): Promise<string> {
    return JSON.stringify(await explorer(reader, { actor: BA.superadmin }));
  }

  it("files the user-level PATCH row as a platform row and each org's twin under that org", async () => {
    const m = await leaverMemberships();
    as("superadmin");
    const res = await membershipsRoute.PATCH(
      request("PATCH", `/api/administrator/users/${ids.leaver}/memberships`, {
        membershipIds: [m.a, m.b],
        status: "suspended",
      }),
      params({ id: ids.leaver }),
    );
    expect(res.status, await res.clone().text()).toBe(200);

    const userRows = await rowsBy(BA.superadmin, "admin.user.membership_updated");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]).toMatchObject({ organization_id: null, app_user_id: ids.leaver });

    const twins = await rowsBy(BA.superadmin, "admin.organization.member_updated");
    expect(twins.map((r) => r.organization_id).sort()).toEqual([ids.orgA, ids.orgB].sort());
    for (const twin of twins) {
      expect(twin.metadata).toMatchObject({ organizationId: twin.organization_id });
    }

    // The leaver is still a (suspended) member of A, so org A's admin can open
    // their Audit tab: nothing the superadmin did there names org B.
    const tab = JSON.stringify(await userAuditTab("adminA", ids.leaver));
    expect(tab).not.toContain(m.b);
    expect(tab).not.toContain(ids.orgB);

    const seenByA = await visibleTo("adminA");
    expect(seenByA).toContain(m.a);
    expect(seenByA).not.toContain(m.b);
    const seenByB = await visibleTo("adminB");
    expect(seenByB).toContain(m.b);
    expect(seenByB).not.toContain(m.a);
  });

  it("files the user-level DELETE row as a platform row; each org keeps its own twin and revocations", async () => {
    const m = await leaverMemberships();
    as("superadmin");
    const res = await membershipsRoute.DELETE(
      request("DELETE", `/api/administrator/users/${ids.leaver}/memberships`, {
        membershipIds: [m.a, m.b],
      }),
      params({ id: ids.leaver }),
    );
    expect(res.status, await res.clone().text()).toBe(200);

    const userRows = await rowsBy(BA.superadmin, "admin.user.membership_removed");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]).toMatchObject({ organization_id: null, app_user_id: ids.leaver });
    // This is the row that names both orgs' grants at once.
    expect(userRows[0]!.metadata).toMatchObject({
      revokedRoleIds: expect.arrayContaining([ids.role, ids.roleB]),
    });

    const twins = await rowsBy(BA.superadmin, "admin.organization.members_removed");
    expect(twins.map((r) => r.organization_id).sort()).toEqual([ids.orgA, ids.orgB].sort());
    const twinIn = (org: string) => twins.find((r) => r.organization_id === org)!.metadata;
    expect(twinIn(ids.orgA)).toMatchObject({ membershipId: m.a, revokedRoleIds: [ids.role] });
    expect(twinIn(ids.orgB)).toMatchObject({ membershipId: m.b, revokedRoleIds: [ids.roleB] });

    // F-12's per-grant revocations: each under the org the assignment was in.
    const revoked = (await rowsBy(BA.superadmin, "admin.user.role_revoked")).filter(
      (r) => r.app_user_id === ids.leaver,
    );
    expect(
      revoked.map((r) => [r.organization_id, (r.metadata as { roleId: string }).roleId]).sort(),
    ).toEqual(
      [
        [ids.orgA, ids.role],
        [ids.orgB, ids.roleB],
      ].sort(),
    );

    // Neither tenant can read the other's membership, role or org id anywhere
    // in the superadmin's rows (the leaver is gone from both, so the explorer
    // is where each org's auditors would look).
    const seenByA = await visibleTo("adminA");
    expect(seenByA).toContain("admin.organization.members_removed");
    for (const foreign of [m.b, ids.roleB, ids.orgB]) expect(seenByA).not.toContain(foreign);
    const seenByB = await visibleTo("adminB");
    expect(seenByB).toContain("admin.organization.members_removed");
    for (const foreign of [m.a, ids.role, ids.orgA]) expect(seenByB).not.toContain(foreign);
  });
});

describe("F-32: an impersonation stop is filed under its start's org", () => {
  /**
   * The stop has no guard to resolve a scope from, so it reuses the org of
   * the latest `admin.user.impersonation_started` row THIS admin wrote for
   * THIS user. The start here is the real route's row (so the writer's event
   * type and actor column are what the lookup reads); each decoy differs from
   * it in exactly one column the lookup filters or orders on, and is filed
   * under org B, so dropping or inverting that clause files the stop under B.
   */
  it("takes the org of the start it ends, not a newer or older row", async () => {
    as("impersonator");
    const started = await impersonateRoute.POST(
      request("POST", `/api/administrator/users/${ids.impTarget}/impersonate`),
      params({ id: ids.impTarget }),
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const [start] = await rowsBy(BA.impersonator, "admin.user.impersonation_started");
    expect(start).toMatchObject({ organization_id: ids.orgA, app_user_id: ids.impTarget });

    const STARTED = "admin.user.impersonation_started";
    const decoy = (
      label: string,
      row: { actor: string; eventType: string; appUserId: string; at: "older" | "newer" },
    ) =>
      db
        .insertInto("app_audit_events")
        .values({
          event_type: row.eventType,
          outcome: "success",
          actor_better_auth_user_id: row.actor,
          app_user_id: row.appUserId,
          organization_id: ids.orgB,
          reason: `f32-decoy:${label}`,
          created_at:
            row.at === "older" ? sql`now() - interval '1 hour'` : sql`now() + interval '1 minute'`,
        })
        .execute();
    // An earlier impersonation of the same user (the order must be newest first).
    await decoy("older-start", {
      actor: BA.impersonator,
      eventType: STARTED,
      appUserId: ids.impTarget,
      at: "older",
    });
    // A newer start by the same admin of ANOTHER user (the app_user_id filter).
    await decoy("other-user", {
      actor: BA.impersonator,
      eventType: STARTED,
      appUserId: ids.impOther,
      at: "newer",
    });
    // A newer start of the same user by ANOTHER admin (the actor filter).
    await decoy("other-admin", {
      actor: BA.otherImpersonator,
      eventType: STARTED,
      appUserId: ids.impTarget,
      at: "newer",
    });
    // A newer row of another type by the same admin on the same user (the
    // event-type filter).
    await decoy("other-event", {
      actor: BA.impersonator,
      eventType: "admin.user.impersonation_failed",
      appUserId: ids.impTarget,
      at: "newer",
    });

    // The borrowed session: the target's user, marked by the impersonator.
    sessionGetter.mockResolvedValue({
      user: { id: BA.impTarget },
      session: { id: `${PREFIX}s_borrowed`, impersonatedBy: BA.impersonator },
    });
    const stopped = await impersonateRoute.DELETE(
      request("DELETE", `/api/administrator/users/${ids.impTarget}/impersonate`),
    );
    expect(stopped.status, await stopped.clone().text()).toBe(200);

    const stops = await rowsBy(BA.impersonator, "admin.user.impersonation_stopped");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ organization_id: ids.orgA, app_user_id: ids.impTarget });

    // So org A reads both ends of it on the target's Audit tab, and org B
    // reads neither.
    const tab = (await userAuditTab("adminA", ids.impTarget)).filter(
      (r) => r.actor_better_auth_user_id === BA.impersonator,
    );
    expect(tab.map((r) => r.event_type).sort()).toEqual([
      "admin.user.impersonation_started",
      "admin.user.impersonation_stopped",
    ]);
    expect(
      (await explorer("adminB", { actor: BA.impersonator })).filter(
        (r) => r.event_type === "admin.user.impersonation_stopped",
      ),
    ).toEqual([]);
  });
});
