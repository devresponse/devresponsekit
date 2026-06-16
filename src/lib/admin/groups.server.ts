import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";

/**
 * Shared server helpers for the organization-groups endpoints (ADR-0002).
 * A group is a cohort within ONE organization that bundles roles and
 * collects users; the route handlers own the ADR-0001 org boundary and the
 * privilege-escalation guards, this module owns the read shapes.
 */

export interface LoadedGroup {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  created_at: string;
  /** Number of roles the group confers. */
  roleCount: number;
  /** Number of users in the group. */
  memberCount: number;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Loads a group plus its role/member counts, or null when absent. */
export async function loadGroupDetail(id: string): Promise<LoadedGroup | null> {
  const row = await db
    .selectFrom("app_groups")
    .select(["id", "organization_id", "key", "name", "description", "created_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;

  const [roleRow, memberRow] = await Promise.all([
    db
      .selectFrom("app_group_roles")
      .select(sql<string>`count(*)`.as("c"))
      .where("group_id", "=", id)
      .executeTakeFirst(),
    db
      .selectFrom("app_group_memberships")
      .select(sql<string>`count(*)`.as("c"))
      .where("group_id", "=", id)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    organization_id: row.organization_id,
    key: row.key,
    name: row.name,
    description: row.description,
    created_at: toIso(row.created_at),
    roleCount: Number(roleRow?.c ?? 0),
    memberCount: Number(memberRow?.c ?? 0),
  };
}
