import "server-only";
import { sql, type Transaction } from "kysely";
import { db } from "@/db/database";
import { isForeignKeyViolation as isAnyForeignKeyViolation } from "@/db/pg-errors";
import type { AppDatabase } from "@/db/schema/app-schema";

/**
 * Shared server module for the Roles & Permissions endpoints
 * (docs/admin-manager.md §8.4).
 *
 * Centralizes the three operations every roles handler needs so the
 * route handlers stay declarative and the Phase-4 contract (the
 * `role_in_use` 409 + the dual-list editor's add/remove diff + the
 * `loadRoleOrThrow` shape consumed by the role-detail page) lives in
 * exactly one place.
 *
 * Threat / contract:
 *   - `assertRoleNotInUse` is the authoritative guard for DELETE;
 *     handlers MUST call it inside the deleting transaction, before
 *     mutating (F-97), and they MUST translate the {@link AdminError} it
 *     throws into the §5.1 error envelope.
 *   - `diffPermissions` is a pure helper — no DB. Tests assert its
 *     correctness once and route handlers/UI alike consume the result.
 *   - `loadRoleOrThrow` deliberately performs *one* extra round-trip
 *     for the permission-key list rather than a join — the role row is
 *     always tiny and the permission set is read on the role detail
 *     page where a clean key-array shape is what callers want.
 */

/**
 * Domain-level error carrying a stable machine code that route handlers
 * map directly to the `{ error: "<code>" }` envelope from §5.1.
 *
 * Keep the union narrow: every code that escapes a handler is part of
 * the public API and i18n surface.
 */
export type AdminErrorCode =
  | "role_not_found"
  | "role_in_use"
  | "permission_not_found"
  | "permission_in_use"
  | "key_taken"
  | "organization_not_found"
  | "organization_not_empty"
  | "organization_is_default"
  | "slug_taken"
  | "membership_not_found"
  | "membership_exists"
  | "binding_not_found"
  | "binding_exists"
  | "user_not_found";

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  constructor(code: AdminErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AdminError";
    this.code = code;
  }
}

