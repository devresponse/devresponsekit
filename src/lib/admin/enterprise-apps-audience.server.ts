import "server-only";
import { db } from "@/db/database";

/**
 * Route-layer uniqueness check for `app_enterprise_applications.sso_audience`
 * (review #15).
 *
 * The consumer binds a handoff token to its own application id, but the
 * audience is still an admin-typed column with no UNIQUE constraint yet (the
 * index is scheduled for a later core migration). Until then the create /
 * update routes refuse a duplicate with `409 audience_taken`, so two apps can
 * never be registered to accept each other's tokens by copy-paste or by an
 * org admin shadowing another org's satellite. A check-then-write race is
 * still possible without the index — the migration closes it.
 *
 * @param excludeId the app being updated (its own row is not a conflict).
 */
export async function isSsoAudienceTaken(audience: string, excludeId?: string): Promise<boolean> {
  let query = db
    .selectFrom("app_enterprise_applications")
    .select(["id"])
    .where("sso_audience", "=", audience);
  if (excludeId !== undefined) {
    query = query.where("id", "!=", excludeId);
  }
  const row = await query.executeTakeFirst();
  return Boolean(row);
}
