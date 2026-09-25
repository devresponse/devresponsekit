import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED tests for F-40: the default organization has ONE identity,
 * `app_organizations.is_default`.
 *
 * Before F-40 sign-up routing, the sign-up policy lookup and the seed found
 * the default org by the slug `default`, while the delete guard and the admin
 * UI used `is_default`. Renaming the default org's slug (a normal Settings
 * save) made the next unmapped sign-up auto-create a second, adminless
 * "Default Organization" under the platform policy; ticking "Set as default
 * organization" on another org routed nothing there; a `db:seed` re-run after
 * the rename inserted a second `is_default` row and wired the admin into it;
 * and two concurrent default moves could leave two defaults.
 *
 * Everything here runs UNMOCKED against real Postgres — the admin routes, the
 * sign-up policy resolver, provisioning (with its real audit writes), the
 * seed step and the flag-moving helper — with only the caller's session
 * stubbed:
 *
 *   1. A RENAMED default org keeps receiving unmapped sign-ups (email and
 *      social), under ITS OWN policy, and no organization is created — even
 *      with another org still holding the slug `default`.
 *   2. Moving the flag (PATCH, and POST of a new org) moves routing and leaves
 *      exactly one default; clearing it on the current default is refused.
 *   3. A seed re-run after the rename (slug `default` free again) reuses the
 *      flagged org and creates no second default; one after the default was
 *      MOVED to a tenant writes no platform role or admin grant into it.
 *   4. Two concurrent moves leave exactly one default; a DELETE racing a move
 *      onto the same org cannot remove the new default; a save that touches
 *      the flag cannot deadlock against a move.
 *   5. A legacy EXTRA flag can be cleared (`isDefault: false`); the flag on
 *      the org sign-ups resolve to cannot.
 *
 * The flag is platform-global, so the suite snapshots the default org(s)
 * (flag and `updated_at`) up front and restores them in `afterAll`. Fixtures
 * use a `__dbtest_f40_` prefix (users, audit actor) or `dbtest-f40-` (org
 * slugs, which the API's slug rule constrains) and self-clean. The real
 * `default`-slug org is never renamed outside a rolled-back transaction.
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const { PATCH, DELETE } = await import("@/app/api/administrator/organizations/[id]/route");
const { POST } = await import("@/app/api/administrator/organizations/route");
const { provisionUserFromAuth } = await import("@/lib/user-provisioning.server");
const { resolveSignupPolicy } = await import("@/lib/auth-policy.server");
const { getDefaultOrganization, lockDefaultOrganizationFlag, moveDefaultOrganizationFlag } =
  await import("@/lib/default-organization.server");
const { ensureDefaultOrganization, resolveSeedPlatformOrganization } =
  await import("@/db/seeds/default-organization");
const { seedBaselineRoles } = await import("@/db/seeds/baseline-roles");
const { seedDefaultAdminUser } = await import("@/db/seeds/default-admin");

const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `__dbtest_f40_${RUN}_`;
/** Org slugs go through the API's slug rule (lowercase, digits, hyphens). */
const ORG_PREFIX = `dbtest-f40-${RUN}-`;
/** Plain-text actor id (no FK): also the handle cleanup finds audit rows by. */
const ACTOR = `${PREFIX}admin`;
const EMAIL_DOMAIN = `f40-${RUN}.dbtest`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-f40-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.orgs.create", "admin.orgs.update", "admin.orgs.delete", "superuser"],
};

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator/organizations${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

async function patchOrg(id: string, body: unknown): Promise<Response> {
  return PATCH(jsonReq(`/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
}

async function deleteOrg(id: string): Promise<Response> {
  return DELETE(jsonReq(`/${id}`, "DELETE", undefined), { params: Promise.resolve({ id }) });
}

/**
 * Resolves once another backend is waiting on a lock: the point a racing
 * request has reached its blocking statement. Polled, not slept, so the
 * interleaving the race tests need is the one that actually ran.
 */
async function lockWaiterAppears(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pgPool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no backend started waiting on a lock within 5s");
}

/** An active org holding one active superuser grant (a fixture user's). */
async function orgWithSuperuserGrant(tag: string): Promise<string> {
  const orgId = await newOrg(tag);
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: "superuser", name: "Superuser" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const marker = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", "superuser")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: marker.id })
    .execute();
  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${tag}`,
      primary_email: `${tag}@${EMAIL_DOMAIN}`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: user.id, status: "active" })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: user.id, organization_id: orgId, role_id: role.id })
    .execute();
  return orgId;
}

