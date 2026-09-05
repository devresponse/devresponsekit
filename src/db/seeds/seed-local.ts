import "dotenv/config";
import { createAppPool, ensureSchema } from "@/db/schema-config";
import { setSignupProvisioningSuppressed } from "@/lib/auth-signup-provisioning";
import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin/permissions";
import { seedPlatformSignupPolicy } from "@/db/seeds/platform-signup-policy";
import { seedDefaultAdminUser } from "@/db/seeds/default-admin";

/**
 * Local development seed.
 *
 * Inserts the default organization, baseline roles and permissions, the
 * platform sign-up policy, the default local Better Auth admin user
 * described in `.env.example`, and — only outside `NODE_ENV=production`,
 * or with `SEED_DEMO_APPS=1` — the three demo satellite enterprise
 * applications (the reference Option A/B/C rigs) that the application
 * switcher lists.
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
    // Sourced from the single canonical list in `src/lib/admin/permissions.ts`
    // (the neutral catalog module — the `.server` module is `server-only` and
    // cannot be imported by this tsx script) so the seed cannot drift from the
    // runtime check. Idempotent — `on conflict (key) do nothing`.
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

    // Platform sign-up defaults (0007): a new member is ACTIVE once they VERIFY
    // their email — NO explicit administrator-approval step. This relaxes the
    // migration's fail-closed baseline (verification + admin approval) to the
    // friction-free "verify → active" flow this deployment ships as its default.
    //
    // It updates the PLATFORM-DEFAULT row (`organization_id IS NULL`, inserted by
    // 0001-initial-schema.sql), which every organization without its own override
    // inherits — including the default org where self-registrations land — so it
    // is exactly what the "Platform sign-up defaults" admin panel shows.
    // Verification stays required; the verification itself is the approval.
    //
    // FIRST RUN ONLY (review #17): the write is gated on `updated_by IS NULL`,
    // which the admin API sets on every edit. A re-run after an administrator
    // tightened the policy (admin_approval / invite_only) leaves it untouched
    // and logs a loud notice instead of silently reopening self-registration.
    await seedPlatformSignupPolicy(pool);

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

    // The three reference satellite apps (devresponseapps forks), pointed at
    // the local subdomain rig from docs/integration-satellite-apps.md §6.6 —
    // so a fresh LOCAL database has a working application-switcher entry for
    // each integration model out of the box. Options A/B are consumed via the
    // SSO handoff; Option C shares the primary's session (the launch flow
    // still works for it — it just lands already signed in).
    //
    // DEV-ONLY: the origins are local-rig hosts, so on a production bootstrap
    // (deployment.md §2 runs this same seed) they would be dead switcher
    // entries. Skipped under NODE_ENV=production unless SEED_DEMO_APPS=1
    // explicitly opts in (mirroring dev-init.ts's guard); production
    // deployments register real apps via Administrator → Enterprise apps.
    const seedDemoApps =
      process.env.NODE_ENV !== "production" || process.env.SEED_DEMO_APPS === "1";
    // [id, label, description, origin, subdomain, sso_audience]
    const apps: Array<[string, string, string, string, string, string]> = [
      [
        "standalone",
        "App Standalone (Option A)",
        "Satellite demo - SSO handoff + own app_users",
        "http://app1.devresponse.local:3001",
        "app1",
        "devresponse-app:standalone",
      ],
      [
        "handoff",
        "App Handoff (Option B)",
        "Satellite demo - SSO handoff, table-less",
        "http://app2.devresponse.local:3002",
        "app2",
        "devresponse-app:handoff",
      ],
      [
        "shared",
        "App Shared (Option C)",
        "Satellite demo - shared auth schema, parent-domain cookie",
        "http://app3.devresponse.local:3003",
        "app3",
        "devresponse-app:shared",
      ],
    ];
    if (seedDemoApps) {
      for (const [i, [id, label, description, origin, subdomain, audience]] of apps.entries()) {
        await pool.query(
          `insert into app_enterprise_applications
             (id, label, description, origin, subdomain, sso_audience, status, sort_order)
           values ($1, $2, $3, $4, $5, $6, 'available', $7)
           on conflict (id) do nothing`,
          [id, label, description, origin, subdomain, audience, (i + 1) * 10],
        );
      }
      console.log(`[seed] ensured ${apps.length} demo satellite apps (local-rig origins)`);
    } else {
      console.log(
        "[seed] skipped demo satellite apps (NODE_ENV=production; set SEED_DEMO_APPS=1 to include)",
      );
    }

    await pool.query("commit");
    inTransaction = false;

    // Default admin (review #18): escalation is provenance-gated — the seed
    // only crowns an account it created in this run or one that is already a
    // verified superuser; any other pre-existing account matching
    // SEED_ADMIN_EMAIL is refused (non-zero exit, nothing written) unless
    // SEED_ADMIN_ADOPT_EXISTING=1 opts in explicitly.
    const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      console.log(
        "[seed] skipping default admin user; SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not configured",
      );
    } else {
      await seedDefaultAdminUser(pool, orgId, {
        email: adminEmail,
        password: adminPassword,
        adoptExisting: process.env.SEED_ADMIN_ADOPT_EXISTING === "1",
      });
    }

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

main().catch((error) => {
  console.error("[seed] FAILED", error);
  process.exit(1);
});
