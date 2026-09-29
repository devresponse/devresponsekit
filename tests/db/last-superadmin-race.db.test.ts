import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as PermissionsServerModule from "@/lib/admin/permissions.server";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED race test for REVOKE-2 (F-128): two revocations aimed at the
 * platform's last two superadmins, S1 and S2, run at the same time, and
 * exactly one of them lands.
 *
 * The last-superadmin check is only as good as its row lock. Each guarded
 * path reads the surviving grants with `activeGlobalSuperuserGrants` INSIDE
 * its writing transaction, and that read's `FOR UPDATE OF` list must name
 * every relation a revocation writes. Until F-128 that was pinned only by the
 * compiled SQL text (`tests/unit/superuser-grants-lock-sql.test.ts`), which
 * cannot see the two regressions that matter at run time: a call site that
 * drops `trx` and falls back to the pool (its lock is released at once), and a
 * path writing a relation the lock does not cover (the second reader skips
 * the recheck and still counts the first side's target in its snapshot).
 * Either way both sides conclude "the other survives" and the platform is
 * left with no superadmin.
 *
 * Each case drives two REAL revocations against Postgres. The first one's
 * check is held open by a gate, inside its transaction, after the check and
 * before its write; the second then arrives, must be blocked by the first's
 * backend, and once the first commits must answer 409 `last_superadmin`. The
 * gate wraps the two exported check functions, so the routes, the status
 * core, the real predicate and the real audit writes all run unmocked; only
 * the admin guard (to inject a superadmin grant) and the rate limiter are
 * stubbed. Every guarded call site holds once, and the next one in `PATHS`
 * arrives against it, so each also arrives once.
 *
 * Not here: the ban and soft-delete paths check AFTER Better Auth has
 * committed the ban on its own connection, so what a concurrent revocation
 * meets is the ban, not their check's lock; the ban racing a check is pinned
 * in last-superadmin-sign-in.db.test.ts. Authority conferred through a group
 * is out of REVOKE-2's scope by design (docs/admin-manager.md §8.1).
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f128_`
 * and are rebuilt for every case. A superadmin elsewhere in the database who
 * can sign in would survive both revocations and let both through, so each
 * case checks for one first and says so.
 */

/**
 * Armed, the gate holds the NEXT REVOKE-2 check to return — the first side of
 * a race — and reports the backend it holds it on: the executor the call site
 * passed, or the pool when it passed none (whose lock is already gone).
 */
const gate = vi.hoisted(() => ({
  armed: null as null | { held: (pid: number) => void; release: Promise<void> },
}));

vi.mock("@/lib/admin/access-scope.server", async (importOriginal) => {
  const actual = await importOriginal<typeof AccessScopeModule>();
  const { db } = await import("@/db/database");
  const kysely = await import("kysely");
  function holdAfter<A extends unknown[]>(check: (...args: A) => Promise<boolean>) {
    return async (...args: A): Promise<boolean> => {
      const verdict = await check(...args);
      const armed = gate.armed;
      if (armed) {
        gate.armed = null;
        // Both checks take the executor as their second argument.
        const executor = (args[1] ?? db) as typeof db;
        const { rows } = await kysely.sql<{
          pid: number;
        }>`select pg_backend_pid() as pid`.execute(executor);
        armed.held(rows[0]!.pid);
        await armed.release;
      }
      return verdict;
    };
  }
  return {
    ...actual,
    wouldStripLastGlobalSuperuser: holdAfter(actual.wouldStripLastGlobalSuperuser),
    membershipCascadeStripsLastGlobalSuperuser: holdAfter(
      actual.membershipCascadeStripsLastGlobalSuperuser,
    ),
  };
});

const requireAdminMock = vi.fn();
vi.mock("@/lib/admin/permissions.server", async (importOriginal) => ({
  ...(await importOriginal<typeof PermissionsServerModule>()),
  requireAdminPermission: () => requireAdminMock(),
}));
vi.mock("@/lib/admin/rate-limit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  enforceRateLimit: () => undefined,
}));

const { db, pgPool } = await import("@/db/database");
const {
  SUPERADMIN_PERMISSION,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  activeGlobalSuperuserGrants,
} = await import("@/lib/admin/access-scope.server");
const { performAdminStatusChange } = await import("@/lib/admin-status.server");
const UserAppRoles = await import("@/app/api/administrator/users/[id]/app-roles/route");
const RolePermissions = await import("@/app/api/administrator/roles/[id]/permissions/route");
const UserMemberships = await import("@/app/api/administrator/users/[id]/memberships/route");
const OrgMembers = await import("@/app/api/administrator/organizations/[id]/members/route");
const Organization = await import("@/app/api/administrator/organizations/[id]/route");

const PREFIX = "__dbtest_f128_";
const RUN = randomUUID().slice(0, 8);
/** Plain text (no FK) on audit rows: the handle cleanup finds them by. */
const ACTOR = `${PREFIX}actor`;

/** One superadmin and every row their grant hangs off, in an org of their own. */
interface Superadmin {
  id: string;
  ba: string;
  orgId: string;
  membershipId: string;
  roleId: string;
}

const w = { s1: {} as Superadmin, s2: {} as Superadmin };

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

/**
 * An active superadmin who can sign in, holding the `superuser` marker through
 * a role of their own in an org of their own, so that each path below can
 * remove exactly one superadmin's grant: stripping the marker off S1's role or
 * suspending S1's org leaves S2's untouched.
 */
async function superadmin(key: string, permissionId: string): Promise<Superadmin> {
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org_${key}_${RUN}`, name: `F128 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: org.id, key: `${PREFIX}super_${key}`, name: `F128 ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: permissionId })
    .execute();
  const ba = `${PREFIX}ba_${key}_${RUN}`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [ba, `F128 ${key}`, `${PREFIX}${key}_${RUN}@dbtest.local`],
  );
  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${key}_${RUN}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const membership = await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: org.id, app_user_id: user.id, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: user.id, organization_id: org.id, role_id: role.id })
    .execute();
  return { id: user.id, ba, orgId: org.id, membershipId: membership.id, roleId: role.id };
}

