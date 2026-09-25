import "server-only";
import { sql, type Kysely, type Transaction } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { DEFAULT_ORGANIZATION_LOCK_SQL } from "@/lib/default-organization";

/**
 * The default organization, resolved by its ONE identity: `is_default`
 * (F-40, see `default-organization.ts`). Every consumer that means "the
 * default org" goes through here: sign-up routing (`provisionUserFromAuth`),
 * the sign-up policy lookup (`resolveSignupPolicy`), the admin create and
 * update routes that move the flag, and the delete route that refuses a
 * flagged org. Nothing looks it up by slug any more, so
 * renaming it changes nothing about where sign-ups land.
 */
export interface DefaultOrganization {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/**
 * No organization is flagged `is_default`. Sign-up placement refuses rather
 * than inventing one (F-40): the old fallback auto-created an active
 * "Default Organization" with no admins, roles or policy row, and every
 * unmapped sign-up from then on joined a tenant nobody administered.
 */
export class NoDefaultOrganizationError extends Error {
  constructor() {
    super(
      "No default organization is configured (no app_organizations row has is_default = true). " +
        "Set one in Administrator → Organizations → Settings → 'Set as default organization'. " +
        "Sign-ups that no invitation, sign-in link or email-domain binding places elsewhere " +
        "cannot be provisioned until then.",
    );
    this.name = "NoDefaultOrganizationError";
  }
}

/**
 * The org flagged `is_default`, or null when there is none. The admin write
 * paths keep exactly one (`moveDefaultOrganizationFlag`); a legacy database
 * that already holds two resolves to the OLDEST, which is the original
 * default (the pre-F-40 seed re-run only ever added a newer one).
 */
export async function getDefaultOrganization(
  executor: Kysely<AppDatabase> = db,
): Promise<DefaultOrganization | null> {
  const row = await executor
    .selectFrom("app_organizations")
    .select(["id", "slug", "name", "status"])
    .where("is_default", "=", true)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/** {@link getDefaultOrganization}, throwing {@link NoDefaultOrganizationError} when there is none. */
export async function requireDefaultOrganization(
  executor: Kysely<AppDatabase> = db,
): Promise<DefaultOrganization> {
  const org = await getDefaultOrganization(executor);
  if (!org) throw new NoDefaultOrganizationError();
  return org;
}

/**
 * Takes the default-flag lock (`DEFAULT_ORGANIZATION_LOCK_SQL`) for the rest of
 * `trx`. Every read-then-write of `is_default` starts with this, and so does
 * the org DELETE (a flagged org cannot be deleted).
 *
 * LOCK ORDER: take it BEFORE any row lock in the same transaction. The helpers
 * below take it themselves, but a caller that row-locks first must take it up
 * front. The org PATCH's last-superuser check, for one, locks the orgs holding
 * superuser grants (by default the default org): taken after that, this lock
 * waits while holding the row, a concurrent move holds this lock while waiting
 * for the row, and Postgres aborts one of them as a deadlock (a 500). The lock
 * is re-entrant within a transaction, so a helper taking it again is harmless.
 */
export async function lockDefaultOrganizationFlag(trx: Transaction<AppDatabase>): Promise<void> {
  await sql.raw(DEFAULT_ORGANIZATION_LOCK_SQL).execute(trx);
}

/**
 * Makes `organizationId` THE default: under the default-flag lock, clears the
 * flag on every other org and sets it on this one, in the caller's
 * transaction. Returns the ids of the orgs that lost the flag (for the audit
 * row), or null when the target org does not exist, in which case nothing is
 * changed. Moving, not adding, is what the "Set as default organization"
 * checkbox means, and since sign-up routing follows `is_default` the move
 * re-routes new sign-ups to this org.
 */
export async function moveDefaultOrganizationFlag(
  trx: Transaction<AppDatabase>,
  organizationId: string,
): Promise<string[] | null> {
  await lockDefaultOrganizationFlag(trx);
  // Row locks: the current default(s) FIRST, then the target. That is the
  // order the last-superuser check and the membership and role writers take
  // them in (the org holding the superuser grants, by default the default org,
  // then the org being written), so a move cannot deadlock against those.
  await trx
    .selectFrom("app_organizations")
    .select(["id"])
    .where("is_default", "=", true)
    .where("id", "<>", organizationId)
    .orderBy("id")
    .forUpdate()
    .execute();
  // The target is locked before anything is cleared, so a target deleted since
  // the route's existence check changes nothing (null) rather than leaving the
  // old default cleared and nothing set. The org DELETE takes the default-flag
  // lock too, so it cannot remove the target while a move is under way.
  // Clear-then-set (not the reverse) keeps a future partial unique index on
  // `is_default` satisfied at every statement.
  const target = await trx
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!target) return null;
  const cleared = await trx
    .updateTable("app_organizations")
    .set({ is_default: false, updated_at: sql`now()` })
    .where("is_default", "=", true)
    .where("id", "<>", organizationId)
    .returning("id")
    .execute();
  await trx
    .updateTable("app_organizations")
    .set({ is_default: true })
    .where("id", "=", organizationId)
    .execute();
  return cleared.map((row) => row.id);
}

/**
 * What `isDefault: false` does to `organizationId` (the org PATCH), decided
 * under the default-flag lock:
 *
 * - `"refused"`: it is THE default, the org sign-ups resolve to
 *   (`getDefaultOrganization`). Nothing changes: the flag can only be MOVED,
 *   never dropped, or sign-ups would have nowhere to land.
 * - `"cleared"`: it carried an EXTRA flag (a legacy database holding two
 *   defaults, where routing already uses the older one). The flag is cleared;
 *   that is how an operator repairs that state from Settings.
 * - `"unchanged"`: it was not flagged, so there is nothing to do.
 */
export async function clearDefaultOrganizationFlag(
  trx: Transaction<AppDatabase>,
  organizationId: string,
): Promise<"refused" | "cleared" | "unchanged"> {
  await lockDefaultOrganizationFlag(trx);
  const resolved = await getDefaultOrganization(trx);
  if (resolved?.id === organizationId) return "refused";
  const cleared = await trx
    .updateTable("app_organizations")
    .set({ is_default: false })
    .where("id", "=", organizationId)
    .where("is_default", "=", true)
    .executeTakeFirst();
  return Number(cleared.numUpdatedRows) > 0 ? "cleared" : "unchanged";
}

/**
 * Whether `organizationId` is flagged default at all (THE default or a legacy
 * extra one), read under the default-flag lock so a concurrent move cannot
 * change the answer before the caller's transaction commits. The org DELETE
 * re-checks this inside its deleting transaction: its earlier read on the pool
 * cannot see a move that commits after it, and deleting the org that has just
 * become the default would leave none.
 */
export async function isDefaultOrganizationLocked(
  trx: Transaction<AppDatabase>,
  organizationId: string,
): Promise<boolean> {
  await lockDefaultOrganizationFlag(trx);
  const row = await trx
    .selectFrom("app_organizations")
    .select(["is_default"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  return row?.is_default === true;
}
