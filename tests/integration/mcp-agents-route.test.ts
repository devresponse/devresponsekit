import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the MCP-agents admin console routes (Phase 4). The
 * admin guard, the agents module, the OAuth-client helpers, audit,
 * rate-limit, and org-scope are mocked; the scope-grant validation uses the
 * REAL (pure) scopes module. These assert the guard/authz/audit contract.
 */
const requireAdminPermission = vi.fn();
const listMcpAgents = vi.fn();
const getMcpAgent = vi.fn();
const activateMcpAgent = vi.fn();
const updateOauthClient = vi.fn();
const revokeOauthClient = vi.fn();
const auditEvent = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: (...a: unknown[]) => requireAdminPermission(...a),
  isAdminPermissionDenial: (g: { __denied?: boolean }) => g?.__denied === true,
}));
vi.mock("@/lib/mcp/agents.server", () => ({
  listMcpAgents: (...a: unknown[]) => listMcpAgents(...a),
  getMcpAgent: (...a: unknown[]) => getMcpAgent(...a),
  activateMcpAgent: (...a: unknown[]) => activateMcpAgent(...a),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  updateOauthClient: (...a: unknown[]) => updateOauthClient(...a),
  revokeOauthClient: (...a: unknown[]) => revokeOauthClient(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  enforceRateLimit: () => null,
  DEFAULT_ADMIN_MUTATION_LIMIT: {},
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  canAccessOrg: () => true,
  resolveOrgScope: () => ({ kind: "all" }),
}));
vi.mock("@/lib/admin/errors.server", () => ({
  adminErrorResponse: (code: string, status: number) =>
    new Response(JSON.stringify({ error: code }), { status }),
}));

import { GET } from "@/app/api/administrator/mcp-agents/route";
import { DELETE, PATCH } from "@/app/api/administrator/mcp-agents/[id]/route";
import { POST as APPROVE } from "@/app/api/administrator/mcp-agents/[id]/approve/route";

const UUID = "11111111-1111-4111-8111-111111111111";
function ctx() {
  return { params: Promise.resolve({ id: UUID }) };
}
function req(body?: unknown): NextRequest {
  return new NextRequest(`https://app.test/api/administrator/mcp-agents/${UUID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  requireAdminPermission.mockReset().mockResolvedValue({
    access: {
      permissions: ["admin.clients.read", "admin.clients.manage", "account.read"],
      appUserId: "actor-1",
    },
    betterAuthUserId: "admin-1",
    requestId: "req-1",
  });
  listMcpAgents
    .mockReset()
    .mockResolvedValue([{ clientRowId: UUID, clientId: "drkc_x", name: "A", scopes: [] }]);
  getMcpAgent.mockReset().mockResolvedValue({
    clientRowId: UUID,
    appUserId: "svc-1",
    organizationId: "org-1",
    clientStatus: "active",
  });
  activateMcpAgent.mockReset().mockResolvedValue(true);
  updateOauthClient.mockReset().mockResolvedValue(true);
  revokeOauthClient.mockReset().mockResolvedValue(true);
  auditEvent.mockReset();
});

describe("/api/administrator/mcp-agents", () => {
  it("lists agents (admin.clients.read)", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(requireAdminPermission).toHaveBeenCalledWith(expect.anything(), "admin.clients.read");
  });

  it("403s a denied caller", async () => {
    requireAdminPermission.mockResolvedValue({
      __denied: true,
      response: new Response(null, { status: 403 }),
    });
    expect((await GET(req())).status).toBe(403);
  });

  it("approves a pending agent (activates the service account)", async () => {
    const res = await APPROVE(req(), ctx());
    expect(res.status).toBe(200);
    expect(activateMcpAgent).toHaveBeenCalledWith("svc-1");
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.mcp_agent.approved" }),
    );
  });

  it("sets the scope ceiling (PATCH)", async () => {
    const res = await PATCH(req({ scopes: ["account.read"] }), ctx());
    expect(res.status).toBe(200);
    expect(updateOauthClient).toHaveBeenCalledWith(UUID, { scopes: ["account.read"] });
  });

  it("422s a scope the admin cannot grant", async () => {
    const res = await PATCH(req({ scopes: ["admin.audit.read"] }), ctx());
    expect(res.status).toBe(422);
    expect(updateOauthClient).not.toHaveBeenCalled();
  });

  it("revokes the agent client (DELETE)", async () => {
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(200);
    expect(revokeOauthClient).toHaveBeenCalledWith(UUID, "actor-1");
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.mcp_agent.revoked" }),
    );
  });

  it("is idempotent on an already-revoked client", async () => {
    getMcpAgent.mockResolvedValue({
      clientRowId: UUID,
      appUserId: "svc-1",
      organizationId: "org-1",
      clientStatus: "revoked",
    });
    const body = await (await DELETE(req(), ctx())).json();
    expect(body.alreadyRevoked).toBe(true);
    expect(revokeOauthClient).not.toHaveBeenCalled();
  });

  it("404s when the id is not an MCP agent", async () => {
    getMcpAgent.mockResolvedValue(undefined);
    expect((await APPROVE(req(), ctx())).status).toBe(404);
  });
});
