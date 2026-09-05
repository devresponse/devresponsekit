import "server-only";
import { db } from "@/db/database";

/**
 * Name of the UNIQUE index migration 0005 puts on
 * `app_enterprise_applications (sso_audience)` (review #15). A 23505 that
 * names it is an audience collision, not an `id` collision.
 */
export const SSO_AUDIENCE_UNIQUE_INDEX = "idx_app_enterprise_applications_sso_audience";

/**
 * True when `err` is Postgres' unique-violation (SQLSTATE 23505) raised by
 * {@link SSO_AUDIENCE_UNIQUE_INDEX} — the race the pre-check below cannot
 * close on its own. `pg` exposes the violated index/constraint name as
 * `constraint` on its DatabaseError.
 */
export function isSsoAudienceUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === SSO_AUDIENCE_UNIQUE_INDEX;
}

/**
 * Route-layer uniqueness check for `app_enterprise_applications.sso_audience`
 * (review #15) — the FIRST line of defence, giving a clean 409 before any
 * write; the UNIQUE index (migration 0005) is the second, closing the
 * check-then-write race, and the routes map its 23505 to the same
 * `audience_taken` code via {@link isSsoAudienceUniqueViolation}.
 *
 * Two apps sharing an audience could be registered to accept each other's
 * tokens by copy-paste or by an org admin shadowing another org's satellite.
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
