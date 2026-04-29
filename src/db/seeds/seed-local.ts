import "dotenv/config";
import { Pool } from "pg";

/**
 * Local development seed.
 *
 * Inserts the default organization, baseline roles and permissions, the
 * three placeholder enterprise applications referenced by the
 * application switcher, and stops short of seeding any user — admin
 * accounts are created via Better Auth's normal sign-up flow and then
 * provisioned by the application provisioning service. This avoids
 * persisting plaintext seed passwords in this script.
 *
 * Tests use their own dedicated factories under `tests/helpers/`.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query("begin");

    await pool.query(
      `insert into app_organizations (slug, name, status, is_default)
       values ('default', 'Default Organization', 'active', true)
       on conflict (slug) do nothing`,
    );

    const permissions = [
      ["shell.view", "View the secure shell"],
      ["admin.users.manage", "Approve, block, suspend, reactivate users"],
      ["audit.view", "Read the audit log"],
    ];
    for (const [key, description] of permissions) {
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
      ["admin", "Administrator", ["shell.view", "admin.users.manage", "audit.view"]],
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
    console.log("[seed] local seed applied");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[seed] FAILED", error);
  process.exit(1);
});
