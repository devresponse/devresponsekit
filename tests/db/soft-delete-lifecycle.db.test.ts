import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

/**
 * DB-BACKED test for the soft-delete lifecycle (F-57, I-19).
 *
 * F-57: a soft-deleted account leaves `deactivated` only through restore.
 * Approving one used to make it `active` while its Better Auth ban, its
 * `deactivated_*` columns and its membership snapshot stayed; unbanning one
 * let Better Auth issue it sessions while the app still read it as deleted.
 * And restore lifted every ban, so a user banned for abuse and then
 * soft-deleted came back from restore unbanned. Now the soft-delete records
 * the ban it replaced on its `admin.user.soft_deleted` row, and restore puts
 * that ban back.
 *
 * I-19: a soft-delete left the user's API keys and OAuth clients `active`, so
 * restore and approve re-armed them. Now it revokes them (`owner_deleted`),
 * and they stay revoked.
 *
 * This runs the real bulk soft-delete and restore (Better Auth included), the
 * real status core, the real credential eviction and the real audit writer
 * against Postgres; the soft-delete / restore saga is shared with the
 * single-row routes (`banForSoftDelete`, `finishSoftDelete`,
 * `recordedPriorBan`). Driven by `pnpm test:db` (vitest.db.config.ts).
 * Fixtures use `__dbtest_f57_` and clean up after themselves.
 */
const { db, pgPool } = await import("@/db/database");
const { SUPERADMIN_PERMISSION } = await import("@/lib/admin/access-scope.server");
const { performAdminStatusChange } = await import("@/lib/admin-status.server");
const { executeBulkUserAction } = await import("@/lib/admin/user-actions.server");
const { createApiKey } = await import("@/lib/api-auth/api-keys.server");
const { createOauthClient } = await import("@/lib/api-auth/oauth-clients.server");

const PREFIX = "__dbtest_f57_";
const RUN = randomUUID().slice(0, 8);
const ALL = { kind: "all" } as const;

