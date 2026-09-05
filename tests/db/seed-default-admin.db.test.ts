import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pgPool } from "@/db/database";
import {
  LOCAL_ADMIN_NAME,
  SeedAdminRefusedError,
  seedDefaultAdminUser,
  type AuthUserRecord,
  type CreateAuthUserInput,
} from "@/db/seeds/default-admin";

/**
 * DB-BACKED integration tests for the baseline seed's default-admin step
 * (review #18) against the real `user` / `app_users` / membership / role SQL.
 *
 * The seed used to adopt ANY pre-existing Better Auth account whose email
 * matched SEED_ADMIN_EMAIL and force-escalate it on every run (verify it,
 * activate it, crown it superuser) — so an attacker who pre-registered the
 * admin address got superuser under their own password, and a blocked seed
 * admin was silently re-activated by the "safe to re-run" seed. The suite
 * pins the provenance gate that closes both:
 *
 *   1. FRESH DB — no account: the seed creates one and fully escalates it.
 *   2. RE-RUN — the seed's own admin (verified + superuser): a byte-level
 *      no-op; the creator is not called and nothing is rewritten.
 *   3. RE-RUN after an administrator BLOCKED the seed admin: still blocked.
 *   4. PRE-EXISTING FOREIGN account (unverified self-registration): REFUSED
 *      before any write — the account is untouched, no profile is created.
 *   5. Verified-but-not-superuser is ALSO foreign: refused.
 *   6. `SEED_ADMIN_ADOPT_EXISTING=1` (adoptExisting): grants conferred, but
 *      emailVerified and status are left exactly as found.
 *
 * Every row the suite creates lives under its own throwaway organization and
 * a `@seed-admin.dbtest` address, and is deleted in `afterAll`. The Better
 * Auth account is inserted directly (the seed's creator hook is injectable)
 * so the suite needs no `signUpEmail` round-trip. If the Better Auth tables
 * are absent (CI's quality job only runs `db:app:migrate`), the suite applies
 * them the same way `pnpm db:auth:migrate` does — Better Auth's migrator is
 * additive and idempotent.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 */

const RUN = randomUUID().slice(0, 8);
const ORG_SLUG = `__dbtest-seed-admin-${RUN}`;
const EMAIL_DOMAIN = "seed-admin.dbtest";

let organizationId: string;

const logs: string[] = [];
const log = (m: string) => {
  logs.push(m);
};

/** Direct `"user"` insert standing in for Better Auth's signUpEmail. */
async function insertAuthUser(input: {
  email: string;
  name?: string;
  emailVerified?: boolean;
  role?: string | null;
}): Promise<AuthUserRecord> {
  const id = `dbtest_${randomUUID()}`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, now(), now())`,
    [
      id,
      input.name ?? "Someone Else",
      input.email,
      input.emailVerified ?? false,
      input.role ?? null,
    ],
  );
  return { id, email: input.email, name: input.name ?? "Someone Else" };
}

const createAuthUser = vi.fn(async (input: CreateAuthUserInput) =>
  insertAuthUser({ email: input.email, name: input.name }),
);

type UserRow = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string | null;
  updatedAt: Date;
};
type AppUserRow = {
  id: string;
  status: string;
  status_reason: string | null;
  display_name: string | null;
  updated_at: Date;
};
type MembershipRow = { status: string; updated_at: Date };

async function readUser(email: string): Promise<UserRow | undefined> {
  return (
    await pgPool.query<UserRow>(
      `select id, email, name, "emailVerified", role, "updatedAt" from "user" where lower(email) = lower($1)`,
      [email],
    )
  ).rows[0];
}
async function readAppUser(authUserId: string): Promise<AppUserRow | undefined> {
  return (
    await pgPool.query<AppUserRow>(
      `select id, status, status_reason, display_name, updated_at from app_users where better_auth_user_id = $1`,
      [authUserId],
    )
  ).rows[0];
}
async function readMembership(appUserId: string): Promise<MembershipRow | undefined> {
  return (
    await pgPool.query<MembershipRow>(
      `select status, updated_at from app_organization_memberships
        where organization_id = $1 and app_user_id = $2`,
      [organizationId, appUserId],
    )
  ).rows[0];
}
async function readRoleKeys(appUserId: string): Promise<string[]> {
  return (
    await pgPool.query<{ key: string }>(
      `select r.key from app_user_roles ur join app_roles r on r.id = ur.role_id
        where ur.app_user_id = $1 and ur.organization_id = $2 order by r.key`,
      [appUserId, organizationId],
    )
  ).rows.map((r) => r.key);
}
async function snapshot(email: string) {
  const user = await readUser(email);
  const appUser = user ? await readAppUser(user.id) : undefined;
  const membership = appUser ? await readMembership(appUser.id) : undefined;
  const roles = appUser ? await readRoleKeys(appUser.id) : [];
  return { user, appUser, membership, roles };
}

async function ensureBetterAuthTables() {
  const present = (
    await pgPool.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.tables
         where table_schema = current_schema() and table_name = 'user') as present`,
    )
  ).rows[0]?.present;
  if (present) return;
  const [{ auth }, { getMigrations }] = await Promise.all([
    import("@/lib/auth"),
    import("better-auth/db/migration"),
  ]);
  const { runMigrations } = await getMigrations(
    auth.options as Parameters<typeof getMigrations>[0],
  );
  await runMigrations();
}

