import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type KyselyPlugin } from "kysely";
import type { PoolClient } from "pg";
import type * as DatabaseModule from "@/db/database";

/**
 * DB-BACKED proof of F-95: sign-up provisioning, invitation acceptance and the
 * sign-in re-evaluation each write several rows, and used to write them as
 * separate statements on the pool, with plain inserts.
 *
 *   1. A failure between the `app_users` insert and the membership insert left
 *      an account with no membership. Every later sign-in took the session
 *      hook's early return for an existing account, so nothing ever wrote it.
 *   2. Two provisionings of one identity (or of one membership) racing each
 *      other: the loser failed with 23505 instead of converging.
 *   3. A failure after an acceptance's flip left the invitation `accepted`
 *      with no membership, activation or role, and the token could not be
 *      used again.
 *   4. A membership another writer created between an acceptance's read and
 *      its insert: 23505 after the flip had committed.
 *   5. A sign-up carrying an invitation whose consume failed after the flip:
 *      the invitation was spent and the role never granted.
 *   6. A re-evaluation failing between the membership and the account
 *      activation: the account stayed pending with no pending membership left
 *      for the next sign-in to re-decide.
 *   7. The fixes for 1-6 hold rows until commit, so the re-evaluation and the
 *      acceptance must take them in the administrator transactions' order, or
 *      a race with one of those deadlocks (40P01).
 *
 * Failures are injected by a Kysely plugin on the app's `db` that throws just
 * before a chosen statement is sent, as a dropped connection or a statement
 * timeout would at that point; everything else (Postgres, the unique indexes,
 * the audit writer) is real. The races hold the competing write open on a
 * second connection, start the call, wait until Postgres reports it blocked on
 * that connection, then commit. Driven by `pnpm test:db`
 * (vitest.db.config.ts); fixtures use `__dbtest_f95_<run>_` and self-clean.
 */

/** The SQL prefix of the next statement to fail, or null. Fires once. */
const fault = vi.hoisted(() => ({ before: null as string | null }));

vi.mock("@/db/database", async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  const { PostgresQueryCompiler } = await import("kysely");
  const compiler = new PostgresQueryCompiler();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const prefix = fault.before;
      if (prefix !== null && compiler.compileQuery(node, queryId).sql.startsWith(prefix)) {
        fault.before = null;
        throw new Error(`injected fault before: ${prefix}`);
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return { ...actual, db: actual.db.withPlugin(plugin) };
});

const { db, pgPool } = await import("@/db/database");
const { provisionUserFromAuth, reevaluatePendingActivation } =
  await import("@/lib/user-provisioning.server");
const { consumeInvitation, createInvitation, findValidInvitationByToken } =
  await import("@/lib/invitations.server");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `__dbtest_f95_${RUN}_`;
const INJECTED = /injected fault/;

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("email", "like", `${PREFIX}%`).execute();
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
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  const roles = await db
    .selectFrom("app_roles")
    .select("id")
    .where("key", "like", `${PREFIX}%`)
    .execute();
  if (roles.length > 0) {
    await db
      .deleteFrom("app_role_permissions")
      .where(
        "role_id",
        "in",
        roles.map((r) => r.id),
      )
      .execute();
  }
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

