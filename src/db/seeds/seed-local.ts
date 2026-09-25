import "dotenv/config";
import { createAppPool, ensureSchema } from "@/db/schema-config";
import { setSignupProvisioningSuppressed } from "@/lib/auth-signup-provisioning";
import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin/permissions";
import { seedPlatformSignupPolicy } from "@/db/seeds/platform-signup-policy";
import { seedDefaultAdminUser } from "@/db/seeds/default-admin";
import {
  ensureDefaultOrganization,
  resolveSeedPlatformOrganization,
} from "@/db/seeds/default-organization";
import { seedBaselineRoles } from "@/db/seeds/baseline-roles";

/**
 * Local development seed.
 *
 * Ensures the default organization (the one flagged `is_default`, created
 * only when there is none — F-40), baseline roles and permissions in the
 * platform organization (the one holding the seeded superuser role, which is
 * not necessarily the default — F-40), the
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
  // ONE checked-out session for the whole seed (review #84): `begin` /
  // `commit` / `rollback` issued through `pool.query` are only atomic by
  // accident of connection reuse — the pool is free to hand each statement a
  // different backend, which would leave the `begin` open on one connection
  // while the writes (and the `commit`) land unrelated on others.
  const client = await pool.connect();
  let inTransaction = false;

  try {
    // Defensive: makes `current_schema()` resolve to DB_SCHEMA even if the
    // schema was not pre-created. Tables themselves come from the migrations.
    await ensureSchema(pool);

    await client.query("begin");
    inTransaction = true;

    // F-40: THE default org is the one flagged `is_default`, whatever an
    // administrator has renamed it to; created only when there is none. The
    // slug-keyed insert this replaces added a second default after a rename.
    const { id: defaultOrgId } = await ensureDefaultOrganization(client);
    // ...but the platform roles and the admin belong in the PLATFORM org, the
    // one holding the seeded superuser role. Once a superadmin moves the
    // default to a customer tenant the two differ, and following the flag
    // wrote Superuser / Platform Administrator into that tenant and then
    // refused the seed admin (exit 1).
    const orgId = await resolveSeedPlatformOrganization(client, defaultOrgId);

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
      await client.query(
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
      await client.query(
        `insert into app_permissions (key, description) values ($1, $2)
         on conflict (key) do nothing`,
        [key, description],
      );
    }

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
    await seedPlatformSignupPolicy(client);

    // Baseline roles, in the PLATFORM org resolved above (src/db/seeds/baseline-roles.ts).
    await seedBaselineRoles(client, orgId);

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
        await client.query(
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

    await client.query("commit");
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
      await seedDefaultAdminUser(client, orgId, {
        email: adminEmail,
        password: adminPassword,
        adoptExisting: process.env.SEED_ADMIN_ADOPT_EXISTING === "1",
      });
    }

    console.log("[seed] local seed applied");
  } catch (error) {
    if (inTransaction) {
      // Never let a failing rollback mask the error that caused it.
      await client.query("rollback").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[seed] FAILED", error);
  process.exit(1);
});
