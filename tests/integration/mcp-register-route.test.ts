import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

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
  rateLimitKey: (s: string, id: string) => `${s}:${id}`,
}));
// The route's floors consume from the SHARED bucket (review #98); the mock
// keeps the same recording spy so the 429 contract is asserted unchanged.
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  consumeSharedToken: async (...a: unknown[]) => consumeToken(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
// Keyed on the request's X-Forwarded-For when a test sets one, so the F-18
// cases can drive distinct client IPs; every other case shares "ip-1".
vi.mock("@/lib/client-ip", () => ({
  clientIpKey: (headers: Headers) => {
    const ip = headers.get("x-forwarded-for");
    return ip ? `ip:${ip}` : "ip-1";
  },
}));
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

function post(body: unknown, ip?: string): NextRequest {
  return new NextRequest("https://app.test/api/mcp/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
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

  // F-18: the deployment-wide floor used to be consumed BEFORE the per-IP
  // bucket, so every request the IP bucket refused still spent a global
  // token, and one IP looping at ~2 req/s held registration at zero for
  // everyone. The real in-memory bucket sits behind the recording spy here and
  // the clock is frozen, so the route's budgets (5 per IP, 60 globally) are exact.
  describe("F-18: the global floor is charged only for requests the IP bucket admitted", () => {
    const GLOBAL_KEY = "mcp.register:__global__";
    const ATTACKER = "203.0.113.66";
    const VICTIM = "198.51.100.77";
    const keys = () => consumeToken.mock.calls.map((c) => String(c[0]));

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
      actual.__resetRateLimitForTests();
      consumeToken.mockReset().mockImplementation(actual.consumeToken);
    });
    afterEach(() => vi.useRealTimers());

    it("one IP registering past the whole global burst cannot lock registration for another IP", async () => {
      const attempts = 100; // more than the floor's 60-token burst
      const statuses: number[] = [];
      for (let i = 0; i < attempts; i++) {
        statuses.push(
          (await POST(post({ client_name: "junk", organization: "acme" }, ATTACKER))).status,
        );
      }
      expect(statuses.slice(0, 5)).toEqual(Array(5).fill(201));
      expect(statuses.slice(5)).toEqual(Array(attempts - 5).fill(429));
      const attackerKeys = keys();

      const victim = await POST(post({ client_name: "Real agent", organization: "acme" }, VICTIM));
      expect(victim.status).toBe(201);
      // Because only the 5 requests the attacker's own bucket admitted reached the floor.
      expect(attackerKeys.filter((k) => k === GLOBAL_KEY)).toHaveLength(5);
    });

    it("the floor still caps many IPs, refusing only after the request's IP bucket admitted it", async () => {
      // 12 IPs × their 5-token burst = the floor's 60 tokens.
      for (let ip = 0; ip < 12; ip++) {
        for (let i = 0; i < 5; i++) {
          const res = await POST(post({ client_name: "A", organization: "acme" }, `10.0.0.${ip}`));
          expect(res.status).toBe(201);
        }
      }
      consumeToken.mockClear();
      const res = await POST(post({ client_name: "A", organization: "acme" }, VICTIM));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        error: "temporarily_unavailable",
        error_description: "Registration is rate limited.",
      });
      expect(keys()).toEqual([`mcp.register:ip:${VICTIM}`, GLOBAL_KEY]);
      expect(registerMcpAgent).toHaveBeenCalledTimes(60);
    });
  });
});
