import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin/permissions";

/**
 * Baseline-roles step of the seed (`seed-local.ts`): the `member`, `admin`,
 * `admin.platform` and `superuser` roles and their permission links, in the
 * PLATFORM organization (`resolveSeedPlatformOrganization`, never simply the
 * org flagged default: F-40). Idempotent: roles and links are inserted with
 * `on conflict do nothing`, so a re-run only adds what is missing, such as a
 * new `admin.*` catalog key on `admin.platform`.
 *
 * The permissions themselves must already exist (migrations, and the seed's
 * permission step); a key that does not is skipped.
 */

/** The slice of `pg.PoolClient` the step needs (keeps it testable). */
export interface BaselineRolesSeedQueryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** [key, name, permission keys] */
export const BASELINE_ROLES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
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

export async function seedBaselineRoles(
  client: BaselineRolesSeedQueryable,
  organizationId: string,
): Promise<void> {
  for (const [key, name, permKeys] of BASELINE_ROLES) {
    await client.query(
      `insert into app_roles (organization_id, key, name) values ($1, $2, $3)
       on conflict (organization_id, key) do nothing`,
      [organizationId, key, name],
    );
    const roleId = (
      await client.query<{ id: string }>(
        `select id from app_roles where organization_id = $1 and key = $2`,
        [organizationId, key],
      )
    ).rows[0]?.id;
    if (!roleId) throw new Error(`role ${key} missing after insert`);
    for (const permKey of permKeys) {
      const permId = (
        await client.query<{ id: string }>(`select id from app_permissions where key = $1`, [
          permKey,
        ])
      ).rows[0]?.id;
      if (!permId) continue;
      await client.query(
        `insert into app_role_permissions (role_id, permission_id) values ($1, $2)
         on conflict do nothing`,
        [roleId, permId],
      );
    }
  }
}
