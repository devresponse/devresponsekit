import "server-only";
import type { Transaction } from "kysely";
import type { AppDatabase } from "@/db/schema/app-schema";
import { contentEtag } from "@/lib/api-auth/etag";

/**
 * F-39: optimistic concurrency for the three administrator records a Settings
 * form edits: organizations, roles and groups.
 *
 * `GET /organizations/[id]`, `/roles/[id]` and `/groups/[id]` answer an `ETag`,
 * and the detail pages hand the same tag to their Settings form. The form sends
 * it back as `If-Match` on its PATCH, which re-reads the record under a row lock
 * inside the writing transaction and answers 412 `precondition_failed` when the
 * tag no longer matches, so a stale tab or a second admin can no longer
 * overwrite a save it never saw. Without `If-Match` (or with `*`) the PATCH is
 * last-write-wins, as it always was.
 *
 * The tag hashes the fields the PATCH can change, plus the record's identity
 * ({@link contentEtag}); counts and timestamps are left out, so adding a member
 * does not make a rename conflict. `app_roles` has no `updated_at` to derive a
 * tag from, and a content hash needs no migration.
 */

export const ORGANIZATION_ETAG_COLUMNS = ["id", "slug", "name", "status", "is_default"] as const;
export const ROLE_ETAG_COLUMNS = ["id", "organization_id", "key", "name", "description"] as const;
export const GROUP_ETAG_COLUMNS = ["id", "organization_id", "key", "name", "description"] as const;

export function organizationEtag(org: {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_default: boolean;
}): string {
  return contentEtag([
    "organization",
    org.id,
    org.slug,
    org.name,
    org.status,
    Boolean(org.is_default),
  ]);
}

export function roleEtag(role: {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  description: string | null;
}): string {
  return contentEtag([
    "role",
    role.id,
    role.organization_id,
    role.key,
    role.name,
    role.description,
  ]);
}

export function groupEtag(group: {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
}): string {
  return contentEtag([
    "group",
    group.id,
    group.organization_id,
    group.key,
    group.name,
    group.description,
  ]);
}

/*
 * The current tag, read `FOR UPDATE` in the caller's writing transaction, or
 * `null` when the record is gone. The lock holds until the transaction ends,
 * so no other writer can change the record between this comparison and the
 * caller's UPDATE: the check is a compare-and-swap, not a check-then-act
 * (review #44 made the same point for the `/api/v1` status route).
 */

export async function lockedOrganizationEtag(
  trx: Transaction<AppDatabase>,
  id: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("app_organizations")
    .select(ORGANIZATION_ETAG_COLUMNS)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  return row ? organizationEtag(row) : null;
}

export async function lockedRoleEtag(
  trx: Transaction<AppDatabase>,
  id: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("app_roles")
    .select(ROLE_ETAG_COLUMNS)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  return row ? roleEtag(row) : null;
}

export async function lockedGroupEtag(
  trx: Transaction<AppDatabase>,
  id: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("app_groups")
    .select(GROUP_ETAG_COLUMNS)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  return row ? groupEtag(row) : null;
}
