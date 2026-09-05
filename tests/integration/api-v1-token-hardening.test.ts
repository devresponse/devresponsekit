import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * POST /api/v1/auth/token — Wave 3 token hardening (review #43, #48,
 * #50/#53). The REAL route runs; credential verification, persistence and
 * signing are mocked so the contract pinned here is what the route hands to
 * the signer and what it returns:
 *
 *   - #43  every token names its source credential (`cid`) so revocation
 *          of that key / client can retire it;
 *   - #48  `expires_in` is min(configured TTL, seconds until the API key's
 *          `expires_at`); a key expiring in < 1 s never mints a 0 TTL;
 *   - #50  `resource` selects the audience from an allow-list derived from
 *          the app origin; anything else is `invalid_target`, and an
 *          omitted `resource` keeps today's v1 audience.
 */
const env = vi.hoisted(() => ({
  API_JWT_ENABLED: true,
  API_KEYS_ENABLED: true,
  API_JWT_PRIVATE_KEY: "{}",
  API_JWT_AUDIENCE: "devresponse-api",
  API_JWT_ACCESS_TTL_SECONDS: 900,
  BETTER_AUTH_URL: "https://app.example.com",
}));
const auditEvent = vi.fn();
const verifyClientCredentials = vi.fn();
const verifyApiKey = vi.fn();
const isBetterAuthUserBanned = vi.fn();
const mintAccessToken = vi.fn();
const getUserAccessContext = vi.fn();

vi.mock("@/lib/env", () => ({
  getServerEnv: () => env,
  intFromEnv: (_name: string, fallback: number) => fallback,
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => getUserAccessContext(id) };
});
vi.mock("@/lib/admin/rate-limit.server", () => ({
  consumeToken: () => ({ ok: true }),
  rateLimitKey: (s: string, id: string) => `${s}:${id}`,
}));
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  consumeSharedToken: async () => ({ ok: true }),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  verifyClientCredentials: (...a: unknown[]) => verifyClientCredentials(...a),
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
}));
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: (...a: unknown[]) => isBetterAuthUserBanned(...a),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: (...a: unknown[]) => mintAccessToken(...a),
}));
vi.mock("@/db/database", () => ({ db: {} }));

const MCP = "https://app.example.com/api/mcp";
const V1 = "https://app.example.com/api/v1";

function req(body: Record<string, string>): NextRequest {
  const url = new URL("http://test.local/api/v1/auth/token");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "POST",
    headers: new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }),
    json: async () => body,
    text: async () => "",
  } as unknown as NextRequest;
}

/** The input the route handed to the signer on its last call. */
function mintInput(): Record<string, unknown> {
  return mintAccessToken.mock.calls.at(-1)![0] as Record<string, unknown>;
}

let POST: (request: NextRequest) => Promise<Response>;

beforeEach(async () => {
  for (const m of [
    auditEvent,
    verifyClientCredentials,
    verifyApiKey,
    isBetterAuthUserBanned,
    mintAccessToken,
    getUserAccessContext,
  ])
    m.mockReset();
  verifyClientCredentials.mockResolvedValue({
    clientRowId: "client-row-1",
    betterAuthUserId: "ba-1",
    scopes: ["account.read"],
    organizationId: "org-1",
  });
  verifyApiKey.mockResolvedValue({
    id: "key-1",
    appUserId: "u-1",
    betterAuthUserId: "ba-1",
    scopes: ["account.read"],
    organizationId: "org-1",
    expiresAt: null,
  });
  isBetterAuthUserBanned.mockResolvedValue(false);
  getUserAccessContext.mockResolvedValue({
    status: "active",
    membershipStatus: "active",
    appUserId: "u-1",
    permissions: [],
  });
  // The signer echoes what it was asked for, so `expires_in` in the response
  // is exactly the TTL the route computed.
  mintAccessToken.mockImplementation(
    async (input: { jti: string; scopes: string[]; ttlSeconds: number; audience: string }) => ({
      token: "eyJ.signed",
      jti: input.jti,
      expiresInSeconds: input.ttlSeconds,
      scopes: input.scopes,
      audience: input.audience,
    }),
  );
  POST = (await import("@/app/api/v1/auth/token/route")).POST;
});
afterEach(() => vi.resetModules());

describe("cid claim — the token names its source credential (review #43)", () => {
  it("stamps the OAuth client row id for client_credentials", async () => {
    const res = await POST(
      req({ grant_type: "client_credentials", client_id: "drkc_x", client_secret: "s" }),
    );
    expect(res.status).toBe(200);
    expect(mintInput().credential).toEqual({ kind: "oauth_client", id: "client-row-1" });
  });

  it("stamps the API key id for api_key", async () => {
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(res.status).toBe(200);
    expect(mintInput().credential).toEqual({ kind: "api_key", id: "key-1" });
  });
});

