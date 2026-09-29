import { describe, expect, it } from "vitest";
import {
  AGENT_ACTIVATION_PERMISSION,
  isAgentServiceAccount,
  mayActivateAgents,
  MCP_AGENT_ID_PREFIX,
} from "@/lib/admin/service-account";

/**
 * F-77 — the rule the Users console reads about agent service accounts
 * (src/lib/admin/service-account.ts). The routes and the bulk dispatcher that
 * apply it are pinned in tests/integration/administrator-user-actions.test.ts,
 * administrator-phase7.test.ts, api-v1-users-status.test.ts and
 * tests/unit/user-actions-server.test.ts; a real registration in
 * tests/db/agent-service-account-actions.db.test.ts.
 */
describe("isAgentServiceAccount (F-77)", () => {
  it("is true for the id provisioning synthesizes for an agent", () => {
    expect(
      isAgentServiceAccount({
        betterAuthUserId: `${MCP_AGENT_ID_PREFIX}5b0c7f6e-0c1e-4a57-9d3a-1f2e3d4c5b6a`,
      }),
    ).toBe(true);
  });

  it.each(["kO1vYx0pT3cQ9wZr7mNfA2bL", "ba-target", "xmcp-agent:1", "MCP-AGENT:1"])(
    "is false for any other id (%s)",
    (betterAuthUserId) => {
      expect(isAgentServiceAccount({ betterAuthUserId })).toBe(false);
    },
  );
});

describe("mayActivateAgents (F-77): admin.clients.manage, as requireAdminPermission reads it", () => {
  const caller = (permissions: string[], grantedScopes: string[] | null = null) => ({
    access: { permissions },
    grantedScopes,
  });

  it("is true for a cookie session holding the permission", () => {
    expect(mayActivateAgents(caller(["admin.users.manage", AGENT_ACTIVATION_PERMISSION]))).toBe(
      true,
    );
  });

  it("is true for a superadmin, who holds every permission", () => {
    expect(mayActivateAgents(caller(["superuser"]))).toBe(true);
  });

  it("is false for a caller who may change statuses but not approve agents", () => {
    expect(mayActivateAgents(caller(["admin.users.manage"]))).toBe(false);
  });

  it("is false for a bearer credential whose scopes stop short of it, whatever its owner holds", () => {
    expect(
      mayActivateAgents(
        caller(["admin.users.manage", AGENT_ACTIVATION_PERMISSION], ["admin.users.manage"]),
      ),
    ).toBe(false);
    expect(mayActivateAgents(caller(["superuser"], ["admin.users.manage"]))).toBe(false);
  });

  it("is true for a bearer credential scoped to it", () => {
    expect(
      mayActivateAgents(
        caller(
          ["admin.users.manage", AGENT_ACTIVATION_PERMISSION],
          ["admin.users.manage", AGENT_ACTIVATION_PERMISSION],
        ),
      ),
    ).toBe(true);
  });
});