export interface LoadedRole {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  description: string | null;
  created_at: string;
  /** Permission keys currently attached to the role. */
  permissionKeys: string[];
  /** Distinct member count across `app_user_roles`. */
  memberCount: number;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Fetches a role plus its permission keys and member count. Throws
 * {@link AdminError} with code `role_not_found` if the row is absent so
 * callers can surface a uniform 404.
 */
export async function loadRoleOrThrow(id: string): Promise<LoadedRole> {
  const row = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key", "name", "description", "created_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AdminError("role_not_found");

  const [permRows, memberRow] = await Promise.all([
    db
      .selectFrom("app_role_permissions as rp")
      .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
      .select(["p.key as key"])
      .where("rp.role_id", "=", id)
      .orderBy("p.key", "asc")
      .execute(),
    db
      .selectFrom("app_user_roles")
      .select(sql<string>`count(distinct app_user_id)`.as("count"))
      .where("role_id", "=", id)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    organization_id: row.organization_id,
    key: row.key,
    name: row.name,
    description: row.description,
    created_at: toIso(row.created_at),
    permissionKeys: permRows.map((r) => r.key),
    memberCount: Number(memberRow?.count ?? 0),
  };
}

/**
 * DELETE guard, run INSIDE the transaction that deletes the role (F-97).
 * Locks the role row `FOR UPDATE`, then throws {@link AdminError} with
 * `role_in_use` when any `app_user_roles` OR `app_group_roles` row still
 * references the role, or `role_not_found` when the row is already gone.
 * Route handlers translate the throw into the §5.1 envelope (409 / 404).
 *
 * DB-2: group-conferred roles must block deletion too. `app_group_roles`
 * is `ON DELETE CASCADE` on `role_id`, so a role bundled into a group but
 * assigned to no user would otherwise pass this guard and be silently
 * cascade-stripped from the group — quietly revoking the permissions that
 * group conferred (resolved via the ADR-0002 UNION in auth-status.ts),
 * instead of surfacing the documented 409.
 *
 * F-97: the counts used to run on the pool, BEFORE the delete's own
 * transaction, so a grant committed in between passed the check. A group
 * grant was then cascade-deleted with the role (the DB-2 loss again, just
 * later), and a direct assignment failed the delete with 23503, a 500. The
 * lock closes that window: inserting a row that references the role takes
 * `FOR KEY SHARE` on the role row for its foreign-key check, which conflicts
 * with `FOR UPDATE`. An insert still in flight makes this lock wait until it
 * commits, and the counts after it (READ COMMITTED takes a fresh snapshot per
 * statement) then see it; an insert that starts later waits on the lock and
 * fails its foreign-key check once the role is gone. Typed to a
 * `Transaction` because the lock protects nothing on the pool, where it is
 * released as soon as the statement ends.
 */
export async function assertRoleNotInUse(
  trx: Transaction<AppDatabase>,
  roleId: string,
): Promise<void> {
  const locked = await trx
    .selectFrom("app_roles")
    .select("id")
    .where("id", "=", roleId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw new AdminError("role_not_found");
  const userRow = await trx
    .selectFrom("app_user_roles")
    .select(sql<string>`count(*)`.as("count"))
    .where("role_id", "=", roleId)
    .executeTakeFirst();
  const groupRow = await trx
    .selectFrom("app_group_roles")
    .select(sql<string>`count(*)`.as("count"))
    .where("role_id", "=", roleId)
    .executeTakeFirst();
  if (Number(userRow?.count ?? 0) > 0 || Number(groupRow?.count ?? 0) > 0) {
    throw new AdminError("role_in_use");
  }
}

/**
 * True for Postgres' foreign-key violation (SQLSTATE 23503). The role and
 * permission DELETEs map it to their documented 409 as a backstop (F-97): the
 * locked re-count makes it unreachable for every reference the guards count,
 * but a referencing table added later without extending them would otherwise
 * surface as a 500. It reads the SQLSTATE through the shared reader in
 * `@/db/pg-errors` (F-132) and names no constraint: this is a DELETE of the
 * REFERENCED row, where every 23503 means the row is still referenced.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return isAnyForeignKeyViolation(err);
}

/**
 * Pure diff helper consumed by the dual-list editor and the
 * POST/DELETE handlers under `/api/administrator/roles/[id]/permissions`.
 *
 * Both arrays are treated as sets — duplicates and order are ignored.
 * Returns deterministic ordering (sorted) so audit metadata is stable
 * across runs and snapshot tests.
 */
export function diffPermissions(
  current: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): { toAdd: string[]; toRemove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const k of nxt) if (!cur.has(k)) toAdd.push(k);
  for (const k of cur) if (!nxt.has(k)) toRemove.push(k);
  toAdd.sort();
  toRemove.sort();
  return { toAdd, toRemove };
}

/**
 * Helper for the permissions catalog DELETE, run inside its deleting
 * transaction: locks the permission row `FOR UPDATE`, then throws
 * `permission_in_use` when any `app_role_permissions` row still references
 * the permission, or `permission_not_found` when the row is already gone.
 * The lock is {@link assertRoleNotInUse}'s (F-97): without it a permission
 * attached to a role between the count and the delete failed the delete with
 * 23503, a 500 instead of the documented 409.
 */
export async function assertPermissionNotInUse(
  trx: Transaction<AppDatabase>,
  permissionId: string,
): Promise<void> {
  const locked = await trx
    .selectFrom("app_permissions")
    .select("id")
    .where("id", "=", permissionId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw new AdminError("permission_not_found");
  const row = await trx
    .selectFrom("app_role_permissions")
    .select(sql<string>`count(*)`.as("count"))
    .where("permission_id", "=", permissionId)
    .executeTakeFirst();
  if (Number(row?.count ?? 0) > 0) {
    throw new AdminError("permission_in_use");
  }
}
