import "dotenv/config";
import { Pool } from "pg";
import { ADMIN_PERMISSION_CATALOG, ANY_ADMIN_PERMISSION } from "@/lib/admin/permissions";

/**
 * `dev_init` — OPTIONAL development / testing seed.
 *
 * Where `seed-local.ts` provisions the single canonical local admin, this
 * script loads a richer fixture for exercising multi-organization,
 * multi-role scenarios: three organizations, each with a superuser, an
 * organization administrator, and five regular users (21 accounts total).
 *
 * It is **idempotent** — every write is `on conflict do nothing`/`do update`
 * and Better Auth users are created check-then-create — so it is safe to run
 * repeatedly. It assumes the schema already exists (`pnpm db:auth:migrate` +
 * `pnpm db:app:migrate`); it does not create tables.
 *
 * Every account is created **pre-approved** (`active`) and pinned to its
 * assigned organization, so the accounts never sit in `pending_approval` —
 * see step 6 in `ensureUser`, which removes the stray `default`-org
 * membership that sign-up auto-provisioning would otherwise leave behind.
 *
 * Run with:  `pnpm db:seed:dev`
 *
 * Every account shares one password (`DEV_SEED_PASSWORD`, default
 * `DevPassword123!`). These are deliberately weak, known credentials for a
 * disposable database — the script refuses to run under
 * `NODE_ENV=production` unless `DEV_SEED_ALLOW_PROD=1` is set.
 *
 * Role mapping (per organization):
 *   - `superuser@<org>`  → `superuser` role — holds the `superuser`
 *     permission, i.e. a cross-organization superadmin (ADR-0001).
 *   - `orgadmin@<org>`   → `admin.platform` role — the full `admin.*`
 *     catalog but NO `superuser`, so it is scoped to its own organization.
 *   - `user1..5@<org>`   → `member` role — `shell.view` only (a plain user).
 */

const DEFAULT_DEV_PASSWORD = "DevPassword123!";
const devPassword = process.env.DEV_SEED_PASSWORD?.trim() || DEFAULT_DEV_PASSWORD;

interface DevOrg {
  slug: string;
  name: string;
  /** Email domain for this org's users, e.g. `orga.local`. */
  domain: string;
}

/** App role assigned to a dev user. */
type RoleKey = "member" | "admin.platform" | "superuser";

interface DevUser {
  email: string;
  displayName: string;
  role: RoleKey;
  /** Grant the Better Auth admin role (enables ban / impersonation testing). */
  betterAuthAdmin: boolean;
}

const ORGS: ReadonlyArray<DevOrg> = [
  { slug: "org-a", name: "ORG A", domain: "orga.local" },
  { slug: "org-b", name: "ORG B", domain: "orgb.local" },
  { slug: "org-c", name: "ORG C", domain: "orgc.local" },
];

function usersForOrg(org: DevOrg): DevUser[] {
  const users: DevUser[] = [
    {
      email: `superuser@${org.domain}`,
      displayName: `${org.name} Superuser`,
      role: "superuser",
      betterAuthAdmin: true,
    },
    {
      email: `orgadmin@${org.domain}`,
      displayName: `${org.name} Admin`,
      role: "admin.platform",
      betterAuthAdmin: true,
    },
  ];
  for (let n = 1; n <= 5; n++) {
    users.push({
      email: `user${n}@${org.domain}`,
      displayName: `${org.name} User ${n}`,
      role: "member",
      betterAuthAdmin: false,
    });
  }
  return users;
}

// Base permissions NOT covered by ADMIN_PERMISSION_CATALOG. Mirrors the set
// seeded by `seed-local.ts`; `shell.view` in particular gates the secure
// shell, so a `member` user without it could not sign in usefully.
const BASE_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["shell.view", "View the secure shell"],
  ["audit.view", "Read the audit log"],
  [
    "superuser",
    "Superuser access level — full unrestricted access to every part of the application",
  ],
];

