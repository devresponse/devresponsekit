import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

/**
 * DB-BACKED test for F-56: the last-superadmin invariant (REVOKE-2) counts a
 * `superuser` grant only while the account holding it can still SIGN IN.
 *
 * Before the fix `activeGlobalSuperuserGrants` read the assignment, the active
 * membership, the active organization and the role's permission, and nothing
 * about the account. A grant held by a banned account, or by one left
 * `pending_approval` by a soft-delete and restore, still counted as a
 * survivor, and a ban was not gated at all. So superadmin S1 could ban
 * superadmin S2 (or soft-delete and restore them) and then block themselves:
 * the predicate saw S2's grant, allowed it, and nobody could sign in to
 * administer the platform again.
 *
 * This runs the real predicate, the real status core, the real bulk ban and
 * soft-delete (Better Auth included) and the real audit writer against
 * Postgres. The last two blocks prove the Better Auth `user` row lock (a ban
 * that lands while a status change is deciding is seen by that decision) and
 * the status core's lock order (it reads the grants before it claims or writes
 * the account row, so it cannot deadlock with a concurrent grant read).
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f56_`
 * and clean up after themselves. A superadmin elsewhere in the database who
 * can sign in would survive every removal here and mask the refusals (the
 * suites run one file at a time and clean up, so only another run sharing the
 * database leaves one), so the refusal cases check for one first and say so.
 */
const { db, pgPool } = await import("@/db/database");
const {
  SUPERADMIN_PERMISSION,
  LAST_SUPERADMIN_EVENT,
  activeGlobalSuperuserGrants,
  wouldStripLastGlobalSuperuser,
} = await import("@/lib/admin/access-scope.server");
const { performAdminStatusChange } = await import("@/lib/admin-status.server");
const { executeBulkUserAction } = await import("@/lib/admin/user-actions.server");

const PREFIX = "__dbtest_f56_";
const RUN = randomUUID().slice(0, 8);
/** Plain text (no FK) on audit rows: the handle cleanup finds them by. */
const ACTOR = `${PREFIX}actor`;
const ALL = { kind: "all" } as const;

interface Fixture {
  id: string;
  ba: string;
}

const w = {
  orgId: "",
  roleId: "",
  s1: { id: "", ba: "" } as Fixture,
  s2: { id: "", ba: "" } as Fixture,
  /** A superuser grant on an account with no Better Auth user at all. */
  orphan: { id: "", ba: "" } as Fixture,
};

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them, and they must go before the users they reference.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("actor_better_auth_user_id", "like", `${PREFIX}%`),
          ...(userIds.length > 0 ? [eb("app_user_id", "in", userIds)] : []),
        ]),
      )
      .execute();
  });
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await pgPool.query(`delete from "session" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

/** An active superadmin: account, Better Auth user (unless `withAuthUser` is false), membership, grant. */
async function superadmin(key: string, withAuthUser = true): Promise<Fixture> {
  const ba = `${PREFIX}ba_${key}_${RUN}`;
  if (withAuthUser) {
    await pgPool.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, true, now(), now())`,
      [ba, `F56 ${key}`, `${PREFIX}${key}_${RUN}@dbtest.local`],
    );
  }
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${key}_${RUN}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: w.orgId, app_user_id: row.id, status: "active" })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: row.id, organization_id: w.orgId, role_id: w.roleId })
    .execute();
  return { id: row.id, ba };
}

async function setBan(who: Fixture, banned: boolean | null, banExpires: string | null = null) {
  await pgPool.query(
    `update "user" set banned = $2, "banExpires" = $3::timestamptz where id = $1`,
    [who.ba, banned, banExpires],
  );
}

async function setAccountStatus(who: Fixture, status: string): Promise<void> {
  await db
    .updateTable("app_users")
    .set({ status, updated_at: sql`now()` })
    .where("id", "=", who.id)
    .execute();
}