const w = { orgId: "", adminId: "", targetId: "", otherId: "", targetBa: "" };

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
    await db.deleteFrom("app_api_keys").where("app_user_id", "in", userIds).execute();
    await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await pgPool.query(`delete from "session" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function appUser(key: string, ba: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${key}_${RUN}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The actor: a superadmin batch (the rank guard exempts it) with an app user for `revoked_by`. */
const actor = () => ({
  betterAuthUserId: `${PREFIX}actor`,
  appUserId: w.adminId,
  request: { headers: new Headers() },
  scope: ALL,
  access: { permissions: [SUPERADMIN_PERMISSION], organizationId: null },
  requestId: `${PREFIX}req`,
});

async function accountStatus(): Promise<string> {
  const row = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", w.targetId)
    .executeTakeFirstOrThrow();
  return row.status;
}

/** The bulk target as the batch reads it: the account's CURRENT status. */
async function target() {
  return {
    appUserId: w.targetId,
    betterAuthUserId: w.targetBa,
    primaryEmail: `${PREFIX}target@dbtest.local`,
    status: await accountStatus(),
  };
}

async function banRow(): Promise<{
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
}> {
  const { rows } = await pgPool.query(
    `select banned, "banReason", "banExpires" from "user" where id = $1`,
    [w.targetBa],
  );
  return rows[0];
}

async function setBan(reason: string | null, expires: string | null): Promise<void> {
  await pgPool.query(
    `update "user" set banned = $2, "banReason" = $3, "banExpires" = $4::timestamptz where id = $1`,
    [w.targetBa, reason !== null, reason, expires],
  );
}

async function membershipStatus(): Promise<string> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select("status")
    .where("app_user_id", "=", w.targetId)
    .executeTakeFirstOrThrow();
  return row.status;
}

const approve = () =>
  performAdminStatusChange({
    actorBetterAuthUserId: `${PREFIX}actor`,
    scope: ALL,
    targetAppUserId: w.targetId,
    newStatus: "active",
    newMembershipStatus: "active",
    eventType: "admin.user.approved",
  });

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

beforeAll(async () => {
  await cleanup();
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org_${RUN}`, name: "F57 Org", status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.orgId = org.id;
  w.targetBa = `${PREFIX}ba_target_${RUN}`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'F57 target', $2, true, now(), now())`,
    [w.targetBa, `${PREFIX}target_${RUN}@dbtest.local`],
  );
  w.targetId = await appUser("target", w.targetBa);
  w.adminId = await appUser("admin", `${PREFIX}ba_admin_${RUN}`);
  w.otherId = await appUser("other", `${PREFIX}ba_other_${RUN}`);
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: w.orgId, app_user_id: w.targetId, status: "active" })
    .execute();
});

// Every case starts from an active, unbanned member with no soft-delete record.
beforeEach(async () => {
  await db
    .updateTable("app_users")
    .set({
      status: "active",
      status_reason: null,
      deactivated_at: null,
      deactivated_by: null,
      deactivated_reason: null,
    })
    .where("id", "=", w.targetId)
    .execute();
  await db
    .updateTable("app_organization_memberships")
    .set({ status: "active", pre_deactivation_status: null })
    .where("app_user_id", "=", w.targetId)
    .execute();
  await setBan(null, null);
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("app_user_id", "=", w.targetId).execute();
  });
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-57: an earlier ban survives the soft-delete and its restore", () => {
  it("restore puts back a ban for abuse, with its reason and expiry, instead of lifting it", async () => {
    const expires = "2999-01-01T00:00:00.000Z";
    await setBan("abuse", expires);

    await expect(
      executeBulkUserAction("soft_delete", await target(), actor(), {}),
    ).resolves.toEqual({ ok: true, appUserId: w.targetId });
    // The soft-delete's own ban is indefinite, over the earlier one.
    expect(await banRow()).toEqual({ banned: true, banReason: "deleted", banExpires: null });
    expect(await accountStatus()).toBe("deactivated");

    await expect(executeBulkUserAction("restore", await target(), actor())).resolves.toEqual({
      ok: true,
      appUserId: w.targetId,
    });
    const ban = await banRow();
    expect(ban).toMatchObject({ banned: true, banReason: "abuse" });
    expect(ban.banExpires?.toISOString()).toBe(expires);
    expect(await accountStatus()).toBe("pending_approval");
    // F-152: the active membership comes back for its org to approve again.
    expect(await membershipStatus()).toBe("pending_approval");
  });

  it("restore lifts the soft-delete's ban when there was none before it", async () => {
    await executeBulkUserAction("soft_delete", await target(), actor(), {});
    await executeBulkUserAction("restore", await target(), actor());
    expect(await banRow()).toEqual({ banned: false, banReason: null, banExpires: null });
  });

  it("a repeated soft-delete keeps the first one's record, so restore still puts the earlier ban back", async () => {
    await setBan("abuse", null);
    await executeBulkUserAction("soft_delete", await target(), actor(), {});
    // The second soft-delete replaces the first one's own ban, not the earlier one.
    await expect(
      executeBulkUserAction("soft_delete", await target(), actor(), { reason: "again" }),
    ).resolves.toEqual({ ok: true, appUserId: w.targetId });

    await executeBulkUserAction("restore", await target(), actor());
    expect(await banRow()).toEqual({ banned: true, banReason: "abuse", banExpires: null });
  });

  it("restore reads the LATEST soft-delete's record, so a ban lifted between two cycles stays lifted", async () => {
    // Cycle 1 records the ban for abuse, and restore puts it back…
    await setBan("abuse", null);
    await executeBulkUserAction("soft_delete", await target(), actor(), {});
    await executeBulkUserAction("restore", await target(), actor());
    expect(await banRow()).toMatchObject({ banned: true, banReason: "abuse" });
    // …then an admin lifts it and approves the account.
    await expect(executeBulkUserAction("unban", await target(), actor())).resolves.toEqual({
      ok: true,
      appUserId: w.targetId,
    });
    await expect(executeBulkUserAction("approve", await target(), actor())).resolves.toEqual({
      ok: true,
      appUserId: w.targetId,
    });

    // Cycle 2 replaces no ban. Its restore must read its own record, not the
    // first cycle's, or it would ban the user for abuse again.
    await executeBulkUserAction("soft_delete", await target(), actor(), {});
    await expect(executeBulkUserAction("restore", await target(), actor())).resolves.toEqual({
      ok: true,
      appUserId: w.targetId,
    });
    expect(await banRow()).toEqual({ banned: false, banReason: null, banExpires: null });
    expect(await accountStatus()).toBe("pending_approval");
  });
});

describe("F-57: a soft-deleted account leaves `deactivated` only through restore", () => {
  it.each(["approve", "block", "suspend", "reactivate", "ban", "unban"] as const)(
    "bulk %s is refused per row with use_restore, and the account stays deleted",
    async (action) => {
      await executeBulkUserAction("soft_delete", await target(), actor(), {});

      await expect(
        executeBulkUserAction(action, await target(), actor(), { reason: "x" }),
      ).resolves.toEqual({ ok: false, appUserId: w.targetId, error: "use_restore" });

      expect(await accountStatus()).toBe("deactivated");
      expect(await membershipStatus()).toBe("blocked");
      expect(await banRow()).toEqual({ banned: true, banReason: "deleted", banExpires: null });
    },
  );

  it("the status core refuses it from the row it reads, whatever the caller read before", async () => {
    await executeBulkUserAction("soft_delete", await target(), actor(), {});

    await expect(approve()).resolves.toEqual({ ok: false, error: "use_restore" });

    expect(await accountStatus()).toBe("deactivated");
    expect(await membershipStatus()).toBe("blocked");
  });

  it("a soft-delete committing while an approve waits is seen by the approve, not overwritten", async () => {
    // Hold the deactivation open, as the soft-delete's cascade does…
    const deleter = await pgPool.connect();
    try {
      await deleter.query("begin");
      await deleter.query(`update app_users set status = 'deactivated' where id = $1`, [
        w.targetId,
      ]);
      const { rows } = await deleter.query<{ pid: number }>("select pg_backend_pid() as pid");
      // …while an approve decides. Its status read takes the row lock, so it
      // waits and then reads the committed value. A plain read would see
      // `active`, and the approve would overwrite the deactivation.
      const decision = settle(approve());
      await waitUntilBlockedBy(rows[0]!.pid);
      await deleter.query("commit");
      await expect(decision).resolves.toEqual({ value: { ok: false, error: "use_restore" } });
    } finally {
      await deleter.query("rollback").catch(() => undefined);
      deleter.release();
    }
    expect(await accountStatus()).toBe("deactivated");
  });
});

describe("I-19: the soft-delete revokes the user's bearer credentials, and restore does not re-arm them", () => {
  it("revokes every API key and OAuth client acting as the user; approve after restore brings none back", async () => {
    const key = await createApiKey({
      ownerAppUserId: w.targetId,
      organizationId: null,
      name: `${PREFIX}never-expires`,
      scopes: ["account.read"],
      expiresAt: null,
      createdByAppUserId: w.targetId,
    });
    const client = await createOauthClient({
      name: `${PREFIX}client`,
      scopes: ["account.read"],
      organizationId: null,
      serviceAppUserId: w.targetId,
      createdByAppUserId: w.adminId,
    });
    // A key the user minted for someone else authenticates as that principal.
    const minted = await createApiKey({
      ownerAppUserId: w.otherId,
      organizationId: null,
      name: `${PREFIX}for-other`,
      scopes: ["account.read"],
      expiresAt: null,
      createdByAppUserId: w.targetId,
    });

    await expect(
      executeBulkUserAction("soft_delete", await target(), actor(), {}),
    ).resolves.toEqual({ ok: true, appUserId: w.targetId });

    const keyRow = () =>
      db
        .selectFrom("app_api_keys")
        .select(["status", "revoked_by", "revoked_reason"])
        .where("id", "=", key.id)
        .executeTakeFirstOrThrow();
    const clientRow = () =>
      db
        .selectFrom("app_oauth_clients")
        .select(["status", "revoked_by"])
        .where("id", "=", client.id)
        .executeTakeFirstOrThrow();
    expect(await keyRow()).toEqual({
      status: "revoked",
      revoked_by: w.adminId,
      revoked_reason: "owner_deleted",
    });
    expect(await clientRow()).toEqual({ status: "revoked", revoked_by: w.adminId });
    const other = await db
      .selectFrom("app_api_keys")
      .select("status")
      .where("id", "=", minted.id)
      .executeTakeFirstOrThrow();
    expect(other.status).toBe("active");

    const audit = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "metadata"])
      .where("app_user_id", "=", w.targetId)
      .where("event_type", "in", [
        "api_key.revoked",
        "oauth_client.revoked",
        "admin.user.soft_deleted",
      ])
      .orderBy("event_type")
      .execute();
    expect(audit).toEqual([
      {
        event_type: "admin.user.soft_deleted",
        metadata: expect.objectContaining({
          priorBan: null,
          revokedApiKeys: 1,
          revokedOauthClients: 1,
        }),
      },
      {
        event_type: "api_key.revoked",
        metadata: expect.objectContaining({ apiKeyId: key.id, reason: "owner_deleted" }),
      },
      {
        event_type: "oauth_client.revoked",
        metadata: expect.objectContaining({ clientRowId: client.id, reason: "owner_deleted" }),
      },
    ]);

    await executeBulkUserAction("restore", await target(), actor());
    await expect(approve()).resolves.toEqual({ ok: true, status: "active" });

    expect((await keyRow()).status).toBe("revoked");
    expect((await clientRow()).status).toBe("revoked");
  });
});
