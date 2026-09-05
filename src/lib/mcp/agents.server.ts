import "server-only";
import { sql, type SqlBool } from "kysely";
import { db } from "@/db/database";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import {
  buildListResponse,
  executeListWithTotal,
  offsetFor,
  parseListQuery,
  windowTotalColumn,
  type ListQuery,
  type ListResponse,
} from "@/lib/admin/list-query.server";
import type { UserAccessContext } from "@/lib/auth-status";
import { isMcpAgentStatus, type McpAgentStatus, type McpAgentSummary } from "./agents";

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

export type { McpAgentStatus, McpAgentSummary } from "./agents";
export { MCP_AGENT_STATUSES } from "./agents";

/** Standard list envelope plus the scope-wide pending count (review #13). */
export interface McpAgentListResult extends ListResponse<McpAgentSummary> {
  /** Agents awaiting approval across the caller's whole scope — independent of the page/filter. */
  pendingCount: number;
}

/**
 * List-query contract for the agents console + `GET /api/administrator/
 * mcp-agents` (review #13): `page` / `pageSize` (default 25, max 200),
 * `filter[status]=pending|active|revoked`, `sort=created_at|name`. Shared by
 * the route and the page so both parse the URL identically.
 */
export function parseMcpAgentListQuery(params: URLSearchParams): ListQuery {
  return parseListQuery(params, {
    allowedSortFields: ["created_at", "name"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });
}

/** The parsed `filter[status]`, or null when absent/unrecognised (→ no filter). */
export function mcpAgentStatusFilter(query: ListQuery): McpAgentStatus | null {
  const raw = query.filters.status;
  return isMcpAgentStatus(raw) ? raw : null;
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

const PENDING_PREDICATE = sql<SqlBool>`(c.status = 'active' and u.status = 'pending_approval')`;
const REVOKED_PREDICATE = sql<SqlBool>`(c.status <> 'active')`;
const ACTIVE_PREDICATE = sql<SqlBool>`(c.status = 'active' and u.status <> 'pending_approval')`;
const STATUS_PREDICATES: Record<McpAgentStatus, typeof PENDING_PREDICATE> = {
  pending: PENDING_PREDICATE,
  revoked: REVOKED_PREDICATE,
  active: ACTIVE_PREDICATE,
};
/** SQL twin of {@link McpAgentStatus} — the SAME predicates, as a CASE. */
const STATUS_COLUMN = sql<McpAgentStatus>`case when ${REVOKED_PREDICATE} then 'revoked' when ${PENDING_PREDICATE} then 'pending' else 'active' end`;

/**
 * Agents the caller may see, one page at a time (review #13). Before this
 * the console listed only the newest 200 with no filter, so >200 junk
 * registrations hid a legitimate pending agent. Now:
 *   - `filter[status]` narrows to pending / active / revoked;
 *   - PENDING AGENTS SORT FIRST regardless of the requested sort, then the
 *     requested sort (default newest first), then `c.id` as a deterministic
 *     tiebreaker so pages never overlap;
 *   - `pendingCount` counts every pending agent in scope — NOT just the page
 *     or the filtered set — so the console badge stays truthful on any view;
 *   - `total` rides on a window count (one round-trip for rows + total).
 * A null org scope (an org admin with no org, ADR-0001) sees nothing.
 */
export async function listMcpAgents(
  access: UserAccessContext,
  query: ListQuery,
): Promise<McpAgentListResult> {
  const base = agentBase(access);
  if (!base) return { ...buildListResponse<McpAgentSummary>([], 0, query), pendingCount: 0 };

  const statusFilter = mcpAgentStatusFilter(query);
  const filtered = statusFilter ? base.where(STATUS_PREDICATES[statusFilter]) : base;

  let items = filtered
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
      STATUS_COLUMN.as("status"),
      windowTotalColumn(),
    ])
    // Pending first: the whole point of the console is to act on these.
    .orderBy(sql`case when ${PENDING_PREDICATE} then 0 else 1 end`);
  for (const s of query.sort) {
    // Fields are allow-listed by parseMcpAgentListQuery; qualify with the
    // client alias since `name` / `created_at` also exist on `app_users`.
    items = items.orderBy(sql.ref(`c.${s.field}`), s.direction);
  }
  items = items.orderBy("c.id", "asc").limit(query.pageSize).offset(offsetFor(query));

  const [page, pendingRow] = await Promise.all([
    executeListWithTotal(items, filtered.select(sql<string>`count(*)`.as("total")), query),
    base
      .select(sql<string>`count(*)`.as("count"))
      .where(PENDING_PREDICATE)
      .executeTakeFirst(),
  ]);
  return {
    ...buildListResponse(page.items, page.total, query),
    pendingCount: Number(pendingRow?.count ?? 0),
  };
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
 * concurrent admin action wins — and the membership is touched ONLY when the
 * user row actually flipped, so an agent the reaper expired a moment earlier
 * (review #51) is not left with an active membership under a deactivated
 * account. Returns true when a row was activated.
 */
export async function activateMcpAgent(appUserId: string): Promise<boolean> {
  const userResult = await db
    .updateTable("app_users")
    .set({ status: "active", updated_at: sql`now()` })
    .where("id", "=", appUserId)
    .where("status", "=", "pending_approval")
    .executeTakeFirst();
  const activated = Number(userResult.numUpdatedRows ?? 0) > 0;
  if (!activated) return false;
  await db
    .updateTable("app_organization_memberships")
    .set({ status: "active", updated_at: sql`now()` })
    .where("app_user_id", "=", appUserId)
    .where("source_provider", "=", "mcp")
    .where("status", "=", "pending_approval")
    .execute();
  return true;
}