async function cleanupSuiteRows() {
  // FK order: roles → memberships → profiles → auth users → org roles → org.
  await pgPool.query(
    `delete from app_user_roles where app_user_id in
       (select id from app_users where primary_email like $1)`,
    [`%@${EMAIL_DOMAIN}`],
  );
  await pgPool.query(
    `delete from app_organization_memberships where app_user_id in
       (select id from app_users where primary_email like $1)`,
    [`%@${EMAIL_DOMAIN}`],
  );
  await pgPool.query(`delete from app_users where primary_email like $1`, [`%@${EMAIL_DOMAIN}`]);
  await pgPool.query(`delete from "user" where email like $1`, [`%@${EMAIL_DOMAIN}`]);
}

beforeAll(async () => {
  await ensureBetterAuthTables();
  organizationId = (
    await pgPool.query<{ id: string }>(
      `insert into app_organizations (slug, name, status, is_default)
       values ($1, $2, 'active', false) returning id`,
      [ORG_SLUG, `Seed-admin test org ${RUN}`],
    )
  ).rows[0]!.id;
  for (const key of ["admin", "admin.platform", "superuser"]) {
    await pgPool.query(`insert into app_roles (organization_id, key, name) values ($1, $2, $3)`, [
      organizationId,
      key,
      key,
    ]);
  }
});

afterAll(async () => {
  await cleanupSuiteRows();
  await pgPool.query(`delete from app_roles where organization_id = $1`, [organizationId]);
  await pgPool.query(`delete from app_organizations where id = $1`, [organizationId]);
  await pgPool.end();
});

beforeEach(() => {
  logs.length = 0;
  createAuthUser.mockClear();
});

function run(email: string, adoptExisting = false) {
  return seedDefaultAdminUser(
    pgPool,
    organizationId,
    { email, password: "irrelevant-for-the-stub", adoptExisting, createAuthUser },
    log,
  );
}