// Standard per-organization roles (identical to `seed-local.ts`). The full
// set is created for every org so role-management scenarios have something to
// work with; `dev_init` only assigns `member` / `admin.platform` / `superuser`.
const ROLE_DEFS: ReadonlyArray<{ key: string; name: string; permissions: readonly string[] }> = [
  { key: "member", name: "Member", permissions: ["shell.view"] },
  {
    key: "admin",
    name: "Administrator",
    permissions: ["shell.view", "admin.users.manage", "audit.view"],
  },
  {
    key: "admin.platform",
    name: "Platform Administrator",
    permissions: ["shell.view", ...ANY_ADMIN_PERMISSION],
  },
  {
    key: "superuser",
    name: "Superuser",
    // Authority comes from the `superuser` MARKER post-hardening (PR #97):
    // getUserAccessContext synthesizes the full set for any holder and the
    // admin gate short-circuits on isSuperadmin, so the role needs only the
    // marker (+ shell.view).
    permissions: ["shell.view", "superuser"],
  },
];

async function assertSchema(pool: Pool): Promise<void> {
  const hasUserTable = (
    await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = current_schema() and table_name = 'user'
       ) as exists`,
    )
  ).rows[0]?.exists;
  if (!hasUserTable) {
    throw new Error(
      "Schema missing. Run `pnpm db:auth:migrate` and `pnpm db:app:migrate` before `pnpm db:seed:dev`.",
    );
  }
}

async function ensurePermissions(pool: Pool): Promise<void> {
  const all = [
    ...BASE_PERMISSIONS.map(([key, description]) => ({ key, description })),
    ...ADMIN_PERMISSION_CATALOG,
  ];
  for (const { key, description } of all) {
    await pool.query(
      `insert into app_permissions (key, description) values ($1, $2)
       on conflict (key) do nothing`,
      [key, description],
    );
  }
}

async function ensureOrg(pool: Pool, org: DevOrg): Promise<string> {
  await pool.query(
    `insert into app_organizations (slug, name, status, is_default)
     values ($1, $2, 'active', false)
     on conflict (slug) do nothing`,
    [org.slug, org.name],
  );
  const id = (
    await pool.query<{ id: string }>(`select id from app_organizations where slug = $1`, [org.slug])
  ).rows[0]?.id;
  if (!id) throw new Error(`organization ${org.slug} missing after insert`);
  return id;
}

async function ensureRoles(pool: Pool, organizationId: string): Promise<void> {
  for (const def of ROLE_DEFS) {
    await pool.query(
      `insert into app_roles (organization_id, key, name) values ($1, $2, $3)
       on conflict (organization_id, key) do nothing`,
      [organizationId, def.key, def.name],
    );
    const roleId = await roleIdFor(pool, organizationId, def.key);
    for (const permKey of def.permissions) {
      const permId = (
        await pool.query<{ id: string }>(`select id from app_permissions where key = $1`, [permKey])
      ).rows[0]?.id;
      if (!permId) continue;
      await pool.query(
        `insert into app_role_permissions (role_id, permission_id) values ($1, $2)
         on conflict do nothing`,
        [roleId, permId],
      );
    }
  }
}

async function roleIdFor(pool: Pool, organizationId: string, key: string): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `select id from app_roles where organization_id = $1 and key = $2`,
      [organizationId, key],
    )
  ).rows[0]?.id;
  if (!id) throw new Error(`role ${key} missing for organization ${organizationId}`);
  return id;
}

// Resolved once on first use, then cached.
let authRoleColumn: boolean | null = null;
async function hasAuthRoleColumn(pool: Pool): Promise<boolean> {
  if (authRoleColumn !== null) return authRoleColumn;
  authRoleColumn =
    (
      await pool.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.columns
           where table_schema = current_schema()
             and table_name = 'user' and column_name = 'role'
         ) as exists`,
      )
    ).rows[0]?.exists ?? false;
  return authRoleColumn;
}

