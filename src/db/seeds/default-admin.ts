/**
 * Default admin account step of the baseline seed (`seed-local.ts`).
 *
 * Creates the first administrator from `SEED_ADMIN_EMAIL` /
 * `SEED_ADMIN_PASSWORD` and escalates it: pre-verified Better Auth account
 * with the `admin` role (impersonation), an ACTIVE `app_users` profile, an
 * ACTIVE default-org membership, and the `admin` + `admin.platform` +
 * `superuser` roles.
 *
 * PROVENANCE-GATED (review #18). Escalation is the maximal grant in the
 * system (global superuser across every org), so the seed only confers it on
 * an account whose provenance it can vouch for:
 *
 *   - `created`    — the seed created the Better Auth account in THIS run.
 *                    Full escalation, including `emailVerified = true` and
 *                    `status = 'active'` — the seed owns this account.
 *   - `reconciled` — a pre-existing account that is ALREADY email-verified
 *                    AND ALREADY holds the `superuser` role in the target
 *                    org: the seed's own admin from an earlier run. Missing
 *                    grants are re-inserted (`on conflict do nothing`); its
 *                    `emailVerified`, `app_users.status` and membership
 *                    status are NEVER touched — a blocked / suspended /
 *                    deactivated seed admin stays exactly as an administrator
 *                    left it. A re-run is a true no-op.
 *   - `adopted`    — any OTHER pre-existing account matching the email
 *                    (self-registered, unverified, demoted, …). REFUSED with
 *                    a loud message unless the operator sets
 *                    `SEED_ADMIN_ADOPT_EXISTING=1`. Even when adopted, its
 *                    `emailVerified` and status fields are left as found —
 *                    only the role grants are conferred.
 *
 * Without the gate, an attacker who pre-registered the exact admin address
 * on a live instance (sign-up is open under the seeded `auto_active` policy)
 * would have been silently crowned superuser under THEIR password on the
 * next seed run, and a seed admin an administrator had blocked would have
 * been silently re-activated by the "safe to re-run" seed.
 */

export const LOCAL_ADMIN_NAME = "Local Admin";

/** The slice of `pg.Pool` the seed step needs (keeps it testable with a stub). */
export interface AdminSeedQueryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string | null;
}

export interface CreateAuthUserInput {
  email: string;
  password: string;
  name: string;
}

export type DefaultAdminSeedOutcome =
  /** No account matched the email — the seed created one and escalated it. */
  | "created"
  /** The seed's own admin from an earlier run (verified + superuser) — grants ensured, nothing else touched. */
  | "reconciled"
  /** A foreign pre-existing account, escalated because `SEED_ADMIN_ADOPT_EXISTING=1` was set. */
  | "adopted";

export interface SeedDefaultAdminOptions {
  /** Already trimmed + lower-cased by the caller. */
  email: string;
  password: string;
  /** `SEED_ADMIN_ADOPT_EXISTING=1` — escalate a pre-existing account the seed cannot vouch for. */
  adoptExisting: boolean;
  /**
   * Creates the Better Auth account. Defaults to Better Auth's `signUpEmail`
   * (which hashes the password and writes `user` + `account`); injectable so
   * the DB-backed tests can create the row directly.
   */
  createAuthUser?: (input: CreateAuthUserInput) => Promise<AuthUserRecord>;
}

/**
 * Thrown when the email matches a pre-existing account the seed did not
 * create and cannot recognise as its own. `seed-local.ts` lets it propagate,
 * so the process exits non-zero with the message on stderr.
 */
export class SeedAdminRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedAdminRefusedError";
  }
}

async function createAuthUserWithBetterAuth(input: CreateAuthUserInput): Promise<AuthUserRecord> {
  const { auth } = await import("@/lib/auth");
  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const created = await auth.api.signUpEmail({
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      rememberMe: false,
    },
    headers: new Headers({
      host: new URL(baseUrl).host,
      origin: baseUrl,
    }),
  });
  return { id: created.user.id, email: created.user.email, name: created.user.name };
}

