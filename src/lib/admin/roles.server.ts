import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";

/**
 * Shared server module for the Roles & Permissions endpoints
 * (docs/admin-manager.md §19, Phase 4).
 *
 * Centralizes the three operations every roles handler needs so the
 * route handlers stay declarative and the Phase-4 contract (the
 * `role_in_use` 409 + the dual-list editor's add/remove diff + the
 * `loadRoleOrThrow` shape consumed by the role-detail page) lives in
 * exactly one place.
 *
 * Threat / contract:
 *   - `assertRoleNotInUse` is the authoritative guard for DELETE;
 *     handlers MUST call it before mutating, and they MUST translate
 *     the {@link AdminError} it throws into the §5.1 error envelope.
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
 * DELETE guard. Throws {@link AdminError} with `role_in_use` when any
 * `app_user_roles` OR `app_group_roles` row still references the role.
 * Route handlers translate the throw into HTTP 409 with the `role_in_use`
 * machine code per §5.1.
 *
 * DB-2: group-conferred roles must block deletion too. `app_group_roles`
 * is `ON DELETE CASCADE` on `role_id`, so a role bundled into a group but
 * assigned to no user would otherwise pass this guard and be silently
 * cascade-stripped from the group — quietly revoking the permissions that
 * group conferred (resolved via the ADR-0002 UNION in auth-status.ts),
 * instead of surfacing the documented 409.
 */
export async function assertRoleNotInUse(roleId: string): Promise<void> {
  const [userRow, groupRow] = await Promise.all([
    db
      .selectFrom("app_user_roles")
      .select(sql<string>`count(*)`.as("count"))
      .where("role_id", "=", roleId)
      .executeTakeFirst(),
    db
      .selectFrom("app_group_roles")
      .select(sql<string>`count(*)`.as("count"))
      .where("role_id", "=", roleId)
      .executeTakeFirst(),
  ]);
  if (Number(userRow?.count ?? 0) > 0 || Number(groupRow?.count ?? 0) > 0) {
    throw new AdminError("role_in_use");
  }
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
 * Helper for the permissions catalog DELETE: throws `permission_in_use`
 * when any `app_role_permissions` row still references the permission.
 */
export async function assertPermissionNotInUse(permissionId: string): Promise<void> {
  const row = await db
    .selectFrom("app_role_permissions")
    .select(sql<string>`count(*)`.as("count"))
    .where("permission_id", "=", permissionId)
    .executeTakeFirst();
  if (Number(row?.count ?? 0) > 0) {
    throw new AdminError("permission_in_use");
  }
}