async function newOrg(tag: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${ORG_PREFIX}${tag}`, name: `DBTest F-40 ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function defaultIds(): Promise<string[]> {
  const rows = await db
    .selectFrom("app_organizations")
    .select("id")
    .where("is_default", "=", true)
    .orderBy("id")
    .execute();
  return rows.map((r) => r.id);
}

async function orgCount(where?: { slug: string }): Promise<number> {
  let q = db.selectFrom("app_organizations").select(sql<string>`count(*)`.as("n"));
  if (where) q = q.where("slug", "=", where.slug);
  return Number((await q.executeTakeFirstOrThrow()).n);
}

/** A brand-new unmapped sign-up (no invitation, hint or domain binding). */
async function signUp(tag: string, provider: "email" | "google") {
  return provisionUserFromAuth({
    betterAuthUserId: `${PREFIX}${tag}`,
    email: `${tag}@${EMAIL_DOMAIN}`,
    emailVerified: true,
    provider,
  });
}

/** `updated_at` as TEXT: a JS Date would drop the microseconds on restore. */
let original: Array<{ id: string; is_default: boolean; updated_at: string }> = [];

async function restoreDefaultFlags(): Promise<void> {
  const originalDefaults = original.filter((o) => o.is_default).map((o) => o.id);
  await db.transaction().execute(async (trx) => {
    let clear = trx
      .updateTable("app_organizations")
      .set({ is_default: false })
      .where("is_default", "=", true);
    if (originalDefaults.length > 0) clear = clear.where("id", "not in", originalDefaults);
    await clear.execute();
    for (const row of original) {
      // `updated_at` too: a move stamps the org that lost the flag.
      await trx
        .updateTable("app_organizations")
        .set({ is_default: row.is_default, updated_at: sql`${row.updated_at}::timestamptz` })
        .where("id", "=", row.id)
        .execute();
    }
  });
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  const orgIds = (
    await db
      .selectFrom("app_organizations")
      .select("id")
      .where("slug", "like", `${ORG_PREFIX}%`)
      .execute()
  ).map((o) => o.id);
  if (orgIds.length > 0) {
    const roleIds = (
      await db.selectFrom("app_roles").select("id").where("organization_id", "in", orgIds).execute()
    ).map((r) => r.id);
    if (roleIds.length > 0) {
      await db.deleteFrom("app_role_permissions").where("role_id", "in", roleIds).execute();
      await db.deleteFrom("app_roles").where("id", "in", roleIds).execute();
    }
  }
  // Policy rows cascade with their org.
  await db.deleteFrom("app_organizations").where("slug", "like", `${ORG_PREFIX}%`).execute();
}

beforeAll(async () => {
  original = await db
    .selectFrom("app_organizations")
    .select(["id", "is_default", sql<string>`updated_at::text`.as("updated_at")])
    .where("is_default", "=", true)
    .execute();
});

beforeEach(() => {
  sessionGetter.mockReset().mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockReset().mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  // Flags first: a fixture org still flagged default is a real tenant target.
  await restoreDefaultFlags();
  await cleanup();
  await pgPool.end();
});

describe("F-40: routing follows is_default, not the slug (DB-backed)", () => {
  it("a RENAMED default org keeps receiving unmapped sign-ups under ITS policy; no org is created", async () => {
    const orgId = await newOrg("acme");
    expect((await patchOrg(orgId, { isDefault: true })).status).toBe(200);
    // A strict override on the default org: exactly what used to stop
    // applying once the slug lookup missed and the platform row took over.
    await db
      .insertInto("app_organization_auth_settings")
      .values({
        organization_id: orgId,
        require_email_verification: true,
        signup_approval_mode: "invite_only",
      })
      .execute();
    // The rename that broke routing.
    const renamed = await patchOrg(orgId, { slug: `${ORG_PREFIX}renamed` });
    expect(renamed.status, await renamed.clone().text()).toBe(200);

    const orgsBefore = await orgCount();
    const defaultSlugBefore = await orgCount({ slug: "default" });

    const policy = await resolveSignupPolicy({
      provider: "email",
      email: `ada@${EMAIL_DOMAIN}`,
      emailVerified: false,
    });
    expect(policy).toMatchObject({ source: "organization", signupApprovalMode: "invite_only" });

    for (const provider of ["email", "google"] as const) {
      const placed = await signUp(`renamed-${provider}`, provider);
      expect(placed.organizationId).toBe(orgId);
      expect(placed.membershipStatus).toBe("pending_approval");
    }
    const audits = await db
      .selectFrom("app_audit_events")
      .select(["organization_id", "metadata"])
      .where("actor_better_auth_user_id", "=", `${PREFIX}renamed-email`)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.organization_id).toBe(orgId);
    expect(audits[0]!.metadata).toMatchObject({
      policySource: "organization",
      decisionReason: "invite_required",
    });

    // Nothing was invented: no org at all, and no fresh `default` slug.
    expect(await orgCount()).toBe(orgsBefore);
    expect(await orgCount({ slug: "default" })).toBe(defaultSlugBefore);
    expect(await defaultIds()).toEqual([orgId]);
  });

  it("moving the flag moves routing and leaves exactly one default; it cannot be cleared", async () => {
    const first = await newOrg("first");
    const second = await newOrg("second");
    expect((await patchOrg(first, { isDefault: true })).status).toBe(200);

    expect((await patchOrg(second, { isDefault: true })).status).toBe(200);
    expect(await defaultIds()).toEqual([second]);
    expect((await getDefaultOrganization())?.id).toBe(second);
    expect((await signUp("moved", "email")).organizationId).toBe(second);
    const moved = await db
      .selectFrom("app_audit_events")
      .select(["organization_id", "metadata"])
      .where("actor_better_auth_user_id", "=", ACTOR)
      .where("event_type", "=", "admin.organization.updated")
      .where("organization_id", "=", second)
      .executeTakeFirstOrThrow();
    expect(moved.metadata).toMatchObject({ previousDefaultOrganizationIds: [first] });

    // Unticking the default would leave sign-ups nowhere to land.
    const cleared = await patchOrg(second, { isDefault: false });
    expect(cleared.status).toBe(409);
    expect(await cleared.json()).toMatchObject({ error: "organization_is_default" });
    expect(await defaultIds()).toEqual([second]);

    // Creating an org "as default" moves it too.
    const created = await POST(
      jsonReq("", "POST", { slug: `${ORG_PREFIX}created`, name: "Created", isDefault: true }),
    );
    expect(created.status).toBe(201);
    const { id: createdId } = (await created.json()) as { id: string };
    expect(await defaultIds()).toEqual([createdId]);
    expect((await signUp("created", "google")).organizationId).toBe(createdId);
  });

  it("a seed re-run after the rename reuses the flagged org and adds no second default", async () => {
    const flagged = await newOrg("seeded");
    const client = await pgPool.connect();
    try {
      await client.query("begin");
      // The post-rename state the old seed mishandled: the flagged default has
      // some other slug, and the slug `default` is free again.
      await client.query(`update app_organizations set is_default = (id = $1)`, [flagged]);
      await client.query(`update app_organizations set slug = $1 where slug = 'default'`, [
        `${ORG_PREFIX}was-default`,
      ]);
      const orgsBefore = Number(
        (await client.query<{ n: string }>(`select count(*) as n from app_organizations`)).rows[0]!
          .n,
      );

      const logs: string[] = [];
      const firstRun = await ensureDefaultOrganization(client, (m) => logs.push(m));
      const secondRun = await ensureDefaultOrganization(client, (m) => logs.push(m));

      expect(firstRun).toEqual({ id: flagged, outcome: "existing" });
      expect(secondRun).toEqual({ id: flagged, outcome: "existing" });
      expect(logs).toEqual([]);
      const defaults = await client.query<{ id: string }>(
        `select id from app_organizations where is_default`,
      );
      expect(defaults.rows.map((r) => r.id)).toEqual([flagged]);
      expect(
        (await client.query(`select 1 from app_organizations where slug = 'default'`)).rowCount,
      ).toBe(0);
      expect(
        Number(
          (await client.query<{ n: string }>(`select count(*) as n from app_organizations`))
            .rows[0]!.n,
        ),
      ).toBe(orgsBefore);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("two concurrent moves leave exactly one default", async () => {
    const start = await newOrg("race-start");
    const a = await newOrg("race-a");
    const b = await newOrg("race-b");
    await db.transaction().execute((trx) => moveDefaultOrganizationFlag(trx, start));

    // T1 moves the flag to A and holds its transaction open; T2 then moves it
    // to B. Without the default-flag lock, T2's clearing UPDATE waits on the
    // row T1 cleared, then skips it, and never sees A (set after T2's snapshot)
    // — two defaults. With it, T2 waits for T1 and then clears A.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let t1Moved!: () => void;
    const t1HasMoved = new Promise<void>((resolve) => (t1Moved = resolve));
    const t1 = db.transaction().execute(async (trx) => {
      await moveDefaultOrganizationFlag(trx, a);
      t1Moved();
      await gate;
    });
    await t1HasMoved;
    const t2 = db.transaction().execute((trx) => moveDefaultOrganizationFlag(trx, b));
    // Let T2 reach its blocking point before T1 commits.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await Promise.all([t1, t2]);

    expect(await defaultIds()).toEqual([b]);
  });

  it("a DELETE racing a 'Set as default' on the same org is refused; the new default survives", async () => {
    const start = await newOrg("del-start");
    const target = await newOrg("del-target");
    await db.transaction().execute((trx) => moveDefaultOrganizationFlag(trx, start));

    // A move onto `target` is under way (not committed) when the DELETE
    // arrives, so the DELETE's guards on the pool still see an empty,
    // non-default org. Without the re-check under the default-flag lock, its
    // transaction waited only on the moved row, then deleted it: zero defaults.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let moved!: () => void;
    const hasMoved = new Promise<void>((resolve) => (moved = resolve));
    const mover = db.transaction().execute(async (trx) => {
      await moveDefaultOrganizationFlag(trx, target);
      moved();
      await gate;
    });
    await hasMoved;
    const deleting = deleteOrg(target);
    await lockWaiterAppears();
    release();
    await mover;
    const res = await deleting;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ error: "organization_is_default" });
    expect(await defaultIds()).toEqual([target]);
    const blocked = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "metadata"])
      .where("actor_better_auth_user_id", "=", ACTOR)
      .where("organization_id", "=", target)
      .execute();
    expect(blocked).toEqual([
      expect.objectContaining({
        event_type: "admin.organization.delete_blocked",
        metadata: expect.objectContaining({ reason: "organization_is_default" }),
      }),
    ]);
  });

  it("a save that touches the flag cannot deadlock against a concurrent move (lock order)", async () => {
    // The flagged default also holds a superuser grant, as the seeded
    // platform org does, so the PATCH's last-superuser check row-locks it.
    const current = await orgWithSuperuserGrant("lock-current");
    const other = await newOrg("lock-other");
    const target = await newOrg("lock-target");
    await db.transaction().execute((trx) => moveDefaultOrganizationFlag(trx, current));

    // A mover holds the default-flag lock; the PATCH then arrives. Taken
    // AFTER the last-superuser check, the PATCH held `current`'s row while
    // waiting for the lock, the mover then waited for that row, and Postgres
    // aborted one of them (a 500 or a failed move).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    const mover = db.transaction().execute(async (trx) => {
      await lockDefaultOrganizationFlag(trx);
      locked();
      await gate;
      await moveDefaultOrganizationFlag(trx, other);
    });
    await hasLock;
    const saving = patchOrg(target, { status: "suspended", isDefault: true });
    await lockWaiterAppears();
    release();
    const [moveResult, saveResult] = await Promise.allSettled([mover, saving]);

    expect(moveResult.status).toBe("fulfilled");
    expect(saveResult.status).toBe("fulfilled");
    const res = (saveResult as PromiseFulfilledResult<Response>).value;
    expect(res.status, await res.clone().text()).toBe(200);
    // Serialized: the move, then the save, which moved the flag again.
    expect(await defaultIds()).toEqual([target]);
  });

  it("a legacy EXTRA flag can be cleared; the flag on the org sign-ups resolve to cannot", async () => {
    const original = await newOrg("legacy-original");
    const extra = await newOrg("legacy-extra");
    // Make the order explicit: routing resolves a tie to the OLDEST.
    await pgPool.query(
      `update app_organizations set created_at = created_at - interval '1 hour' where id = $1`,
      [original],
    );
    // The pre-F-40 state: two orgs flagged default.
    await pgPool.query(
      `update app_organizations set is_default = (id in ($1, $2))
        where is_default or id in ($1, $2)`,
      [original, extra],
    );
    expect((await getDefaultOrganization())?.id).toBe(original);

    // Refused on the org sign-ups resolve to...
    const refused = await patchOrg(original, { isDefault: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "organization_is_default" });

    // ...but on the extra flag it is the repair.
    const cleared = await patchOrg(extra, { isDefault: false });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await defaultIds()).toEqual([original]);
    const audit = await db
      .selectFrom("app_audit_events")
      .select("metadata")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .where("event_type", "=", "admin.organization.updated")
      .where("organization_id", "=", extra)
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ clearedExtraDefaultFlag: true });

    // On an org that is not flagged at all it is still a no-op.
    const noop = await patchOrg(extra, { isDefault: false });
    expect(noop.status).toBe(200);
    expect(await defaultIds()).toEqual([original]);
  });
});

