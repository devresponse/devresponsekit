import "server-only";
import { sql, type Transaction } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";

/**
 * Shared server module for the Organizations & Memberships endpoints
 * (docs/admin-manager.md §8.2).
 *
 * Centralizes the operations every organization handler needs so the
 * route handlers stay declarative and the Phase-5 contract (the
 * `organization_not_empty` 409 + the `organization_is_default` 409 +
 * the `loadOrgOrThrow` shape consumed by the org-detail page) lives in
 * exactly one place.
 *
 * Threat / contract:
 *   - `assertOrgEmpty` is the authoritative guard for DELETE;
 *     handlers MUST call it before mutating, and they MUST translate
 *     the {@link AdminError} it throws into the §5.1 error envelope.
 *   - `assertOrgNotDefault` guards against deleting the default org.
 *   - `deleteRevokedOrgCredentials` clears the org's revoked API keys and
 *     OAuth clients inside the DELETE's transaction (F-98).
 *   - `loadOrgOrThrow` deliberately performs extra round-trips for the
 *     correlated counts so the detail page shows accurate member/role/
 *     binding counts on first paint.
 */

// Re-export AdminError and AdminErrorCode from roles.server.ts for ergonomics.
export { AdminError, type AdminErrorCode } from "./roles.server";
import { AdminError } from "./roles.server";

/**
 * Slug regex: lowercase alphanumeric, hyphens allowed but not at edges.
 * 1–64 characters total.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface LoadedOrg {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  member_count: number;
  binding_count: number;
  role_count: number;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Fetches an organization plus its member, binding and role counts.
 * Throws {@link AdminError} with code `organization_not_found` if the
 * row is absent so callers can surface a uniform 404.
 */
export async function loadOrgOrThrow(id: string): Promise<LoadedOrg> {
  const row = await db
    .selectFrom("app_organizations")
    .select(["id", "slug", "name", "status", "is_default", "created_at", "updated_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AdminError("organization_not_found");

  const [memberRow, bindingRow, roleRow] = await Promise.all([
    db
      .selectFrom("app_organization_memberships")
      .select(sql<string>`count(*)`.as("count"))
      .where("organization_id", "=", id)
      .executeTakeFirst(),
    db
      .selectFrom("app_provider_organizations")
      .select(sql<string>`count(*)`.as("count"))
      .where("organization_id", "=", id)
      .executeTakeFirst(),
    db
      .selectFrom("app_roles")
      .select(sql<string>`count(*)`.as("count"))
      .where("organization_id", "=", id)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    is_default: Boolean(row.is_default),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    member_count: Number(memberRow?.count ?? 0),
    binding_count: Number(bindingRow?.count ?? 0),
    role_count: Number(roleRow?.count ?? 0),
  };
}

/**
 * DELETE guard. Throws {@link AdminError} with `organization_not_empty`
 * when any `app_organization_memberships` row exists for the org,
 * regardless of status. Route handlers translate the throw into HTTP 409
 * with the `organization_not_empty` machine code per §5.1.
 */
export async function assertOrgEmpty(id: string): Promise<void> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select(sql<string>`count(*)`.as("count"))
    .where("organization_id", "=", id)
    .executeTakeFirst();
  if (Number(row?.count ?? 0) > 0) {
    throw new AdminError("organization_not_empty");
  }
}

/**
 * F-98: deletes the org's REVOKED API keys and OAuth clients. The DELETE
 * handler calls it inside its deleting transaction, just before the org row
 * goes.
 *
 * Both tables reference the org with no ON DELETE action, and a revoke only
 * flips `status` (no path ever hard-deletes a credential), so a tenant that
 * had ever held a key or a client, however long ago it was revoked, answered
 * 409 `organization_in_use` forever. Only manual SQL could offboard it. A
 * revoked row can never authorise anything again (there is no un-revoke, and
 * the token check treats a missing row as inactive), and nothing references
 * either table, so it goes with its org. An ACTIVE credential is still "in
 * use": it stays, its foreign key still refuses the delete, and the handler
 * still answers `organization_in_use`, so an admin revokes it first. The
 * revocation itself remains in the audit log.
 */
export async function deleteRevokedOrgCredentials(
  trx: Transaction<AppDatabase>,
  id: string,
): Promise<void> {
  await trx
    .deleteFrom("app_api_keys")
    .where("organization_id", "=", id)
    .where("status", "=", "revoked")
    .execute();
  await trx
    .deleteFrom("app_oauth_clients")
    .where("organization_id", "=", id)
    .where("status", "=", "revoked")
    .execute();
}

/**
 * DELETE guard. Throws {@link AdminError} with `organization_is_default`
 * when the org's `is_default` flag is true. Allows deletion if the org
 * does not exist (will be caught later by the main lookup).
 */
export async function assertOrgNotDefault(id: string): Promise<void> {
  const row = await db
    .selectFrom("app_organizations")
    .select(["is_default"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (row && row.is_default === true) {
    throw new AdminError("organization_is_default");
  }
}