/** A fresh active org; `auto_active` gives it that sign-up policy row. */
async function newOrg(tag: string, mode?: "auto_active"): Promise<{ id: string; slug: string }> {
  const slug = `${PREFIX}${tag}`;
  const org = await db
    .insertInto("app_organizations")
    .values({ slug, name: `DBTest F-95 ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (mode) {
    await db
      .insertInto("app_organization_auth_settings")
      .values({
        organization_id: org.id,
        require_email_verification: false,
        signup_approval_mode: mode,
      })
      .execute();
  }
  return { id: org.id, slug };
}

const emailOf = (tag: string) => `${PREFIX}${tag}@dbtest.local`;

async function newUser(tag: string, status: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: `${PREFIX}${tag}`, primary_email: emailOf(tag), status })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function usersWithIdentity(tag: string): Promise<Array<{ id: string; status: string }>> {
  return db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("better_auth_user_id", "=", `${PREFIX}${tag}`)
    .execute();
}

async function membershipsOf(appUserId: string, orgId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_organization_memberships")
    .select("status")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", orgId)
    .execute();
  return rows.map((r) => r.status);
}

async function rolesOf(appUserId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_user_roles")
    .select("role_id")
    .where("app_user_id", "=", appUserId)
    .execute();
  return rows.map((r) => r.role_id);
}

async function statusOf(appUserId: string): Promise<string> {
  const row = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", appUserId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function invitationStatus(id: string): Promise<string> {
  const row = await db
    .selectFrom("app_organization_invitations")
    .select("status")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.status;
}

/**
 * An inviting org admin (the standing F-149 re-checks at acceptance) and a
 * role that carries only what they hold, so the invited role is grantable
 * (AUTHZ-3) and nothing but the injected fault can stop the grant.
 */
async function newInvitingOrg(
  tag: string,
): Promise<{ orgId: string; roleId: string; inviterId: string }> {
  const { id: orgId } = await newOrg(tag);
  const permission = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", "admin.orgs.update")
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${tag}-admin`, name: `DBTest ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: permission.id })
    .execute();
  const inviterTag = `${tag}-inviter`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [`${PREFIX}${inviterTag}`, `DBTest ${inviterTag}`, emailOf(inviterTag)],
  );
  const inviterId = await newUser(inviterTag, "active");
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: inviterId, status: "active" })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: inviterId, organization_id: orgId, role_id: role.id })
    .execute();
  return { orgId, roleId: role.id, inviterId };
}

/** A write held open on its own connection until `commit()`. */
interface HeldWrite {
  pid: number;
  rows: Array<Record<string, unknown>>;
  query(text: string, values: unknown[]): Promise<void>;
  commit(): Promise<void>;
}
const held: PoolClient[] = [];
async function holdOpen(text: string, values: unknown[]): Promise<HeldWrite> {
  const client = await pgPool.connect();
  held.push(client);
  const { rows: pidRows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  await client.query("begin");
  const { rows } = await client.query(text, values);
  return {
    pid: pidRows[0]!.pid,
    rows,
    async query(nextText, nextValues) {
      await client.query(nextText, nextValues);
    },
    async commit() {
      await client.query("commit");
    },
  };
}

/**
 * Resolves once a backend is waiting on `holder`'s locks (the call reached its
 * blocking statement); throws when the call settles first or nothing blocks
 * within 5s. Keyed on the holder's pid, so another suite's locks elsewhere in
 * the same database cannot satisfy it.
 */
async function blockedOn(holder: HeldWrite, call: Promise<unknown>): Promise<void> {
  let settled = false;
  void call.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200 && !settled; i++) {
    const { rows } = await pgPool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`,
      [holder.pid],
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(settled ? "the call settled without blocking" : "the call never blocked");
}

beforeEach(async () => {
  fault.before = null;
  await cleanup();
});

afterEach(async () => {
  fault.before = null;
  // A failed assertion must not leave a transaction (and its locks) open.
  for (const client of held.splice(0)) {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await pgPool.end();
  }
});

describe("F-95: sign-up provisioning writes the account and its membership together", () => {
  it("a failure between the two leaves neither, and the next sign-in provisions both", async () => {
    const org = await newOrg("rollback");
    const signUp = () =>
      provisionUserFromAuth({
        betterAuthUserId: `${PREFIX}rollback`,
        email: emailOf("rollback"),
        emailVerified: true,
        provider: "email",
        organizationHint: org.slug,
      });

    fault.before = 'insert into "app_organization_memberships"';
    await expect(signUp()).rejects.toThrow(INJECTED);
    // No account without its membership: the session hook's early return for
    // an existing account would otherwise never write the membership.
    expect(await usersWithIdentity("rollback")).toEqual([]);

    const result = await signUp();
    expect(result).toMatchObject({ organizationId: org.id, linkedExisting: false });
    expect(await membershipsOf(result.appUserId, org.id)).toEqual([result.membershipStatus]);
  });

  it("a concurrent provisioning of the same identity converges on its rows instead of 23505", async () => {
    const org = await newOrg("race-user");
    const other = await holdOpen(
      `insert into app_users (better_auth_user_id, primary_email, status)
       values ($1, $2, 'active') returning id`,
      [`${PREFIX}race-user`, emailOf("race-user")],
    );
    const otherUserId = other.rows[0]!.id as string;
    await other.query(
      `insert into app_organization_memberships (organization_id, app_user_id, status, source_provider)
       values ($1, $2, 'active', 'email')`,
      [org.id, otherUserId],
    );

    const provisioning = provisionUserFromAuth({
      betterAuthUserId: `${PREFIX}race-user`,
      email: emailOf("race-user"),
      emailVerified: true,
      provider: "email",
      organizationHint: org.slug,
    });
    await blockedOn(other, provisioning);
    await other.commit();

    await expect(provisioning).resolves.toMatchObject({
      appUserId: otherUserId,
      organizationId: org.id,
      status: "active",
      membershipStatus: "active",
      linkedExisting: true,
    });
    expect(await usersWithIdentity("race-user")).toEqual([{ id: otherUserId, status: "active" }]);
    expect(await membershipsOf(otherUserId, org.id)).toEqual(["active"]);
  });

  it("a membership inserted concurrently for an existing account converges instead of 23505", async () => {
    const org = await newOrg("race-membership");
    const userId = await newUser("race-membership", "pending_approval");
    const other = await holdOpen(
      `insert into app_organization_memberships (organization_id, app_user_id, status, source_provider)
       values ($1, $2, 'pending_approval', 'email')`,
      [org.id, userId],
    );

    const provisioning = provisionUserFromAuth({
      betterAuthUserId: `${PREFIX}race-membership`,
      email: emailOf("race-membership"),
      emailVerified: true,
      provider: "email",
      organizationHint: org.slug,
    });
    await blockedOn(other, provisioning);
    await other.commit();

    await expect(provisioning).resolves.toMatchObject({
      appUserId: userId,
      membershipStatus: "pending_approval",
      linkedExisting: true,
    });
    expect(await membershipsOf(userId, org.id)).toEqual(["pending_approval"]);
  });
});

describe("F-95: invitation acceptance commits the flip and everything it admits together", () => {
  it("a failure after the flip leaves the invitation pending and nothing admitted; accepting again succeeds", async () => {
    const { orgId, roleId, inviterId } = await newInvitingOrg("accept-rollback");
    const inviteeId = await newUser("accept-rollback-invitee", "pending_approval");
    const email = emailOf("accept-rollback-invitee");
    const created = await createInvitation({
      organizationId: orgId,
      email,
      roleId,
      invitedByAppUserId: inviterId,
    });
    const accept = async () =>
      consumeInvitation({
        invitation: (await findValidInvitationByToken(created.plaintextToken))!,
        appUser: { id: inviteeId, primaryEmail: email, status: await statusOf(inviteeId) },
        actorBetterAuthUserId: `${PREFIX}accept-rollback-invitee`,
      });

    // The role grant is the acceptance's last write: the flip, the membership
    // and the activation have all run by then.
    fault.before = 'insert into "app_user_roles"';
    await expect(accept()).rejects.toThrow(INJECTED);
    expect(await invitationStatus(created.id)).toBe("pending");
    expect(await membershipsOf(inviteeId, orgId)).toEqual([]);
    expect(await statusOf(inviteeId)).toBe("pending_approval");
    expect(await rolesOf(inviteeId)).toEqual([]);

    // The token is still live, so the invitee simply accepts again.
    await expect(accept()).resolves.toEqual({ consumed: true, roleGranted: true });
    expect(await invitationStatus(created.id)).toBe("accepted");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["active"]);
    expect(await statusOf(inviteeId)).toBe("active");
    expect(await rolesOf(inviteeId)).toEqual([roleId]);
  });

  it("activates a membership another writer created between its read and its insert, instead of 23505", async () => {
    const { orgId, inviterId } = await newInvitingOrg("accept-race");
    const inviteeId = await newUser("accept-race-invitee", "pending_approval");
    const email = emailOf("accept-race-invitee");
    const created = await createInvitation({
      organizationId: orgId,
      email,
      invitedByAppUserId: inviterId,
    });
    const invitation = (await findValidInvitationByToken(created.plaintextToken))!;
    const other = await holdOpen(
      `insert into app_organization_memberships (organization_id, app_user_id, status, source_provider)
       values ($1, $2, 'pending_approval', 'email')`,
      [orgId, inviteeId],
    );

    const accepting = consumeInvitation({
      invitation,
      appUser: { id: inviteeId, primaryEmail: email, status: "pending_approval" },
      actorBetterAuthUserId: `${PREFIX}accept-race-invitee`,
    });
    await blockedOn(other, accepting);
    await other.commit();

    await expect(accepting).resolves.toEqual({ consumed: true, roleGranted: false });
    expect(await invitationStatus(created.id)).toBe("accepted");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["active"]);
    expect(await statusOf(inviteeId)).toBe("active");
  });

  it("a sign-up whose consume fails keeps its placement and leaves the invitation acceptable", async () => {
    const { orgId, roleId, inviterId } = await newInvitingOrg("signup-consume");
    const email = emailOf("signup-consume-invitee");
    const created = await createInvitation({
      organizationId: orgId,
      email,
      roleId,
      invitedByAppUserId: inviterId,
    });

    fault.before = 'insert into "app_user_roles"';
    const result = await provisionUserFromAuth({
      betterAuthUserId: `${PREFIX}signup-consume-invitee`,
      email,
      emailVerified: true,
      provider: "email",
      invitationToken: created.plaintextToken,
    });
    // The placement commits before the consume runs, so the sign-up still
    // lands, active, in the inviting org; only the consume rolled back.
    expect(result).toMatchObject({
      organizationId: orgId,
      status: "active",
      membershipStatus: "active",
    });
    expect(await rolesOf(result.appUserId)).toEqual([]);
    expect(await invitationStatus(created.id)).toBe("pending");

    // So the invitation can still be accepted from `/invite`, and the role
    // arrives then. Before F-95 the flip had committed and the role was lost.
    await expect(
      consumeInvitation({
        invitation: (await findValidInvitationByToken(created.plaintextToken))!,
        appUser: { id: result.appUserId, primaryEmail: email, status: "active" },
        actorBetterAuthUserId: `${PREFIX}signup-consume-invitee`,
      }),
    ).resolves.toEqual({ consumed: true, roleGranted: true });
    expect(await rolesOf(result.appUserId)).toEqual([roleId]);
  });
});

