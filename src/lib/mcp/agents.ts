/**
 * MCP agents — the pure (client-safe) half of `agents.server.ts`: the
 * derived lifecycle status vocabulary and the summary row shape the console
 * renders. No `server-only` imports so the client toolbar / table can share
 * them (review #13).
 */

/**
 * Lifecycle status of an agent, derived from its two underlying rows
 * (client + service user), so the filter, the sort and the console badge all
 * agree on one definition:
 *   - `pending`  — client active, service user still `pending_approval`
 *   - `revoked`  — client no longer active (admin revoke or reaper expiry)
 *   - `active`   — everything else (client active, account approved)
 */
export type McpAgentStatus = "pending" | "active" | "revoked";
export const MCP_AGENT_STATUSES: readonly McpAgentStatus[] = ["pending", "active", "revoked"];

export function isMcpAgentStatus(value: unknown): value is McpAgentStatus {
  return typeof value === "string" && (MCP_AGENT_STATUSES as string[]).includes(value);
}

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
  status: McpAgentStatus;
}

/**
 * I-03: what the console shows an approver beside the registrant-chosen name:
 * the tenant the agent is bound to and the address its registration came
 * from (the trusted-hop IP on its `mcp.client.registered` audit row; null when
 * no row carries one, e.g. after audit retention removed it). Console-only:
 * `GET /api/administrator/mcp-agents` keeps returning plain
 * {@link McpAgentSummary} items.
 */
export interface McpAgentProvenance {
  organizationName: string | null;
  organizationSlug: string | null;
  registeredIp: string | null;
}

export type McpAgentConsoleRow = McpAgentSummary & McpAgentProvenance;
