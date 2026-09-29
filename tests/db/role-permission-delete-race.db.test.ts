import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED proof of F-97: role, permission and policy writes that checked
 * and then acted without a lock. Each test holds a competing write OPEN on a
 * second connection, starts the request, waits until the request is blocked
 * on that write's locks (or has already answered), commits the competing
 * write and reads the outcome. That is the interleaving the review described,
 * made deterministic:
 *
 *   1. A group grant committed while a role DELETE is in flight: counted (409
 *      `role_in_use`) and kept. Before, the count ran on the pool before the
 *      delete, so it saw nothing, and the delete then CASCADE-deleted the
 *      grant (the DB-2 authorization loss the check exists to prevent).
 *   2. A direct assignment in the same window: 409, not a 500 (23503).
 *   3. A permission attached while its DELETE is in flight: 409
 *      `permission_in_use`, not a 500 (23503).
 *   4. Two creates of one GLOBAL role key: the loser gets 409 `key_taken` and
 *      one row exists (migration 0007's partial unique index; before it both
 *      rows committed).
 *   5. A duplicate whose computed `-copy` key is taken meanwhile: 409
 *      `key_taken`, not a 500 (23505).
 *   6. A double-submitted FIRST sign-up policy save: both succeed and one row
 *      holds the later values, not a 500 (23505) for the loser.
 *
 * Only the caller is stubbed (a superadmin cookie session); the routes, the
 * audit writer and Postgres are real. Driven by `pnpm test:db`
 * (vitest.db.config.ts); fixtures use `__dbtest_f97_` / `dbtest-f97-` and
 * self-clean.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const rolesRoute = await import("@/app/api/administrator/roles/route");
const roleRoute = await import("@/app/api/administrator/roles/[id]/route");
const duplicateRoute = await import("@/app/api/administrator/roles/[id]/duplicate/route");
const permissionRoute = await import("@/app/api/administrator/permissions/[id]/route");
const { upsertOrgAuthSettings } = await import("@/lib/admin/auth-settings.server");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `__dbtest_f97_${RUN}_`;
const ORG_PREFIX = `dbtest-f97-${RUN}-`;
/** Plain-text actor id (no FK): also the handle cleanup finds audit rows by. */
const ACTOR = `${PREFIX}admin`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-f97-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [
    "admin.roles.create",
    "admin.roles.delete",
    "admin.permissions.manage",
    "superuser",
  ],
};

function req(path: string, method: string, body?: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** A write held open on its own connection until `commit()`. */
interface HeldWrite {
  commit(): Promise<void>;
}
const held: PoolClient[] = [];
async function holdOpen(text: string, values: unknown[]): Promise<HeldWrite> {
  const client = await pgPool.connect();
  held.push(client);
  await client.query("begin");
  await client.query(text, values);
  return {
    async commit() {
      await client.query("commit");
    },
  };
}

/**
 * Resolves once another backend waits on a lock (the request reached its
 * blocking statement) or once `request` has settled without blocking (what
 * the unfixed code does in some of these races). Polled, not slept.
 */
async function blockedOrSettled(request: Promise<unknown>): Promise<void> {
  let settled = false;
  void request.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 100 && !settled; i++) {
    const { rows } = await pgPool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!settled) throw new Error("the request neither blocked on a lock nor answered within 5s");
}

let seq = 0;
async function newOrg(): Promise<string> {
  seq += 1;
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${ORG_PREFIX}${seq}`, name: `DBTest F-97 ${seq}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}
async function newRole(organizationId: string | null, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: organizationId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  const roleIds = (
    await db.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`).execute()
  ).map((r) => r.id);
  if (roleIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("role_id", "in", roleIds).execute();
    await db.deleteFrom("app_role_permissions").where("role_id", "in", roleIds).execute();
  }
  // Group grants cascade with their groups.
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  // Policy rows cascade with their org.
  await db.deleteFrom("app_organizations").where("slug", "like", `${ORG_PREFIX}%`).execute();
}

beforeEach(() => {
  sessionGetter.mockReset().mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockReset().mockResolvedValue(SUPERADMIN);
});

afterEach(async () => {
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

async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

describe("F-97: a role DELETE counts the grants committed while it runs", () => {
  it("a GROUP grant committed mid-delete is a 409 and survives (no cascade)", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "grouped");
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgId, key: `${PREFIX}grp`, name: "DBTest F-97 group" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const grant = await holdOpen(
      `insert into app_group_roles (group_id, role_id) values ($1, $2)`,
      [group.id, roleId],
    );
    const deleting = roleRoute.DELETE(req(`/roles/${roleId}`, "DELETE"), idCtx(roleId));
    await blockedOrSettled(deleting);
    await grant.commit();
    const res = await deleting;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await errorOf(res)).toBe("role_in_use");
    const grants = await db
      .selectFrom("app_group_roles")
      .select("group_id")
      .where("role_id", "=", roleId)
      .execute();
    expect(grants).toEqual([{ group_id: group.id }]);
    const blocked = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "reason"])
      .where("actor_better_auth_user_id", "=", ACTOR)
      .where("event_type", "like", "admin.role.delete%")
      .execute();
    expect(blocked).toEqual([{ event_type: "admin.role.delete_blocked", reason: "role_in_use" }]);
  });

  it("a DIRECT assignment committed mid-delete is a 409, not a 500", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "direct");
    const user = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}u`,
        primary_email: `${PREFIX}u@f97.dbtest`,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const grant = await holdOpen(
      `insert into app_user_roles (app_user_id, organization_id, role_id) values ($1, $2, $3)`,
      [user.id, orgId, roleId],
    );
    const deleting = roleRoute.DELETE(req(`/roles/${roleId}`, "DELETE"), idCtx(roleId));
    await blockedOrSettled(deleting);
    await grant.commit();
    const res = await deleting;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await errorOf(res)).toBe("role_in_use");
    expect(
      await db.selectFrom("app_roles").select("id").where("id", "=", roleId).executeTakeFirst(),
    ).toEqual({ id: roleId });
  });

  it("an unreferenced role is still deleted, with its permission rows", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "unused");
    const perm = await db
      .insertInto("app_permissions")
      .values({ key: `${PREFIX}perm-unused`, description: "DBTest F-97" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: roleId, permission_id: perm.id })
      .execute();

    const res = await roleRoute.DELETE(req(`/roles/${roleId}`, "DELETE"), idCtx(roleId));

    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      await db.selectFrom("app_roles").select("id").where("id", "=", roleId).executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await db
        .selectFrom("app_role_permissions")
        .select("role_id")
        .where("role_id", "=", roleId)
        .execute(),
    ).toEqual([]);
  });
});