describe("F-40: the seed's platform org is not the default org (DB-backed)", () => {
  it("a seed re-run after the default was MOVED writes no platform role or admin grant into the new default", async () => {
    const client = await pgPool.connect();
    const email = `seed-admin@${EMAIL_DOMAIN}`;
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
    };
    // Stands in for Better Auth's signUpEmail, on the same (rolled-back) client.
    const createAuthUser = async (input: { email: string; name: string }) => {
      const id = `${PREFIX}seed-admin`;
      await client.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, $2, $3, false, now(), now())`,
        [id, input.name, input.email],
      );
      return { id, email: input.email, name: input.name };
    };
    /** The org-dependent steps of seed-local.ts, in its order. */
    const runSeed = async () => {
      const { id: defaultOrgId } = await ensureDefaultOrganization(client, log);
      const orgId = await resolveSeedPlatformOrganization(client, defaultOrgId, log);
      await seedBaselineRoles(client, orgId);
      const admin = await seedDefaultAdminUser(
        client,
        orgId,
        { email, password: "unused", adoptExisting: false, createAuthUser },
        log,
      );
      return { defaultOrgId, orgId, admin };
    };
    const countIn = async (table: string, orgId: string) =>
      Number(
        (
          await client.query<{ n: string }>(
            `select count(*) as n from ${table} where organization_id = $1`,
            [orgId],
          )
        ).rows[0]!.n,
      );

    try {
      await client.query("begin");
      // The platform org: the OLDEST org holding the seeded superuser role, as
      // migration 0001's initial default org is (0001 puts the role there).
      const platform = (
        await client.query<{ id: string }>(
          `insert into app_organizations (slug, name, status, is_default, created_at)
           values ($1, 'DBTest F-40 platform', 'active', false, '1970-01-01T00:00:00Z')
           returning id`,
          [`${ORG_PREFIX}platform`],
        )
      ).rows[0]!.id;
      await client.query(`update app_organizations set is_default = (id = $1)`, [platform]);
      await seedBaselineRoles(client, platform);

      const first = await runSeed();
      expect(first).toEqual({ defaultOrgId: platform, orgId: platform, admin: "created" });

      // A superadmin moves the default to a customer tenant (Settings).
      const tenant = (
        await client.query<{ id: string }>(
          `insert into app_organizations (slug, name, status) values ($1, 'DBTest F-40 tenant', 'active')
           returning id`,
          [`${ORG_PREFIX}tenant`],
        )
      ).rows[0]!.id;
      await client.query(`update app_organizations set is_default = (id = $1)`, [tenant]);
      logs.length = 0;

      // The operator re-runs db:seed / db:provision.
      const second = await runSeed();

      // The admin is the seed's own (not refused), the platform grants stay in
      // the platform org, and the default stays where the superadmin put it.
      expect(second).toEqual({ defaultOrgId: tenant, orgId: platform, admin: "reconciled" });
      expect(await countIn("app_roles", tenant)).toBe(0);
      expect(await countIn("app_organization_memberships", tenant)).toBe(0);
      expect(await countIn("app_user_roles", tenant)).toBe(0);
      const defaults = await client.query<{ id: string }>(
        `select id from app_organizations where is_default`,
      );
      expect(defaults.rows.map((r) => r.id)).toEqual([tenant]);
      expect(logs.join("\n")).toContain(`stay in organization ${platform}`);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
