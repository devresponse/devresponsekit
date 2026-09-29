import { SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import { scopesAuthorize } from "@/lib/api-auth/scopes";

/**
 * F-77 — AN AGENT SERVICE ACCOUNT HAS NO LOGIN, SO THE LOGIN ACTIONS REFUSE IT.
 *
 * A self-registered MCP agent authenticates only with client credentials, so
 * `provisionMcpAgent` gives its service account a synthesized
 * `better_auth_user_id` under {@link MCP_AGENT_ID_PREFIX} and no Better Auth
 * user at all (docs/design-mcp-agent-gateway.md §10). The account still lists
 * in the Users console, and every action there that works on the Better Auth
 * user failed on it: ban, unban, soft-delete and restore (single-row and bulk),
 * setting its password, setting its platform role and impersonating it each
 * found no user and answered 502, with a failure audit row, and a reset email
 * was reported sent to an address that cannot receive one. So each of them
 * refuses such an account with 409 `not_applicable_to_service_account` before
 * anything is written, and the rename skips its Better Auth mirror. What does
 * apply is left as it was: block and suspend (the account-level kill switch),
 * roles, groups, memberships and sessions. The agent's lifecycle, including
 * revoking it for good, is the Agents console's (`/api/administrator/mcp-agents`).
 *
 * And approving an agent there needs `admin.clients.manage`, so the Users
 * console's approve and reactivate need it too for such an account
 * ({@link mayActivateAgents}): both status routes and the bulk status actions.
 * With `admin.users.manage` alone, bulk-approving the pending sign-ups
 * activated every junk self-registration among them.
 *
 * The prefix is the marker because it is exactly the property that matters:
 * nothing else writes an id under it, and every Better Auth id is generated
 * without one. No `server-only` and only pure imports: the routes, the bulk
 * helpers, the user detail page and the provisioning all read the same rule.
 */
export const MCP_AGENT_ID_PREFIX = "mcp-agent:";

export const SERVICE_ACCOUNT_ERROR = "not_applicable_to_service_account";
export const SERVICE_ACCOUNT_STATUS = 409;

/** What the Agents console's approve requires, and so any activation of an agent. */
export const AGENT_ACTIVATION_PERMISSION = "admin.clients.manage";

/** True when `account` is an MCP agent's service account, which has no Better Auth user. */
export function isAgentServiceAccount(account: { betterAuthUserId: string }): boolean {
  return account.betterAuthUserId.startsWith(MCP_AGENT_ID_PREFIX);
}

/**
 * Whether an admitted caller may activate an agent service account: it holds
 * {@link AGENT_ACTIVATION_PERMISSION} by the rule `requireAdminPermission`
 * applies, the permission (a superadmin holds every one) and, for a bearer
 * credential, a scope that authorizes it. Takes the administrator grant and
 * the `/api/v1` grant's `caller` alike.
 */
export function mayActivateAgents(caller: {
  access: { permissions: ReadonlyArray<string> };
  grantedScopes: ReadonlyArray<string> | null;
}): boolean {
  const { permissions } = caller.access;
  return (
    (permissions.includes(SUPERADMIN_PERMISSION) ||
      permissions.includes(AGENT_ACTIVATION_PERMISSION)) &&
    scopesAuthorize(caller.grantedScopes, AGENT_ACTIVATION_PERMISSION)
  );
}