interface ExistingAuthUserRow extends AuthUserRecord {
  emailVerified: boolean;
}

/**
 * Ensures the default admin exists and holds the seeded grants — see the
 * module docblock for the provenance rules. Throws `SeedAdminRefusedError`
 * BEFORE any write when the account is foreign and adoption is not enabled.
 */
export async function seedDefaultAdminUser(
  pool: AdminSeedQueryable,
  organizationId: string,
  options: SeedDefaultAdminOptions,
  log: (message: string) => void = console.log,
): Promise<DefaultAdminSeedOutcome> {
  const { email, password, adoptExisting } = options;
  const createAuthUser = options.createAuthUser ?? createAuthUserWithBetterAuth;

  const hasUserTable = (
    await pool.query<{ has_user_table: boolean }>(
      `select exists (
         select 1
         from information_schema.tables
         where table_schema = current_schema()
           and table_name = 'user'
       ) as has_user_table`,
    )
  ).rows[0]?.has_user_table;

  if (!hasUserTable) {
    throw new Error(
      "Better Auth schema is missing. Run `pnpm db:auth:migrate` before `pnpm db:seed`.",
    );
  }

  const roleIdByKey = new Map<string, string>();
  for (const { key, id } of (
    await pool.query<{ key: string; id: string }>(
      `select key, id from app_roles
        where organization_id = $1 and key in ('admin', 'admin.platform', 'superuser')`,
      [organizationId],
    )
  ).rows) {
    roleIdByKey.set(key, id);
  }
  const adminRoleId = roleIdByKey.get("admin");
  if (!adminRoleId) {
    throw new Error("admin role missing after seed");
  }
  const platformRoleId = roleIdByKey.get("admin.platform");
  const superuserRoleId = roleIdByKey.get("superuser");

  const existing = (
    await pool.query<ExistingAuthUserRow>(
      `select id, email, name, "emailVerified" from "user" where lower(email) = lower($1)`,
      [email],
    )
  ).rows[0];

  let authUser: AuthUserRecord;
  let outcome: DefaultAdminSeedOutcome;

  if (!existing) {
    authUser = await createAuthUser({ email, password, name: LOCAL_ADMIN_NAME });
    outcome = "created";
    log(`[seed] created Better Auth admin user ${authUser.email}`);
  } else {
    authUser = { id: existing.id, email: existing.email, name: existing.name };

    // "Already the seed's admin": verified AND already holding superuser in
    // this org. Anything less is an account the seed cannot vouch for.
    const holdsSuperuser =
      superuserRoleId !== undefined &&
      ((
        await pool.query<{ holds: boolean }>(
          `select exists (
             select 1
             from app_user_roles ur
             join app_users u on u.id = ur.app_user_id
             where u.better_auth_user_id = $1
               and ur.organization_id = $2
               and ur.role_id = $3
           ) as holds`,
          [existing.id, organizationId, superuserRoleId],
        )
      ).rows[0]?.holds ??
        false);

    if (existing.emailVerified && holdsSuperuser) {
      outcome = "reconciled";
    } else if (adoptExisting) {
      outcome = "adopted";
      log(
        `[seed] WARNING: adopting pre-existing account ${existing.email} (SEED_ADMIN_ADOPT_EXISTING=1): ` +
          `emailVerified=${existing.emailVerified}, superuser=${holdsSuperuser}. ` +
          "Its password, emailVerified flag and status are left as found; only the admin grants are conferred.",
      );
    } else {
      throw new SeedAdminRefusedError(
        `[seed] REFUSED to escalate pre-existing account ${existing.email} matching SEED_ADMIN_EMAIL: ` +
          `it was not created by this seed and is not already a verified superuser ` +
          `(emailVerified=${existing.emailVerified}, superuser=${holdsSuperuser}). ` +
          "Nothing was changed. If this account is really yours, re-run with SEED_ADMIN_ADOPT_EXISTING=1 " +
          "to grant it the admin roles (its password and verification state stay as they are), " +
          "or point SEED_ADMIN_EMAIL at an address that is not registered yet.",
      );
    }
  }

  if (outcome === "created") {
    // The seeded admin is created pre-verified: `requireEmailVerification`
    // gates real sign-ups, but this fixture (and the e2e suite) sign in
    // directly and cannot complete an email round-trip. Only an account the
    // seed created in this run is ever verified here.
    await pool.query(`update "user" set "emailVerified" = true where id = $1`, [authUser.id]);
  }

  // `created`: the seed owns the profile — reconcile it to ACTIVE (the
  // sign-up hook is suppressed, so the row normally does not exist yet).
  // `reconciled` / `adopted`: insert only if MISSING; an existing row's
  // status / status_reason (a block, a suspension, a pending verification)
  // is never overwritten.
  const appUserUpsert =
    outcome === "created"
      ? `insert into app_users
           (better_auth_user_id, primary_email, display_name, status, status_reason, preferred_locale)
         values ($1, $2, $3, 'active', null, 'en')
         on conflict (better_auth_user_id) do update set
           primary_email = excluded.primary_email,
           display_name = excluded.display_name,
           status = 'active',
           status_reason = null,
           preferred_locale = excluded.preferred_locale,
           updated_at = now()`
      : `insert into app_users
           (better_auth_user_id, primary_email, display_name, status, status_reason, preferred_locale)
         values ($1, $2, $3, 'active', null, 'en')
         on conflict (better_auth_user_id) do nothing`;
  await pool.query(appUserUpsert, [authUser.id, authUser.email, authUser.name ?? LOCAL_ADMIN_NAME]);

  const appUser = (
    await pool.query<{ id: string; status: string }>(
      `select id, status from app_users where better_auth_user_id = $1`,
      [authUser.id],
    )
  ).rows[0];
  if (!appUser) {
    throw new Error("seeded admin app user missing after upsert");
  }
  const appUserId = appUser.id;

  const hasAuthRoleColumn = (
    await pool.query<{ has_role_column: boolean }>(
      `select exists (
         select 1
         from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'user'
           and column_name = 'role'
       ) as has_role_column`,
    )
  ).rows[0]?.has_role_column;

  // Better Auth `role = 'admin'` (admin plugin: impersonation etc.) is part of
  // the escalation, so it is written for `created` and for an explicit
  // `adopted`; a `reconciled` account is not touched at all.
  if (hasAuthRoleColumn && outcome !== "reconciled") {
    await pool.query(`update "user" set role = 'admin' where id = $1`, [authUser.id]);
  }

  const membershipUpsert =
    outcome === "created"
      ? `insert into app_organization_memberships
           (organization_id, app_user_id, status, source_provider, provider_organization_key)
         values ($1, $2, 'active', 'email', 'default')
         on conflict (organization_id, app_user_id) do update set
           status = 'active',
           source_provider = excluded.source_provider,
           provider_organization_key = excluded.provider_organization_key,
           updated_at = now()`
      : `insert into app_organization_memberships
           (organization_id, app_user_id, status, source_provider, provider_organization_key)
         values ($1, $2, 'active', 'email', 'default')
         on conflict (organization_id, app_user_id) do nothing`;
  await pool.query(membershipUpsert, [organizationId, appUserId]);

  // Role grants are additive and idempotent for every outcome. `admin` is the
  // classic org admin, `admin.platform` opens the Administrator workspace
  // (docs/admin-manager.md §6.1), and `superuser` is the default top-level
  // access level — the marker the runtime expands to the full permission set.
  for (const roleId of [adminRoleId, platformRoleId, superuserRoleId]) {
    if (!roleId) continue;
    await pool.query(
      `insert into app_user_roles (app_user_id, organization_id, role_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [appUserId, organizationId, roleId],
    );
  }

  if (outcome === "reconciled" && appUser.status !== "active") {
    log(
      `[seed] admin ${authUser.email} left as configured (status=${appUser.status}): ` +
        "the seed never re-activates an account; use Administrator → Users.",
    );
  }

  log(`[seed] ensured local admin ${authUser.email} (${outcome})`);
  return outcome;
}
