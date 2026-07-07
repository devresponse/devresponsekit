import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the RFC 7591 DCR route (Phase 2). The env, rate
 * limiter, org resolver, provisioner, and audit are mocked so these assert
 * the endpoint contract: the dark gate, validation, org resolution, quota,
 * rate limiting, the policy-mode → status mapping, and the response shape.
 */
const env = vi.hoisted(() => ({
  MCP_REGISTRATION_ENABLED: true,
  MCP_REGISTRATION_MODE: "approval" as "approval" | "open",
  MCP_REGISTRATION_DEFAULT_ORG: undefined as string | undefined,
  MCP_REGISTRATION_MAX_PER_ORG: 50,
}));
const consumeToken = vi.fn();
const resolveOrg = vi.fn();
const provisionMcpAgent = vi.fn();
const countActiveOauthClientsForOrg = vi.fn();
const auditEvent = vi.fn();

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  consumeToken: (...a: unknown[]) => consumeToken(...a),
  rateLimitKey: (s: string, id: string) => `${s}:${id}`,
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/client-ip", () => ({ clientIpKey: () => "ip-1" }));
vi.mock("@/lib/org-lookup.server", () => ({
  resolveOrganizationByIdentifier: (...a: unknown[]) => resolveOrg(...a),
}));
vi.mock("@/lib/mcp/registration.server", () => ({
  provisionMcpAgent: (...a: unknown[]) => provisionMcpAgent(...a),
  countActiveOauthClientsForOrg: (...a: unknown[]) => countActiveOauthClientsForOrg(...a),
}));

import { POST } from "@/app/api/mcp/register/route";

function post(body: unknown): NextRequest {
  return new NextRequest("https://app.test/api/mcp/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  env.MCP_REGISTRATION_ENABLED = true;
  env.MCP_REGISTRATION_MODE = "approval";
  env.MCP_REGISTRATION_DEFAULT_ORG = undefined;
  env.MCP_REGISTRATION_MAX_PER_ORG = 50;
  consumeToken.mockReset().mockReturnValue({ ok: true });
  resolveOrg.mockReset().mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
  countActiveOauthClientsForOrg.mockReset().mockResolvedValue(0);
  auditEvent.mockReset();
  provisionMcpAgent.mockReset().mockResolvedValue({
    appUserId: "svc-1",
    betterAuthUserId: "mcp-agent:uuid",
    client: { client_id: "drkc_abc", clientSecret: "drkcsec_xyz" },
  });
});

describe("POST /api/mcp/register (Phase 2)", () => {
  it("404s (dark) when registration is disabled", async () => {
    env.MCP_REGISTRATION_ENABLED = false;
    expect((await POST(post({ client_name: "A", organization: "acme" }))).status).toBe(404);
  });

  it("400s a request without a client_name", async () => {
    const res = await POST(post({ organization: "acme" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });

  it("400s when the organization cannot be resolved", async () => {
    resolveOrg.mockResolvedValue(null);
    expect((await POST(post({ client_name: "A", organization: "nope" }))).status).toBe(400);
  });

  it("registers a scopeless client (201) with a pending account in approval mode", async () => {
    const res = await POST(post({ client_name: "My Agent", organization: "acme" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe("drkc_abc");
    expect(body.client_secret).toBe("drkcsec_xyz");
    expect(body.scope).toBe("");
    expect(provisionMcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientName: "My Agent",
        organizationId: "org-1",
        status: "pending_approval",
      }),
    );
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp.client.registered" }),
    );
  });

  it("provisions an active account in open mode", async () => {
    env.MCP_REGISTRATION_MODE = "open";
    await POST(post({ client_name: "A", organization: "acme" }));
    expect(provisionMcpAgent).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("falls back to the default org when the request omits `organization`", async () => {
    env.MCP_REGISTRATION_DEFAULT_ORG = "acme";
    expect((await POST(post({ client_name: "A" }))).status).toBe(201);
    expect(resolveOrg).toHaveBeenCalledWith("acme");
  });

  it("400s when no org is given and there is no default", async () => {
    expect((await POST(post({ client_name: "A" }))).status).toBe(400);
  });

  it("429s when rate limited (nothing provisioned)", async () => {
    consumeToken.mockReturnValue({ ok: false, retryAfterSeconds: 2 });
    const res = await POST(post({ client_name: "A", organization: "acme" }));
    expect(res.status).toBe(429);
    expect(provisionMcpAgent).not.toHaveBeenCalled();
  });

  it("403s when the per-org quota is reached", async () => {
    env.MCP_REGISTRATION_MAX_PER_ORG = 2;
    countActiveOauthClientsForOrg.mockResolvedValue(2);
    const res = await POST(post({ client_name: "A", organization: "acme" }));
    expect(res.status).toBe(403);
    expect(provisionMcpAgent).not.toHaveBeenCalled();
  });
});