describe("TTL cap by API key expiry (review #48)", () => {
  it("uses the configured TTL when the key never expires, and reports it as expires_in", async () => {
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(900);
    expect(mintInput().ttlSeconds).toBe(900);
  });

  it("caps the TTL at the seconds remaining until the key expires (floor), reflected in expires_in", async () => {
    verifyApiKey.mockResolvedValue({
      id: "key-1",
      betterAuthUserId: "ba-1",
      scopes: [],
      organizationId: null,
      // 120.9 s left → floor → 120.
      expiresAt: new Date(Date.now() + 120_900),
    });
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expires_in: number };
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(body.expires_in).toBeGreaterThanOrEqual(119);
    expect(mintInput().ttlSeconds).toBe(body.expires_in);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "token.issued",
        metadata: expect.objectContaining({ expiresIn: body.expires_in }),
      }),
    );
  });

  it("keeps the configured TTL when the key expires later than that", async () => {
    verifyApiKey.mockResolvedValue({
      id: "key-1",
      betterAuthUserId: "ba-1",
      scopes: [],
      organizationId: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(900);
  });

  it("boundary: a key expiring in < 1 s is refused (never a 0 / negative TTL)", async () => {
    for (const msLeft of [999, 500, 1]) {
      mintAccessToken.mockClear();
      verifyApiKey.mockResolvedValue({
        id: "key-1",
        betterAuthUserId: "ba-1",
        scopes: [],
        organizationId: null,
        expiresAt: new Date(Date.now() + msLeft),
      });
      const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
      expect(res.status, `${msLeft} ms left`).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_client");
      expect(mintAccessToken).not.toHaveBeenCalled();
    }
  });

  it("boundary: a key with exactly 1 s left mints a 1 s token", async () => {
    verifyApiKey.mockResolvedValue({
      id: "key-1",
      betterAuthUserId: "ba-1",
      scopes: [],
      organizationId: null,
      expiresAt: new Date(Date.now() + 1_999),
    });
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(1);
  });

  it("an already-expired key is refused by verification before any TTL math", async () => {
    // verifyApiKey returns null for `expires_at <= now` (pinned in its own
    // unit tests); the route must treat that as invalid_client.
    verifyApiKey.mockResolvedValue(null);
    const res = await POST(req({ grant_type: "api_key", api_key: "drk_live_x" }));
    expect(res.status).toBe(401);
    expect(mintAccessToken).not.toHaveBeenCalled();
  });

  it("client credentials carry no expiry and always get the configured TTL", async () => {
    const res = await POST(
      req({ grant_type: "client_credentials", client_id: "drkc_x", client_secret: "s" }),
    );
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(900);
  });
});

describe("RFC 8707 resource → audience (review #50/#53)", () => {
  const mint = (extra: Record<string, string>) =>
    POST(
      req({ grant_type: "client_credentials", client_id: "drkc_x", client_secret: "s", ...extra }),
    );

  it("omitted resource → the v1 audience (today's clients are unaffected)", async () => {
    expect((await mint({})).status).toBe(200);
    expect(mintInput().audience).toBe("devresponse-api");
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ resource: V1, audience: "devresponse-api" }),
      }),
    );
  });

  it("resource=<origin>/api/v1 → the v1 audience explicitly", async () => {
    expect((await mint({ resource: V1 })).status).toBe(200);
    expect(mintInput().audience).toBe("devresponse-api");
  });

  it("resource=<origin>/api/mcp → the MCP audience", async () => {
    expect((await mint({ resource: MCP })).status).toBe(200);
    expect(mintInput().audience).toBe(MCP);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ resource: MCP, audience: MCP }),
      }),
    );
  });

  it("an unknown resource is refused with invalid_target and nothing is minted", async () => {
    for (const resource of [
      "https://evil.example.com/api/mcp",
      "https://app.example.com/api/mcp/tools",
      "https://app.example.com/api/mcp#x",
      "garbage",
    ]) {
      mintAccessToken.mockClear();
      const res = await mint({ resource });
      expect(res.status, resource).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = (await res.json()) as { code: string; title: string };
      expect(body.code).toBe("invalid_target");
      expect(body.title).toBe("Invalid target resource");
      expect(mintAccessToken).not.toHaveBeenCalled();
    }
  });

  it("the resource check runs only AFTER the credential verified (no oracle for unauthenticated callers)", async () => {
    verifyClientCredentials.mockResolvedValue(null);
    const res = await mint({ resource: "https://evil.example.com/api/mcp" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_client");
  });
});