/** The fixture accounts `activeGlobalSuperuserGrants` counts, by name. */
async function counted(options?: { disregardBanOf?: string }): Promise<string[]> {
  const names = new Map([
    [w.s1.id, "s1"],
    [w.s2.id, "s2"],
    [w.orphan.id, "orphan"],
  ]);
  const grants = await activeGlobalSuperuserGrants(db, options);
  return grants
    .map((g) => names.get(g.appUserId))
    .filter((n): n is string => n !== undefined)
    .sort();
}

/** Signable grants outside this suite: any one of them survives every removal here. */
async function foreignSignableGrants(): Promise<number> {
  const mine = new Set([w.s1.id, w.s2.id, w.orphan.id]);
  const grants = await activeGlobalSuperuserGrants();
  return grants.filter((g) => !mine.has(g.appUserId)).length;
}

async function banState(who: Fixture): Promise<boolean | null> {
  const { rows } = await pgPool.query<{ banned: boolean | null }>(
    `select banned from "user" where id = $1`,
    [who.ba],
  );
  return rows[0]!.banned;
}

/** A promise's outcome as a value, so a rejection is asserted, never left unhandled. */
function settle<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/** Resolves once another backend is waiting on a lock held by backend `holderPid`. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await pgPool.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error(`nothing waited on backend ${holderPid}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function backendPid(client: { query: typeof pgPool.query }): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

async function accountStatus(who: Fixture): Promise<string> {
  const row = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", who.id)
    .executeTakeFirstOrThrow();
  return row.status;
}

const blockSelf = (who: Fixture) =>
  performAdminStatusChange({
    actorBetterAuthUserId: who.ba,
    scope: ALL,
    targetAppUserId: who.id,
    newStatus: "blocked",
    newMembershipStatus: "blocked",
    eventType: "admin.user.blocked",
  });

/**
 * A superadmin actor whose own authority is not a counted grant (a
 * group-conferred one, say): short of a race, the only case in which a ban or
 * a soft-delete can meet the last grant.
 */