describe("F-97: a permission DELETE counts the attachments committed while it runs", () => {
  it("a permission attached mid-delete is a 409 permission_in_use, not a 500", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "holder");
    const perm = await db
      .insertInto("app_permissions")
      .values({ key: `${PREFIX}perm-raced`, description: "DBTest F-97" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const attach = await holdOpen(
      `insert into app_role_permissions (role_id, permission_id) values ($1, $2)`,
      [roleId, perm.id],
    );
    const deleting = permissionRoute.DELETE(
      req(`/permissions/${perm.id}`, "DELETE"),
      idCtx(perm.id),
    );
    await blockedOrSettled(deleting);
    await attach.commit();
    const res = await deleting;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await errorOf(res)).toBe("permission_in_use");
    expect(
      await db
        .selectFrom("app_permissions")
        .select("id")
        .where("id", "=", perm.id)
        .executeTakeFirst(),
    ).toEqual({ id: perm.id });
  });
});

describe("F-97: concurrent creates of one role key", () => {
  it("two creates of one GLOBAL key: the loser gets 409 key_taken and one row exists", async () => {
    const key = `${PREFIX}global`;
    const first = await holdOpen(
      `insert into app_roles (organization_id, key, name) values (null, $1, 'first')`,
      [key],
    );
    const creating = rolesRoute.POST(
      req("/roles", "POST", { key, name: "second", organizationId: null }),
    );
    await blockedOrSettled(creating);
    await first.commit();
    const res = await creating;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await errorOf(res)).toBe("key_taken");
    const rows = await db
      .selectFrom("app_roles")
      .select("name")
      .where("organization_id", "is", null)
      .where("key", "=", key)
      .execute();
    expect(rows).toEqual([{ name: "first" }]);
  });

  it("a duplicate whose -copy key is taken meanwhile answers 409 key_taken, not a 500", async () => {
    const orgId = await newOrg();
    const sourceId = await newRole(orgId, "source");
    const copyKey = `${PREFIX}source-copy`;
    const rival = await holdOpen(
      `insert into app_roles (organization_id, key, name) values ($1, $2, 'rival')`,
      [orgId, copyKey],
    );
    const duplicating = duplicateRoute.POST(
      req(`/roles/${sourceId}/duplicate`, "POST"),
      idCtx(sourceId),
    );
    await blockedOrSettled(duplicating);
    await rival.commit();
    const res = await duplicating;

    expect(res.status, await res.clone().text()).toBe(409);
    expect(await errorOf(res)).toBe("key_taken");
    const copies = await db
      .selectFrom("app_roles")
      .select("name")
      .where("organization_id", "=", orgId)
      .where("key", "=", copyKey)
      .execute();
    expect(copies).toEqual([{ name: "rival" }]);
  });
});

describe("F-97: a double-submitted first sign-up policy save", () => {
  it("both saves succeed and the org has one row with the later values", async () => {
    const orgId = await newOrg();
    const firstSave = await holdOpen(
      `insert into app_organization_auth_settings
         (organization_id, require_email_verification, signup_approval_mode, updated_by)
       values ($1, false, 'auto_active', $2)`,
      [orgId, `${PREFIX}first`],
    );
    const secondSave = upsertOrgAuthSettings(
      orgId,
      {
        requireEmailVerification: true,
        signupApprovalMode: "admin_approval",
        allowedAuthMethods: ["email"],
        autoApproveEmailDomains: null,
      },
      ACTOR,
    );
    await blockedOrSettled(secondSave);
    await firstSave.commit();
    await expect(secondSave).resolves.toBeUndefined();

    const rows = await db
      .selectFrom("app_organization_auth_settings")
      .select([
        "require_email_verification",
        "signup_approval_mode",
        "allowed_auth_methods",
        "updated_by",
      ])
      .where("organization_id", "=", orgId)
      .execute();
    expect(rows).toEqual([
      {
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: ["email"],
        updated_by: ACTOR,
      },
    ]);
  });
});
