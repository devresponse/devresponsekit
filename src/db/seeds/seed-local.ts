import "dotenv/config";
import type { Pool } from "pg";
import { createAppPool, ensureSchema } from "@/db/schema-config";
import { setSignupProvisioningSuppressed } from "@/lib/auth-signup-provisioning";
import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin/permissions";

const LOCAL_ADMIN_NAME = "Local Admin";

/**
 * Local development seed.
 *
 * Inserts the default organization, baseline roles and permissions, the
 * three placeholder enterprise applications referenced by the
 * application switcher, and the default local Better Auth admin user
 * described in `.env.example`.
 *
 * Tests use their own dedicated factories under `tests/helpers/`.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database");
  }
  // The seed provisions app_users + memberships itself; stand the sign-up
  // auto-provisioning hook down so signUpEmail below doesn't also run it.
  setSignupProvisioningSuppressed(true);
  const pool = createAppPool();
  let inTransaction = false;

  try {
    // Defensive: makes `current_schema()` resolve to DB_SCHEMA even if the
    // schema was not pre-created. Tables themselves come from the migrations.
    await ensureSchema(pool);

    await pool.query("begin");
    inTransaction = true;

    await pool.query(
      `insert into app_organizations (slug, name, status, is_default)
       values ('default', 'Default Organization', 'active', true)
       on conflict (slug) do nothing`,
    );

    const permissions = [
      ["shell.view", "View the secure shell"],
      ["admin.users.manage", "Approve, block, suspend, reactivate users"],
      ["audit.view", "Read the audit log"],
      [
        "superuser",
        "Superuser access level — full unrestricted access to every part of the application",
      ],
    ];
    for (const [key, description] of permissions) {
      await pool.query(
        `insert into app_permissions (key, description) values ($1, $2)
         on conflict (key) do nothing`,
        [key, description],
      );
    }

    // Administrator-app permission catalog (docs/admin-manager.md §6.1).
    // Sourced from the single canonical list in
    // `src/lib/admin/permissions.server.ts` so the seed cannot drift
    // from the runtime check. Idempotent — `on conflict (key) do nothing`.
    for (const { key, description } of ADMIN_PERMISSION_CATALOG) {
      await pool.query(
        `insert into app_permissions (key, description) values ($1, $2)
         on conflict (key) do nothing`,
        [key, description],
      );
    }

    const orgId = (
      await pool.query<{ id: string }>(`select id from app_organizations where slug = 'default'`)
    ).rows[0]?.id;
    if (!orgId) throw new Error("default org missing after insert");

    const roles: Array<[string, string, string[]]> = [
      ["member", "Member", ["shell.view"]],
      // Canonical catalog keys: `admin.users.read` (view) + `admin.users.manage`
      // (act) for the users area, `admin.audit.read` for the audit log. The old
      // grant linked to those pages but couldn't open them (page guards require
      // the `*.read` keys; `audit.view` is a phantom the pages never check).
      [
        "admin",
        "Administrator",
        ["shell.view", "admin.users.read", "admin.users.manage", "admin.audit.read"],
      ],
      [
        "admin.platform",
        "Platform Administrator",
        // Platform-administrator gets every admin.* permission. Sourced
        // from the canonical catalog so adding a new key automatically
        // grants it to platform admins on next seed run.
        ["shell.view", ...ADMIN_PERMISSION_CATALOG.map((p) => p.key)],
      ],
      [
        "superuser",
        "Superuser",
        // Superuser is the default top-level access level. Its authority
        // comes from the `superuser` MARKER, not enumerated grants: the
        // runtime (getUserAccessContext) synthesizes the full permission set
        // for any holder and the admin gate short-circuits on isSuperadmin
        // (PR #97), so the role needs only the marker (+ shell.view to enter
        // the shell before synthesis).
        ["shell.view", "superuser"],
      ],
    ];
    for (const [key, name, permKeys] of roles) {
      await pool.query(
        `insert into app_roles (organization_id, key, name) values ($1, $2, $3)
         on conflict (organization_id, key) do nothing`,
        [orgId, key, name],
      );
      const roleId = (
        await pool.query<{ id: string }>(
          `select id from app_roles where organization_id = $1 and key = $2`,
          [orgId, key],
        )
      ).rows[0]?.id;
      if (!roleId) throw new Error(`role ${key} missing after insert`);
      for (const permKey of permKeys) {
        const permId = (
          await pool.query<{ id: string }>(`select id from app_permissions where key = $1`, [
            permKey,
          ])
        ).rows[0]?.id;
        if (!permId) continue;
        await pool.query(
          `insert into app_role_permissions (role_id, permission_id) values ($1, $2)
           on conflict do nothing`,
          [roleId, permId],
        );
      }
    }

    const apps: Array<[string, string, string, string, string]> = [
      [
        "devresponse-portal",
        "DevResponse Portal",
        "https://portal.devresponse.com",
        "portal",
        "devresponse-app:portal",
      ],
      [
        "devresponse-analytics",
        "Analytics",
        "https://analytics.devresponse.com",
        "analytics",
        "devresponse-app:analytics",
      ],
      [
        "devresponse-docs",
        "Documentation",
        "https://docs.devresponse.com",
        "docs",
        "devresponse-app:docs",
      ],
    ];
    for (const [id, label, origin, subdomain, audience] of apps) {
      await pool.query(
        `insert into app_enterprise_applications
           (id, label, origin, subdomain, sso_audience, status, sort_order)
         values ($1, $2, $3, $4, $5, 'available', 100)
         on conflict (id) do nothing`,
        [id, label, origin, subdomain, audience],
      );
    }

    await pool.query("commit");
    inTransaction = false;

    await seedDefaultAdminUser(pool, orgId);

    console.log("[seed] local seed applied");
  } catch (error) {
    if (inTransaction) {
      await pool.query("rollback");
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function seedDefaultAdminUser(pool: Pool, organizationId: string) {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log(
      "[seed] skipping default admin user; SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not configured",
    );
    return;
  }

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

  const adminRoleId = (
    await pool.query<{ id: string }>(
      `select id from app_roles where organization_id = $1 and key = 'admin'`,
      [organizationId],
    )
  ).rows[0]?.id;

  if (!adminRoleId) {
    throw new Error("admin role missing after seed");
  }

  let authUser = (
    await pool.query<{ id: string; email: string; name: string | null }>(
      `select id, email, name from "user" where lower(email) = lower($1)`,
      [email],
    )
  ).rows[0];

  if (!authUser) {
    const { auth } = await import("@/lib/auth");
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const created = await auth.api.signUpEmail({
      body: {
        name: LOCAL_ADMIN_NAME,
        email,
        password,
        rememberMe: false,
      },
      headers: new Headers({
        host: new URL(baseUrl).host,
        origin: baseUrl,
      }),
    });

    authUser = {
      id: created.user.id,
      email: created.user.email,
      name: created.user.name,
    };

    console.log(`[seed] created Better Auth admin user ${authUser.email}`);
  }

  // The seeded admin is created pre-verified: `requireEmailVerification` gates
  // real sign-ups, but this fixture (and the e2e suite) sign in directly and
  // cannot complete an email round-trip. Reconcile on every run (idempotent).
  await pool.query(`update "user" set "emailVerified" = true where id = $1`, [authUser.id]);

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
         preferred_locale = excluded.preferred_locale,
         updated_at = now()
       returning id`,
      [authUser.id, authUser.email, authUser.name ?? LOCAL_ADMIN_NAME],
    )
  ).rows[0]?.id;

  if (!appUserId) {
    throw new Error("seeded admin app user missing after upsert");
  }

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

  if (hasAuthRoleColumn) {
    await pool.query(
      `update "user"
       set role = 'admin'
       where id = $1`,
      [authUser.id],
    );
  }

  await pool.query(
    `insert into app_organization_memberships
       (organization_id, app_user_id, status, source_provider, provider_organization_key)
     values ($1, $2, 'active', 'email', 'default')
     on conflict (organization_id, app_user_id) do update set
       status = 'active',
       source_provider = excluded.source_provider,
       provider_organization_key = excluded.provider_organization_key,
       updated_at = now()`,
    [organizationId, appUserId],
  );

  await pool.query(
    `insert into app_user_roles (app_user_id, organization_id, role_id)
     values ($1, $2, $3)
     on conflict do nothing`,
    [appUserId, organizationId, adminRoleId],
  );

  // Also grant the platform-administrator role so the seeded admin can
  // enter the new Administrator workspace (docs/admin-manager.md §6.1).
  const platformRoleId = (
    await pool.query<{ id: string }>(
      `select id from app_roles where organization_id = $1 and key = 'admin.platform'`,
      [organizationId],
    )
  ).rows[0]?.id;

  if (platformRoleId) {
    await pool.query(
      `insert into app_user_roles (app_user_id, organization_id, role_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [appUserId, organizationId, platformRoleId],
    );
  }

  // Grant the default `superuser` access level so the canonical local
  // admin holds the complete permission set without depending on
  // per-permission grants. The role is created by both this seed
  // (lines 80-92 above, which keep its permission grants in sync with
  // the current ADMIN_PERMISSION_CATALOG) AND by the consolidated
  // initial schema 0001-initial-schema.sql (which creates the
  // role/infrastructure at schema-application time). Either path leaves
  // the role in place;
  // here we only need to look it up and assign it.
  const superuserRoleId = (
    await pool.query<{ id: string }>(
      `select id from app_roles where organization_id = $1 and key = 'superuser'`,
      [organizationId],
    )
  ).rows[0]?.id;

  if (superuserRoleId) {
    await pool.query(
      `insert into app_user_roles (app_user_id, organization_id, role_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [appUserId, organizationId, superuserRoleId],
    );
  }

  console.log(`[seed] ensured local admin ${authUser.email}`);
}

main().catch((error) => {
  console.error("[seed] FAILED", error);
  process.exit(1);
});