const bulkActor = {
  betterAuthUserId: ACTOR,
  request: { headers: new Headers() },
  scope: ALL,
  access: { permissions: [SUPERADMIN_PERMISSION], organizationId: null },
  requestId: `${PREFIX}req`,
};
const bulkTarget = (who: Fixture) => ({
  appUserId: who.id,
  betterAuthUserId: who.ba,
  primaryEmail: `${PREFIX}x@dbtest.local`,
  status: "active",
});

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org_${RUN}`, name: "F56 Org", status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.orgId = org.id;
  await db
    .insertInto("app_permissions")
    .values({ key: SUPERADMIN_PERMISSION, description: "superuser marker" })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  const perm = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", SUPERADMIN_PERMISSION)
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: w.orgId, key: `${PREFIX}super`, name: "F56 Super" })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.roleId = role.id;
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: perm.id })
    .execute();
  w.s1 = await superadmin("s1");
  w.s2 = await superadmin("s2");
  w.orphan = await superadmin("orphan", false);
});

// Every case starts from two active, unbanned superadmins.
beforeEach(async () => {
  for (const who of [w.s1, w.s2]) {
    await setAccountStatus(who, "active");
    await setBan(who, null);
  }
  await db
    .updateTable("app_organization_memberships")
    .set({ status: "active", pre_deactivation_status: null })
    .where("organization_id", "=", w.orgId)
    .execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-56: only an account that can sign in keeps a grant alive", () => {
  it("counts both active, unbanned superadmins, and never an account with no Better Auth user", async () => {
    await expect(counted()).resolves.toEqual(["s1", "s2"]);
  });

  it("drops a banned account — indefinitely or until a future date — and keeps an expired ban", async () => {
    await setBan(w.s2, true);
    await expect(counted()).resolves.toEqual(["s1"]);
    await setBan(w.s2, true, "2999-01-01T00:00:00Z");
    await expect(counted()).resolves.toEqual(["s1"]);
    // An elapsed temporary ban no longer stops a sign-in (`isBanActive`).
    await setBan(w.s2, true, "2000-01-01T00:00:00Z");
    await expect(counted()).resolves.toEqual(["s1", "s2"]);
    await setBan(w.s2, false);
    await expect(counted()).resolves.toEqual(["s1", "s2"]);
  });

  it.each(["pending_approval", "blocked", "suspended", "deactivated"])(
    "drops an account whose status is %s, whatever its membership says",
    async (status) => {
      // The membership stays `active`: the old predicate read only that.
      await setAccountStatus(w.s2, status);
      await expect(counted()).resolves.toEqual(["s1"]);
    },
  );

  it("disregardBanOf reads one account as unbanned and nothing more", async () => {
    await setBan(w.s2, true);
    await expect(counted({ disregardBanOf: w.s2.ba })).resolves.toEqual(["s1", "s2"]);
    // Another account's ban still counts against it.
    await setBan(w.s1, true);
    await expect(counted({ disregardBanOf: w.s2.ba })).resolves.toEqual(["s2"]);
    // …and it is only the ban that is disregarded, not the account status.
    await setAccountStatus(w.s2, "pending_approval");
    await expect(counted({ disregardBanOf: w.s2.ba })).resolves.toEqual([]);
  });
});

describe("F-56: the lockout sequences the finding names are refused", () => {
  it("S1 bans S2 (allowed: S1 survives), then S1 cannot block themselves or drop their own grant", async () => {
    expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(0);
    const ban = await executeBulkUserAction(
      "ban",
      bulkTarget(w.s2),
      { ...bulkActor, betterAuthUserId: w.s1.ba },
      { reason: "f56" },
    );
    expect(ban).toEqual({ ok: true, appUserId: w.s2.id });
    expect(await banState(w.s2)).toBe(true);

    await expect(blockSelf(w.s1)).resolves.toEqual({ ok: false, error: "last_superadmin" });
    expect(await accountStatus(w.s1)).toBe("active");
    await expect(
      wouldStripLastGlobalSuperuser({
        assignments: [{ appUserId: w.s1.id, organizationId: w.orgId, roleId: w.roleId }],
      }),
    ).resolves.toBe(true);
  });

  it("S2 soft-deleted and restored (`pending_approval`): S1 cannot block themselves", async () => {
    expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(0);
    // What restore leaves: the account pending, the membership back to active.
    await setAccountStatus(w.s2, "pending_approval");
    await expect(blockSelf(w.s1)).resolves.toEqual({ ok: false, error: "last_superadmin" });
    expect(await accountStatus(w.s1)).toBe("active");
  });

  it("with S2 still able to sign in, S1 may block themselves (a co-superadmin survives)", async () => {
    await expect(blockSelf(w.s1)).resolves.toEqual({ ok: true, status: "blocked" });
  });

  it("a ban of the last superadmin who can sign in is refused and undone", async () => {
    expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(0);
    await setAccountStatus(w.s2, "blocked");
    const out = await executeBulkUserAction("ban", bulkTarget(w.s1), bulkActor, {
      reason: "f56",
    });
    expect(out).toEqual({ ok: false, appUserId: w.s1.id, error: "last_superadmin" });
    // The ban landed before the check and has been lifted again.
    expect(await banState(w.s1)).toBe(false);
    const audit = await db
      .selectFrom("app_audit_events")
      .select(["outcome", "reason"])
      .where("event_type", "=", LAST_SUPERADMIN_EVENT)
      .where("app_user_id", "=", w.s1.id)
      .where(sql<boolean>`metadata->>'action' = 'ban'`)
      .execute();
    expect(audit).toEqual([{ outcome: "denied", reason: "last_global_superuser" }]);
  });

  it("a soft-delete of the last superadmin who can sign in is still refused, though it bans first", async () => {
    // The soft-delete bans before its cascade. Read as a plain membership
    // cascade, that ban would already have emptied the set and nothing would
    // be refused.
    expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(0);
    await setAccountStatus(w.s2, "blocked");
    const out = await executeBulkUserAction("soft_delete", bulkTarget(w.s1), bulkActor, {});
    expect(out).toEqual({ ok: false, appUserId: w.s1.id, error: "last_superadmin" });
    expect(await accountStatus(w.s1)).toBe("active");
    expect(await banState(w.s1)).toBe(false);
  });
});

describe("F-56: the Better Auth `user` row is locked with the grants", () => {
  it("a ban that commits while a status change is deciding is seen by that decision", async () => {
    expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(0);
    // Better Auth bans on its own connection. Hold that write open…
    const banner = await pgPool.connect();
    try {
      await banner.query("begin");
      await banner.query(`update "user" set banned = true where id = $1`, [w.s2.ba]);
      // …while S1 blocks themselves, which is fine only if S2 still counts.
      const decision = settle(blockSelf(w.s1));
      // With `user` in the FOR UPDATE list the grant read waits on the ban's
      // row lock; without it, it reads S2 as unbanned from its snapshot,
      // waits on nothing and lets S1 go, and this times out.
      await waitUntilBlockedBy(await backendPid(banner));
      await banner.query("commit");
      // Once the ban commits, the recheck drops S2's grant.
      await expect(decision).resolves.toEqual({
        value: { ok: false, error: "last_superadmin" },
      });
    } finally {
      await banner.query("rollback").catch(() => undefined);
      banner.release();
    }
    expect(await accountStatus(w.s1)).toBe("active");
  });
});

describe("F-56: a status change takes the grant locks before it writes the account", () => {
  // A REVOKE-2 read locks each grant's rows in its FOR UPDATE OF order: the
  // assignment, the membership, the org and the role's permission, and only
  // then the account (`app_users`) and its Better Auth `user`. `holder` is
  // such a read part-way through S1's grant: it holds S1's membership row and
  // asks for S1's account row next. A status change that claimed (If-Match) or
  // wrote S1's account row before its own grant read would hold that row while
  // waiting on the membership, and Postgres would kill one side as a deadlock
  // (40P01, a 500).
  it.each([
    {
      label: "an If-Match block",
      change: {
        newStatus: "blocked",
        newMembershipStatus: "blocked",
        eventType: "admin.user.blocked",
      },
      ifMatch: true,
      expected: { ok: true, status: "blocked" },
    },
    {
      label: "an approve of an account that is already active",
      change: {
        newStatus: "active",
        newMembershipStatus: "active",
        eventType: "admin.user.approved",
      },
      ifMatch: false,
      expected: { ok: true, status: "active" },
    },
  ] as const)(
    "$label on a counted superadmin does not deadlock with a concurrent grant read",
    async ({ change, ifMatch, expected }) => {
      const current = await db
        .selectFrom("app_users")
        .select("updated_at")
        .where("id", "=", w.s1.id)
        .executeTakeFirstOrThrow();
      const holder = await pgPool.connect();
      try {
        await holder.query("begin");
        await holder.query(
          `select 1 from app_organization_memberships
            where app_user_id = $1 and organization_id = $2 for update`,
          [w.s1.id, w.orgId],
        );
        const decision = settle(
          performAdminStatusChange({
            actorBetterAuthUserId: ACTOR,
            scope: ALL,
            targetAppUserId: w.s1.id,
            expectedUpdatedAt: ifMatch ? (current.updated_at as unknown as Date) : undefined,
            ...change,
          }),
        );
        await waitUntilBlockedBy(await backendPid(holder));
        // The rest of the holder's grant read: S1's account row.
        await holder.query(`select 1 from app_users where id = $1 for update`, [w.s1.id]);
        await holder.query("commit");
        // Neither side died, and the change went through (S2 still signs in,
        // so the block is allowed).
        await expect(decision).resolves.toEqual({ value: expected });
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
    },
  );
});