describe("F-95: the sign-in re-evaluation activates the memberships and the account together", () => {
  // Failed at each write in turn: without the transaction, whichever write
  // runs first (the account, in the lock order below) stays committed when
  // the other fails.
  it.each([
    ["the account", 'update "app_users"'],
    ["the membership", 'update "app_organization_memberships"'],
  ])("a failure at %s leaves both pending, and the next sign-in activates both", async (_, at) => {
    const org = await newOrg("reevaluate", "auto_active");
    const userId = await newUser("reevaluate", "pending_approval");
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: org.id,
        app_user_id: userId,
        status: "pending_approval",
        source_provider: "email",
      })
      .execute();
    const signIn = () =>
      reevaluatePendingActivation({
        betterAuthUserId: `${PREFIX}reevaluate`,
        email: emailOf("reevaluate"),
        emailVerified: true,
        provider: "email",
      });

    fault.before = at;
    await expect(signIn()).rejects.toThrow(INJECTED);
    // Neither half on its own: an active membership under a pending account
    // could never be finished (the next sign-in re-decides only pending
    // memberships), and an active account would have skipped the re-evaluation.
    expect(await membershipsOf(userId, org.id)).toEqual(["pending_approval"]);
    expect(await statusOf(userId)).toBe("pending_approval");

    await signIn();
    expect(await membershipsOf(userId, org.id)).toEqual(["active"]);
    expect(await statusOf(userId)).toBe("active");
  });
});