async function seed(): Promise<void> {
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
  w.s1 = await superadmin("s1", perm.id);
  w.s2 = await superadmin("s2", perm.id);
}

/** Which of this suite's superadmins `activeGlobalSuperuserGrants` still counts. */
async function survivors(): Promise<string[]> {
  const names = new Map([
    [w.s1.id, "s1"],
    [w.s2.id, "s2"],
  ]);
  const grants = await activeGlobalSuperuserGrants();
  return grants
    .map((g) => names.get(g.appUserId))
    .filter((n): n is string => n !== undefined)
    .sort();
}

/** Signable grants outside this suite: any one of them survives both revocations. */
async function foreignSignableGrants(): Promise<number> {
  const grants = await activeGlobalSuperuserGrants();
  return grants.filter((g) => g.appUserId !== w.s1.id && g.appUserId !== w.s2.id).length;
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

/** A superadmin's cookie session: passes every rank and conferral guard. */
const SUPERADMIN_GRANT = {
  betterAuthUserId: ACTOR,
  access: {
    appUserId: null,
    primaryEmail: "actor@dbtest.local",
    status: "active",
    organizationId: null,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: [
      "admin.roles.assign",
      "admin.roles.update",
      "admin.users.update",
      "admin.orgs.update",
      SUPERADMIN_PERMISSION,
    ],
    orgBound: false,
  } satisfies AuthStatusModule.UserAccessContext,
  requestId: `${PREFIX}req`,
  callerKind: "cookie" as const,
  credentialId: null,
  grantedScopes: null,
};

function req(method: string, path: string, body: unknown): NextRequest {
  const url = `http://test.local/api/administrator${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** "ok", "last_superadmin", or the status and code of anything else. */
async function outcome(res: Response): Promise<string> {
  if (res.ok) return "ok";
  const body = (await res.json()) as { error?: string };
  return res.status === 409 && body.error === LAST_SUPERADMIN_ERROR
    ? "last_superadmin"
    : `${res.status} ${body.error}`;
}

interface Path {
  name: string;
  /** Removes `who`'s grant, and nobody else's. */
  revoke: (who: Superadmin) => Promise<string>;
}

/**
 * Every call site of the REVOKE-2 check outside the ban and soft-delete paths,
 * with the relation(s) among the locked ones that each one writes.
 */
const PATHS: Path[] = [
  {
    // app_user_roles
    name: "DELETE /users/[id]/app-roles",
    revoke: async (who) =>
      outcome(
        await UserAppRoles.DELETE(
          req("DELETE", `/users/${who.id}/app-roles`, {
            roleId: who.roleId,
            organizationId: who.orgId,
          }),
          params(who.id),
        ),
      ),
  },
  {
    // app_organization_memberships
    name: "PATCH /users/[id]/memberships",
    revoke: async (who) =>
      outcome(
        await UserMemberships.PATCH(
          req("PATCH", `/users/${who.id}/memberships`, {
            membershipIds: [who.membershipId],
            status: "suspended",
          }),
          params(who.id),
        ),
      ),
  },
  {
    // app_role_permissions
    name: "DELETE /roles/[id]/permissions",
    revoke: async (who) =>
      outcome(
        await RolePermissions.DELETE(
          req("DELETE", `/roles/${who.roleId}/permissions`, { ids: [SUPERADMIN_PERMISSION] }),
          params(who.roleId),
        ),
      ),
  },
  {
    // app_organization_memberships
    name: "PATCH /organizations/[id]/members",
    revoke: async (who) =>
      outcome(
        await OrgMembers.PATCH(
          req("PATCH", `/organizations/${who.orgId}/members`, {
            membershipIds: [who.membershipId],
            status: "blocked",
          }),
          params(who.orgId),
        ),
      ),
  },
  {
    // app_organizations
    name: "PATCH /organizations/[id]",
    revoke: async (who) =>
      outcome(
        await Organization.PATCH(
          req("PATCH", `/organizations/${who.orgId}`, { status: "suspended" }),
          params(who.orgId),
        ),
      ),
  },
  {
    // app_organization_memberships and app_user_roles (F-12)
    name: "DELETE /users/[id]/memberships",
    revoke: async (who) =>
      outcome(
        await UserMemberships.DELETE(
          req("DELETE", `/users/${who.id}/memberships`, { membershipIds: [who.membershipId] }),
          params(who.id),
        ),
      ),
  },
  {
    // app_users and app_organization_memberships: the core behind both status
    // routes and the bulk block / suspend.
    name: "performAdminStatusChange (block)",
    revoke: async (who) => {
      const result = await performAdminStatusChange({
        actorBetterAuthUserId: ACTOR,
        scope: { kind: "all" },
        targetAppUserId: who.id,
        newStatus: "blocked",
        newMembershipStatus: "blocked",
        eventType: "admin.user.blocked",
      });
      return result.ok ? "ok" : result.error;
    },
  },
  {
    // app_organization_memberships and app_user_roles (F-12)
    name: "DELETE /organizations/[id]/members",
    revoke: async (who) =>
      outcome(
        await OrgMembers.DELETE(
          req("DELETE", `/organizations/${who.orgId}/members`, {
            membershipIds: [who.membershipId],
          }),
          params(who.orgId),
        ),
      ),
  },
];

/**
 * Runs `first` on S1 and holds it right after its REVOKE-2 check, starts
 * `second` on S2, waits until `second` is blocked by `first`'s backend, then
 * lets `first` finish. Fails fast, rather than timing out, when `first` never
 * reaches its check or `second` finishes while `first` still holds it.
 */
async function race(first: Path, second: Path): Promise<{ first: string; second: string }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => (held = resolve));
  gate.armed = { held, release: released };

  const runs: Promise<string>[] = [];
  try {
    const firstRun = first.revoke(w.s1);
    runs.push(firstRun);
    const holder = await Promise.race([
      holding,
      firstRun.then((o) =>
        Promise.reject(new Error(`${first.name} answered "${o}" without reaching its check`)),
      ),
    ]);
    const secondRun = second.revoke(w.s2);
    runs.push(secondRun);
    await Promise.race([
      waitUntilBlockedBy(holder),
      secondRun.then((o) =>
        Promise.reject(
          new Error(
            `${second.name} answered "${o}" while ${first.name} held its check: nothing serialized them`,
          ),
        ),
      ),
    ]);
  } finally {
    gate.armed = null;
    release();
    // Nothing left running into the next case's cleanup.
    await Promise.allSettled(runs);
  }
  return { first: await runs[0]!, second: await runs[1]! };
}

beforeEach(async () => {
  await cleanup();
  await seed();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue(SUPERADMIN_GRANT);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

const RACES = PATHS.map((first, i) => ({ first, second: PATHS[(i + 1) % PATHS.length]! }));

describe("REVOKE-2 (F-128): two revocations race for the last two superadmins", () => {
  it.each(RACES)(
    "$first.name holds its check; $second.name then waits for it and is refused",
    async ({ first, second }) => {
      expect(await foreignSignableGrants(), "another signable superadmin exists in this DB").toBe(
        0,
      );
      expect(await survivors()).toEqual(["s1", "s2"]);

      await expect(race(first, second)).resolves.toEqual({
        first: "ok",
        second: "last_superadmin",
      });

      // Exactly one grant went, and the refusal is on the record.
      expect(await survivors()).toEqual(["s2"]);
      const denials = await db
        .selectFrom("app_audit_events")
        .select(["outcome", "reason"])
        .where("event_type", "=", LAST_SUPERADMIN_EVENT)
        .where("actor_better_auth_user_id", "=", ACTOR)
        .execute();
      expect(denials).toEqual([{ outcome: "denied", reason: "last_global_superuser" }]);
    },
  );
});