describe("seedDefaultAdminUser (DB-backed, review #18)", () => {
  it("fresh DB: creates the account and fully escalates it", async () => {
    const email = `fresh-${RUN}@${EMAIL_DOMAIN}`;

    await expect(run(email)).resolves.toBe("created");

    expect(createAuthUser).toHaveBeenCalledTimes(1);
    expect(createAuthUser).toHaveBeenCalledWith({
      email,
      password: "irrelevant-for-the-stub",
      name: LOCAL_ADMIN_NAME,
    });
    const { user, appUser, membership, roles } = await snapshot(email);
    expect(user).toMatchObject({ emailVerified: true, role: "admin" });
    expect(appUser).toMatchObject({
      status: "active",
      status_reason: null,
      display_name: LOCAL_ADMIN_NAME,
    });
    expect(membership).toMatchObject({ status: "active" });
    expect(roles).toEqual(["admin", "admin.platform", "superuser"]);
    expect(logs.join("\n")).toContain(`ensured local admin ${email} (created)`);
  });

  it("re-run over the seed's own admin: no-op — creator not called, nothing rewritten", async () => {
    const email = `rerun-${RUN}@${EMAIL_DOMAIN}`;
    await run(email);
    const before = await snapshot(email);
    createAuthUser.mockClear();

    await expect(run(email)).resolves.toBe("reconciled");

    expect(createAuthUser).not.toHaveBeenCalled();
    const after = await snapshot(email);
    expect(after).toEqual(before);
    expect(after.user!.updatedAt.getTime()).toBe(before.user!.updatedAt.getTime());
    expect(after.appUser!.updated_at.getTime()).toBe(before.appUser!.updated_at.getTime());
    expect(after.membership!.updated_at.getTime()).toBe(before.membership!.updated_at.getTime());
  });

  it("re-run after an administrator blocked the seed admin: stays blocked (never re-activated)", async () => {
    const email = `blocked-${RUN}@${EMAIL_DOMAIN}`;
    await run(email);
    const { appUser } = await snapshot(email);
    // What the admin block path writes (user-actions.server.ts / admin-status
    // .server.ts): user AND membership both go to `blocked`. Every production
    // path writes `blocked`; `deactivated` is not a membership status at all
    // (MEMBERSHIP_STATUS_VALUES), and 0005's CHECK now rejects it.
    await pgPool.query(
      `update app_users set status = 'blocked', status_reason = 'abuse' where id = $1`,
      [appUser!.id],
    );
    await pgPool.query(
      `update app_organization_memberships set status = 'blocked'
        where organization_id = $1 and app_user_id = $2`,
      [organizationId, appUser!.id],
    );
    const before = await snapshot(email);
    logs.length = 0;

    await expect(run(email)).resolves.toBe("reconciled");

    const after = await snapshot(email);
    expect(after).toEqual(before);
    expect(after.appUser).toMatchObject({ status: "blocked", status_reason: "abuse" });
    expect(after.membership).toMatchObject({ status: "blocked" });
    expect(logs.join("\n")).toContain(`admin ${email} left as configured (status=blocked)`);
  });

  it("pre-existing foreign account (unverified self-registration): REFUSED, nothing changed", async () => {
    const email = `attacker-${RUN}@${EMAIL_DOMAIN}`;
    await insertAuthUser({ email, name: "Attacker", emailVerified: false });
    const before = await snapshot(email);
    expect(before.appUser).toBeUndefined();

    await expect(run(email)).rejects.toBeInstanceOf(SeedAdminRefusedError);
    await expect(run(email)).rejects.toThrow(/REFUSED to escalate pre-existing account/);
    await expect(run(email)).rejects.toThrow(/SEED_ADMIN_ADOPT_EXISTING=1/);

    expect(createAuthUser).not.toHaveBeenCalled();
    const after = await snapshot(email);
    expect(after).toEqual(before);
    expect(after.user).toMatchObject({ emailVerified: false, role: null, name: "Attacker" });
    expect(after.appUser).toBeUndefined();
    expect(after.roles).toEqual([]);
  });

  it("pre-existing VERIFIED account that is not a superuser is still foreign: REFUSED", async () => {
    const email = `member-${RUN}@${EMAIL_DOMAIN}`;
    const authUser = await insertAuthUser({ email, name: "Member", emailVerified: true });
    // An ordinary active member profile, no superuser role.
    await pgPool.query(
      `insert into app_users (better_auth_user_id, primary_email, display_name, status)
       values ($1, $2, $3, 'active')`,
      [authUser.id, email, "Member"],
    );
    const before = await snapshot(email);

    await expect(run(email)).rejects.toThrow(/emailVerified=true, superuser=false/);

    expect(await snapshot(email)).toEqual(before);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("SEED_ADMIN_ADOPT_EXISTING=1: confers the grants but leaves emailVerified and status as found", async () => {
    const email = `adopt-${RUN}@${EMAIL_DOMAIN}`;
    const authUser = await insertAuthUser({ email, name: "Owner", emailVerified: false });
    // `pending_approval` is the real not-yet-active status (APP_USER_STATUS_VALUES,
    // pinned by 0005's CHECK); the previous `pending_verification` never existed.
    await pgPool.query(
      `insert into app_users (better_auth_user_id, primary_email, display_name, status, status_reason)
       values ($1, $2, $3, 'pending_approval', 'awaiting email')`,
      [authUser.id, email, "Owner"],
    );

    await expect(run(email, true)).resolves.toBe("adopted");

    expect(createAuthUser).not.toHaveBeenCalled();
    const { user, appUser, membership, roles } = await snapshot(email);
    expect(user).toMatchObject({ emailVerified: false, role: "admin", name: "Owner" });
    expect(appUser).toMatchObject({
      status: "pending_approval",
      status_reason: "awaiting email",
      display_name: "Owner",
    });
    expect(membership).toMatchObject({ status: "active" });
    expect(roles).toEqual(["admin", "admin.platform", "superuser"]);
    expect(logs.join("\n")).toContain("WARNING: adopting pre-existing account");

    // Once adopted it is still not "the seed's own admin" (unverified), so a
    // plain re-run refuses again rather than silently keeping the escalation path open.
    await expect(run(email)).rejects.toBeInstanceOf(SeedAdminRefusedError);
  });
});