/**
 * Lock order. The re-evaluation and the acceptance now hold their rows until
 * they commit, so they must take the rows they share with the administrator
 * transactions in the order those take them, or each side can hold a row the
 * other waits on: Postgres aborts one of them with 40P01, a 500. Each case
 * holds the admin transaction's first lock open on a second connection, starts
 * the call, waits until it blocks there, then runs the rest of that
 * transaction and commits. In the opposite order the rest waits on a row the
 * call already holds.
 */
type Statement = [text: string, values: unknown[]];

async function againstAdmin<T>(
  first: Statement,
  rest: Statement[],
  call: () => Promise<T>,
): Promise<T> {
  const admin = await holdOpen(...first);
  const running = call();
  await blockedOn(admin, running);
  for (const statement of rest) await admin.query(...statement);
  await admin.commit();
  return running;
}

/**
 * `performAdminStatusChange` approving the account (after its grant read):
 * the account row `FOR UPDATE`, its write, then every membership of the user.
 */
const approve = (userId: string): Statement[] => [
  ["select status from app_users where id = $1 for update", [userId]],
  ["update app_users set status = 'active', updated_at = now() where id = $1", [userId]],
  [
    `update app_organization_memberships
        set status = 'active', pre_deactivation_status = null, updated_at = now()
      where app_user_id = $1`,
    [userId],
  ],
];

async function pendingMembership(orgId: string, userId: string): Promise<void> {
  await db
    .insertInto("app_organization_memberships")
    .values({
      organization_id: orgId,
      app_user_id: userId,
      status: "pending_approval",
      source_provider: "email",
    })
    .execute();
}

