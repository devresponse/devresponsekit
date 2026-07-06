import "server-only";
import { db } from "@/db/database";

/** A resolved organization reference (public fields only). */
export interface OrganizationRef {
  id: string;
  slug: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves an organization from a URL-supplied identifier — either its slug
 * (case-insensitive) or its UUID id. Backs the organization-scoped sign-in /
 * sign-up entry points (`/sign-in/<org>`, `?org=<slug>`).
 *
 * Contract:
 *   - Matches ACTIVE organizations only; a suspended/deleted org can never
 *     become a sign-in target.
 *   - Returns null for anything that does not resolve — callers degrade to the
 *     plain sign-in screen and NEVER surface an error, so an unknown value
 *     cannot be used to probe which organizations exist.
 *   - The id branch is guarded by a UUID shape check so a non-UUID identifier
 *     never reaches Postgres as a `uuid` comparison (which raises 22P02).
 *   - This resolver only LOOKS UP orgs; it never creates one. A user-supplied
 *     hint must not be able to spawn organizations.
 */
export async function resolveOrganizationByIdentifier(
  identifier: string,
): Promise<OrganizationRef | null> {
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > 255) {
    return null;
  }
  const slug = trimmed.toLowerCase();
  const isUuid = UUID_RE.test(trimmed);

  const row = await db
    .selectFrom("app_organizations")
    .select(["id", "slug", "name"])
    .where("status", "=", "active")
    .where((eb) => {
      const matches = [eb("slug", "=", slug)];
      if (isUuid) {
        matches.push(eb("id", "=", trimmed));
      }
      return eb.or(matches);
    })
    .executeTakeFirst();

  return row ?? null;
}