async function ensureUser(
  pool: Pool,
  org: DevOrg,
  organizationId: string,
  user: DevUser,
): Promise<void> {
  // 1. Better Auth identity — check-then-create so re-runs never duplicate.
  let authUser = (
    await pool.query<{ id: string; email: string; name: string | null }>(
      `select id, email, name from "user" where lower(email) = lower($1)`,
      [user.email],
    )
  ).rows[0];

  if (!authUser) {
    // Import lazily so a fully-seeded re-run never initializes Better Auth.
    const { auth } = await import("@/lib/auth");
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const created = await auth.api.signUpEmail({
      body: { name: user.displayName, email: user.email, password: devPassword, rememberMe: false },
      headers: new Headers({ host: new URL(baseUrl).host, origin: baseUrl }),
    });
    authUser = { id: created.user.id, email: created.user.email, name: created.user.name };
    console.log(`[dev-init]   + ${user.email}`);
  }

  // 2. Application profile — always reconcile to active.
  const appUserId = (
    await pool.query<{ id: string }>(
      `insert into app_users
         (better_auth_user_id, primary_email, display_name, status, status_reason, preferred_locale)
       values ($1, $2, $3, 'active', null, 'en')
       on conflict (better_auth_user_id) do update set
         primary_email = excluded.primary_email,
         display_name = excluded.display_name,
         status = 'active',
         status_reason = null,
         updated_at = now()
       returning id`,
      [authUser.id, authUser.email, authUser.name ?? user.displayName],
    )
  ).rows[0]?.id;
  if (!appUserId) throw new Error(`app user missing after upsert for ${user.email}`);

  // 3. Better Auth admin role (optional — enables ban / impersonation testing).
  if (user.betterAuthAdmin && (await hasAuthRoleColumn(pool))) {
    await pool.query(`update "user" set role = 'admin' where id = $1`, [authUser.id]);
  }

  // 4. Active membership in this organization.
  await pool.query(
    `insert into app_organization_memberships
       (organization_id, app_user_id, status, source_provider, provider_organization_key)
     values ($1, $2, 'active', 'email', $3)
     on conflict (organization_id, app_user_id) do update set
       status = 'active',
       updated_at = now()`,
    [organizationId, appUserId, org.slug],
  );

  // 5. Role assignment.
  const roleId = await roleIdFor(pool, organizationId, user.role);
  await pool.query(
    `insert into app_user_roles (app_user_id, organization_id, role_id) values ($1, $2, $3)
     on conflict do nothing`,
    [appUserId, organizationId, roleId],
  );

  // 6. Drop the stray membership the sign-up flow auto-provisions in the
  // fallback (`default`) org. Better Auth's `session.create.after` hook
  // (src/lib/auth.ts) runs provisionUserFromAuth during sign-up's auto
  // sign-in — BEFORE step 4 above — creating a `pending_approval` membership
  // in `default`. getUserAccessContext resolves the EARLIEST membership, so
  // that stray, earlier row would otherwise pin the account to
  // `pending_approval` and strip its assigned-org roles. These synthetic
  // users belong only to their assigned org, so remove any membership
  // elsewhere. (A later real sign-in may re-create the `default` row, but it
  // now post-dates the assigned one and never wins the earliest-membership
  // tiebreak — so the account stays active in its assigned org.)
  await pool.query(
    `delete from app_organization_memberships
     where app_user_id = $1 and organization_id <> $2`,
    [appUserId, organizationId],
  );
}

function printSummary(): void {
  const usingDefault = devPassword === DEFAULT_DEV_PASSWORD;
  console.log("\n[dev-init] complete.");
  console.log(`  Organizations: ${ORGS.map((o) => `${o.name} (${o.slug})`).join(", ")}`);
  console.log("  Per organization: superuser@, orgadmin@, user1..5@ (7 accounts)");
  console.log(`  Total: ${ORGS.length} organizations, ${ORGS.length * 7} users`);
  console.log(
    `  Password: ${usingDefault ? `${DEFAULT_DEV_PASSWORD} (override with DEV_SEED_PASSWORD)` : "(from DEV_SEED_PASSWORD)"}`,
  );
  console.log("  Sign in, e.g.: http://localhost:3000/en/sign-in  →  superuser@orga.local");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database");
  }
  if (process.env.NODE_ENV === "production" && process.env.DEV_SEED_ALLOW_PROD !== "1") {
    throw new Error(
      "Refusing to run the development seed with NODE_ENV=production — it creates known-password " +
        "accounts. Set DEV_SEED_ALLOW_PROD=1 to override (not recommended).",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await assertSchema(pool);
    await ensurePermissions(pool);
    for (const org of ORGS) {
      const organizationId = await ensureOrg(pool, org);
      await ensureRoles(pool, organizationId);
      console.log(`[dev-init] ${org.name} (${org.slug})`);
      for (const user of usersForOrg(org)) {
        await ensureUser(pool, org, organizationId, user);
      }
    }
    printSummary();
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[dev-init] FAILED", error);
  process.exit(1);
});
