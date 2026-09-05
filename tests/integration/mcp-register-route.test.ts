import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the RFC 7591 DCR route (Phase 2). The env, rate
 * limiter, org resolver, provisioner, and audit are mocked so these assert
 * the endpoint contract: the dark gate, validation, org resolution + the
 * caller-supplied-org policy (review #51), the atomic quota result, rate
 * limiting, the policy-mode → status mapping, and the response shape. The
 * org-policy helpers are the REAL pure module.
 */
const env = vi.hoisted(() => ({
  MCP_REGISTRATION_ENABLED: true,
  MCP_REGISTRATION_MODE: "approval" as "approval" | "open",
  MCP_REGISTRATION_DEFAULT_ORG: undefined as string | undefined,
  MCP_REGISTRATION_ALLOWED_ORGS: undefined as string | undefined,
  MCP_REGISTRATION_MAX_PER_ORG: 50,
}));
const consumeToken = vi.fn();
const resolveOrg = vi.fn();
const registerMcpAgent = vi.fn();
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
  registerMcpAgent: (...a: unknown[]) => registerMcpAgent(...a),
}));

import { POST } from "@/app/api/mcp/register/route";

const ORGS: Record<string, { id: string; slug: string; name: string }> = {
  acme: { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" },
  other: { id: "22222222-2222-4222-8222-222222222222", slug: "other", name: "Other" },
};

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
  env.MCP_REGISTRATION_ALLOWED_ORGS = undefined;
  env.MCP_REGISTRATION_MAX_PER_ORG = 50;
  consumeToken.mockReset().mockReturnValue({ ok: true });
  // Resolves by slug or id, like the real resolver (active orgs only).
  resolveOrg.mockReset().mockImplementation(async (identifier: string) => {
    const key = identifier.trim().toLowerCase();
    return Object.values(ORGS).find((o) => o.slug === key || o.id === key) ?? null;
  });
  auditEvent.mockReset();
  registerMcpAgent.mockReset().mockResolvedValue({
    ok: true,
    agent: {
      appUserId: "svc-1",
      betterAuthUserId: "mcp-agent:uuid",
      client: { client_id: "drkc_abc", clientSecret: "drkcsec_xyz" },
    },
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
    expect((await POST(post({ client_name: "A", organization: "nope" }))).status).toBe(400);
    expect(registerMcpAgent).not.toHaveBeenCalled();
  });

  it("registers a scopeless client (201) with a pending account in approval mode", async () => {
    const res = await POST(post({ client_name: "My Agent", organization: "acme" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe("drkc_abc");
    expect(body.client_secret).toBe("drkcsec_xyz");
    expect(body.scope).toBe("");
    expect(registerMcpAgent).toHaveBeenCalledWith({
      clientName: "My Agent",
      organizationId: ORGS.acme!.id,
      status: "pending_approval",
      maxPerOrg: 50,
    });
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp.client.registered" }),
    );
  });

  it("provisions an active account in open mode", async () => {
    env.MCP_REGISTRATION_MODE = "open";
    await POST(post({ client_name: "A", organization: "acme" }));
    expect(registerMcpAgent).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
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
    expect(registerMcpAgent).not.toHaveBeenCalled();
  });

  it("403s when the atomic quota check refuses (nothing audited)", async () => {
    env.MCP_REGISTRATION_MAX_PER_ORG = 2;
    registerMcpAgent.mockResolvedValue({ ok: false, reason: "quota_exceeded" });
    const res = await POST(post({ client_name: "A", organization: "acme" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("access_denied");
    expect(registerMcpAgent).toHaveBeenCalledWith(expect.objectContaining({ maxPerOrg: 2 }));
    expect(auditEvent).not.toHaveBeenCalled();
  });

  describe("caller-supplied `organization` policy (review #51)", () => {
    it("REFUSES an org other than the configured default (was: silently overrode it)", async () => {
      env.MCP_REGISTRATION_DEFAULT_ORG = "acme";
      const res = await POST(post({ client_name: "A", organization: "other" }));
      expect(res.status).toBe(400);
      // Same generic rejection as an unknown org — no "exists but closed" oracle.
      expect(await res.json()).toEqual({
        error: "invalid_client_metadata",
        error_description: "Unknown organization.",
      });
      expect(registerMcpAgent).not.toHaveBeenCalled();
    });

    it("accepts the default org named explicitly — by slug or by id", async () => {
      env.MCP_REGISTRATION_DEFAULT_ORG = "acme";
      expect((await POST(post({ client_name: "A", organization: "acme" }))).status).toBe(201);
      expect((await POST(post({ client_name: "A", organization: ORGS.acme!.id }))).status).toBe(
        201,
      );
    });

    it("accepts an org on MCP_REGISTRATION_ALLOWED_ORGS alongside the default", async () => {
      env.MCP_REGISTRATION_DEFAULT_ORG = "acme";
      env.MCP_REGISTRATION_ALLOWED_ORGS = "other";
      expect((await POST(post({ client_name: "A", organization: "other" }))).status).toBe(201);
      expect(registerMcpAgent).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORGS.other!.id }),
      );
    });

    it("an allow-list without a default is restrictive too", async () => {
      env.MCP_REGISTRATION_ALLOWED_ORGS = "acme";
      expect((await POST(post({ client_name: "A", organization: "other" }))).status).toBe(400);
      expect((await POST(post({ client_name: "A", organization: "acme" }))).status).toBe(201);
    });

    it("with neither configured, any active org still resolves (open multi-tenant mode)", async () => {
      expect((await POST(post({ client_name: "A", organization: "other" }))).status).toBe(201);
    });
  });
});