describe("F-95: the re-evaluation and the acceptance take rows in the admin transactions' order", () => {
  it("a re-evaluation racing an approval: the account before its memberships", async () => {
    const org = await newOrg("lock-reevaluate", "auto_active");
    const userId = await newUser("lock-reevaluate", "pending_approval");
    await pendingMembership(org.id, userId);

    const [first, ...rest] = approve(userId);
    await expect(
      againstAdmin(first!, rest, () =>
        reevaluatePendingActivation({
          betterAuthUserId: `${PREFIX}lock-reevaluate`,
          email: emailOf("lock-reevaluate"),
          emailVerified: true,
          provider: "email",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(await statusOf(userId)).toBe("active");
    expect(await membershipsOf(userId, org.id)).toEqual(["active"]);
  });

  async function invitee(tag: string, withMembership: boolean) {
    const { orgId, inviterId } = await newInvitingOrg(tag);
    const inviteeId = await newUser(`${tag}-invitee`, "pending_approval");
    if (withMembership) await pendingMembership(orgId, inviteeId);
    const email = emailOf(`${tag}-invitee`);
    const accept = async (roleId?: string) => {
      const created = await createInvitation({
        organizationId: orgId,
        email,
        roleId,
        invitedByAppUserId: inviterId,
      });
      const invitation = (await findValidInvitationByToken(created.plaintextToken))!;
      return {
        invitationId: created.id,
        run: () =>
          consumeInvitation({
            invitation,
            appUser: { id: inviteeId, primaryEmail: email, status: "pending_approval" },
            actorBetterAuthUserId: `${PREFIX}${tag}-invitee`,
          }),
      };
    };
    return { orgId, inviteeId, accept };
  }

  it("an acceptance racing a soft-delete: the account before the membership", async () => {
    const { orgId, inviteeId, accept } = await invitee("lock-soft-delete", true);
    const { run } = await accept();

    // The soft-delete writes the account (no FOR UPDATE), then blocks every
    // membership and snapshots it (`performSoftDelete`).
    await expect(
      againstAdmin(
        [
          "update app_users set status = 'deactivated', updated_at = now() where id = $1",
          [inviteeId],
        ],
        [
          [
            `update app_organization_memberships
                set pre_deactivation_status = status, status = 'blocked', updated_at = now()
              where app_user_id = $1 and status != 'blocked'`,
            [inviteeId],
          ],
        ],
        run,
      ),
    ).resolves.toMatchObject({ consumed: true });
    // The administrator's denial stands.
    expect(await statusOf(inviteeId)).toBe("deactivated");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["blocked"]);
  });

  it("an acceptance racing an If-Match approval: the account before the invitation", async () => {
    const { orgId, inviteeId, accept } = await invitee("lock-claim", true);
    const { invitationId, run } = await accept();

    // `PATCH /api/v1/users/{id}/status` with If-Match claims the account row
    // (a plain UPDATE) before it takes it FOR UPDATE. The flip's foreign-key
    // check on `accepted_app_user_id` takes a lock the claim does not wait for
    // but the FOR UPDATE does, so the account must be locked before the flip.
    await expect(
      againstAdmin(
        ["update app_users set updated_at = now() where id = $1", [inviteeId]],
        approve(inviteeId),
        run,
      ),
    ).resolves.toEqual({ consumed: true, roleGranted: false });
    expect(await invitationStatus(invitationId)).toBe("accepted");
    expect(await statusOf(inviteeId)).toBe("active");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["active"]);
  });

  it("an acceptance racing an approval that locks the inviting org: the org before the account", async () => {
    const { orgId, inviteeId, accept } = await invitee("lock-org", false);
    const { run } = await accept();

    // `activeGlobalSuperuserGrants` locks the org of every superuser grant
    // FOR UPDATE ahead of the account; the membership insert's foreign-key
    // check needs that org row too.
    await expect(
      againstAdmin(
        ["select id from app_organizations where id = $1 for update", [orgId]],
        approve(inviteeId),
        run,
      ),
    ).resolves.toEqual({ consumed: true, roleGranted: false });
    expect(await statusOf(inviteeId)).toBe("active");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["active"]);
  });

  it("an acceptance racing a DELETE of the invited role: the role before the invitation", async () => {
    const { orgId, inviteeId, accept } = await invitee("lock-role", true);
    const role = await db
      .insertInto("app_roles")
      .values({ organization_id: orgId, key: `${PREFIX}lock-role-empty`, name: "DBTest empty" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { invitationId, run } = await accept(role.id);

    // `assertRoleNotInUse` locks the role FOR UPDATE; the DELETE then clears
    // it from the invitation (ON DELETE SET NULL). The grant's foreign-key
    // check needs the role row, so it must come before the flip.
    await expect(
      againstAdmin(
        ["select id from app_roles where id = $1 for update", [role.id]],
        [["delete from app_roles where id = $1", [role.id]]],
        run,
      ),
    ).resolves.toEqual({ consumed: true, roleGranted: false });
    expect(await invitationStatus(invitationId)).toBe("accepted");
    expect(await membershipsOf(inviteeId, orgId)).toEqual(["active"]);
    expect(await rolesOf(inviteeId)).toEqual([]);
  });
});
