import {
  DEFAULT_ORGANIZATION_LOCK_SQL,
  INITIAL_DEFAULT_ORGANIZATION,
} from "@/lib/default-organization";

/**
 * Default-organization step of the baseline seed (`seed-local.ts`).
 *
 * IDEMPOTENT BY `is_default` (F-40). The seed used to run
 * `insert … values ('default', …, is_default = true) on conflict (slug) do
 * nothing` and then read the org back BY SLUG. After a superadmin renamed the
 * default org, the slug `default` was free again, so a re-run of `db:seed`
 * (step 3 of the production bootstrap, advertised as safe to re-run) inserted
 * a SECOND org flagged `is_default` and wired the default admin's membership
 * and the superuser roles into it. Now the seed looks for the org flagged
 * `is_default` first and creates one only when there is none, so a renamed
 * default is reused, not duplicated, and its slug and name are left as an
 * administrator set them.
 *
 * The default org is only where unmapped sign-ups land. The org the seed
 * writes its platform roles and admin into is resolved separately
 * (`resolveSeedPlatformOrganization`), so moving the default to another
 * tenant does not move them there on the next re-run.
 */

/** The slice of `pg.PoolClient` the seed step needs (keeps it testable). */
export interface DefaultOrganizationSeedQueryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export type DefaultOrganizationSeedOutcome =
  /** An org is already flagged `is_default` (whatever its slug) — reused, nothing written. */
  | "existing"
  /** No org was flagged default — the initial `default` org was created. */
  | "created";

/**
 * Returns the id of THE default organization, creating the initial one only
 * when no org is flagged `is_default`. Run it inside the seed's transaction:
 * it takes the same default-flag lock as the admin routes that move the flag,
 * so a seed racing a "Set as default organization" save cannot add a second
 * default either.
 *
 * Throws when there is no default org AND the slug `default` already belongs
 * to a non-default org. Promoting that org would make the slug an identity
 * again, and inventing another slug would add a tenant nobody chose; an
 * operator picks the default instead (Administrator → Organizations →
 * Settings → "Set as default organization"), then re-runs the seed.
 */
export async function ensureDefaultOrganization(
  client: DefaultOrganizationSeedQueryable,
  log: (message: string) => void = console.log,
): Promise<{ id: string; outcome: DefaultOrganizationSeedOutcome }> {
  await client.query(DEFAULT_ORGANIZATION_LOCK_SQL);

  // Oldest first: the tie-break `getDefaultOrganization` uses, so a legacy
  // database holding two defaults seeds into the one the runtime routes to.
  const existing = (
    await client.query<{ id: string }>(
      `select id from app_organizations
        where is_default
        order by created_at asc, id asc
        limit 1`,
    )
  ).rows[0];
  if (existing) {
    return { id: existing.id, outcome: "existing" };
  }

  const inserted = (
    await client.query<{ id: string }>(
      `insert into app_organizations (slug, name, status, is_default)
       values ($1, $2, 'active', true)
       on conflict (slug) do nothing
       returning id`,
      [INITIAL_DEFAULT_ORGANIZATION.slug, INITIAL_DEFAULT_ORGANIZATION.name],
    )
  ).rows[0];
  if (!inserted) {
    throw new Error(
      `[seed] no organization is flagged is_default, and the slug '${INITIAL_DEFAULT_ORGANIZATION.slug}' ` +
        "already belongs to a non-default organization. Nothing was changed. Choose the default " +
        "organization (Administrator → Organizations → Settings → 'Set as default organization', " +
        "or `update app_organizations set is_default = true where id = '<id>'`) and re-run the seed.",
    );
  }
  log(`[seed] created the default organization '${INITIAL_DEFAULT_ORGANIZATION.slug}'`);
  return { id: inserted.id, outcome: "created" };
}

/**
 * The org the seed's PLATFORM grants live in: the baseline roles (`member`,
 * `admin`, `admin.platform`, `superuser`, with every `admin.*` catalog key on
 * `admin.platform`) and the default admin's membership and roles.
 *
 * That is NOT "the default organization". The default is only where unmapped
 * sign-ups land, and a superadmin can move it to a customer tenant in
 * Settings. Before F-40 both happened to be the slug-`default` org, so the seed
 * treated them as one. Following the moved flag, a re-run of `db:seed` /
 * `db:provision` committed the platform roles (Superuser, Platform
 * Administrator) into the customer tenant, then refused the seed admin (its
 * superuser grant is in the original org, not the new default) and exited 1;
 * with `SEED_ADMIN_ADOPT_EXISTING=1` it gave the platform admin a membership
 * and superuser grant inside that tenant instead.
 *
 * The platform org is the OLDEST org whose `superuser` role carries the
 * `superuser` marker permission: migration 0001 puts that role in the initial
 * default org, and only a superadmin can attach the marker to a role, so it
 * stays the original platform org through renames and moves (and in a legacy
 * two-default database it is the older, original one, as for routing). A
 * database with no such role yet (nothing seeded) falls back to the default
 * organization, which is where the initial roles belong.
 */
export async function resolveSeedPlatformOrganization(
  client: DefaultOrganizationSeedQueryable,
  defaultOrganizationId: string,
  log: (message: string) => void = console.log,
): Promise<string> {
  const platform = (
    await client.query<{ id: string }>(
      `select o.id
         from app_organizations o
         join app_roles r on r.organization_id = o.id and r.key = 'superuser'
         join app_role_permissions rp on rp.role_id = r.id
         join app_permissions p on p.id = rp.permission_id and p.key = 'superuser'
        order by o.created_at asc, o.id asc
        limit 1`,
    )
  ).rows[0];
  if (!platform) return defaultOrganizationId;
  if (platform.id !== defaultOrganizationId) {
    log(
      `[seed] platform roles and the default admin stay in organization ${platform.id} ` +
        "(it holds the seeded superuser role); the default organization, where unmapped " +
        `sign-ups land, is ${defaultOrganizationId} and is left as it is.`,
    );
  }
  return platform.id;
}
