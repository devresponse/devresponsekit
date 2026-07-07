import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import type { UserAccessContext } from "@/lib/auth-status";

/**
 * Admin-plane queries + lifecycle for self-registered MCP agents (Phase 4,
 * design docs/design-mcp-agent-gateway.md §12). An agent is an OAuth client
 * whose service user holds an `mcp`-sourced membership — that join is what
 * distinguishes a self-registered agent from an admin-created OAuth client,
 * and it also confines every admin action to genuine agents.
 *
 * The lifecycle actions themselves reuse the existing credential helpers
 * (`updateOauthClient`, `revokeOauthClient`); this module adds the listing,
 * the agent-membership guard, and service-account activation.
 */

export interface McpAgentSummary {
  clientRowId: string;
  clientId: string;
  name: string;
  scopes: string[];
  clientStatus: string;
  appUserId: string;
  userStatus: string;
  email: string;
  organizationId: string | null;
  createdAt: string;
}

/** Joins an OAuth client to its `mcp` service membership, org-scoped. */
function agentBase(access: UserAccessContext) {
  const scope = resolveOrgScope(access);
  if (!scope) return null;
  let base = db
    .selectFrom("app_oauth_clients as c")
    .innerJoin("app_users as u", "u.id", "c.app_user_id")
    .innerJoin("app_organization_memberships as m", (join) =>
      join
        .onRef("m.app_user_id", "=", "c.app_user_id")
        .onRef("m.organization_id", "=", "c.organization_id")
        .on("m.source_provider", "=", "mcp"),
    );
  if (scope.kind === "org") base = base.where("c.organization_id", "=", scope.organizationId);
  return base;
}

/** Every MCP agent the caller may see (org-scoped, newest first). */
export async function listMcpAgents(access: UserAccessContext): Promise<McpAgentSummary[]> {
  const base = agentBase(access);
  if (!base) return [];
  const rows = await base
    .select([
      "c.id as clientRowId",
      "c.client_id as clientId",
      "c.name as name",
      "c.scopes as scopes",
      "c.status as clientStatus",
      "u.id as appUserId",
      "u.status as userStatus",
      "u.primary_email as email",
      "c.organization_id as organizationId",
      sql<string>`to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as("createdAt"),
    ])
    .orderBy("c.created_at", "desc")
    .limit(200)
    .execute();
  return rows;
}

/**
 * Resolves an agent by its OAuth-client row id, but ONLY when it is a real
 * MCP agent (has the `mcp` membership) the caller may access. Returns the
 * fields the action routes need, or undefined.
 */
export async function getMcpAgent(
  access: UserAccessContext,
  clientRowId: string,
): Promise<
  | { clientRowId: string; appUserId: string; organizationId: string | null; clientStatus: string }
  | undefined
> {
  const base = agentBase(access);
  if (!base) return undefined;
  return base
    .select([
      "c.id as clientRowId",
      "c.app_user_id as appUserId",
      "c.organization_id as organizationId",
      "c.status as clientStatus",
    ])
    .where("c.id", "=", clientRowId)
    .executeTakeFirst();
}

/**
 * Activates a still-pending agent service account (its `app_users` row and
 * `mcp` membership). Re-asserts `pending_approval` in the WHERE clauses so a
 * concurrent admin action wins. Returns true when a row was activated.
 */
export async function activateMcpAgent(appUserId: string): Promise<boolean> {
  const userResult = await db
    .updateTable("app_users")
    .set({ status: "active", updated_at: sql`now()` })
    .where("id", "=", appUserId)
    .where("status", "=", "pending_approval")
    .executeTakeFirst();
  await db
    .updateTable("app_organization_memberships")
    .set({ status: "active", updated_at: sql`now()` })
    .where("app_user_id", "=", appUserId)
    .where("source_provider", "=", "mcp")
    .where("status", "=", "pending_approval")
    .execute();
  return Number(userResult.numUpdatedRows ?? 0) > 0;
}
