import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the `/api/mcp` endpoint. Env, caller resolution, and
 * the outgoing v1 call (self-fetch) are mocked, so these exercise the
 * transport contract: the dark gate, bearer-only auth (401 + resource
 * metadata), JSON-RPC routing, and generated-tool dispatch.
 */
const env = vi.hoisted(() => ({ MCP_ENABLED: true, BETTER_AUTH_URL: "https://app.example.com" }));
const resolveCaller = vi.fn();

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...args: unknown[]) => resolveCaller(...args),
}));

import { GET, POST } from "@/app/api/mcp/route";

function post(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://app.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function apiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  env.MCP_ENABLED = true;
  resolveCaller
    .mockReset()
    .mockResolvedValue({ kind: "api_key", betterAuthUserId: "u1", isBearer: true });
  fetchMock = vi.fn().mockResolvedValue(apiResponse(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/mcp", () => {
  it("404s (dark) when MCP is disabled", async () => {
    env.MCP_ENABLED = false;
    expect((await POST(post({ jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(404);
    expect((await GET()).status).toBe(404);
  });

  it("405s a GET — no server-initiated SSE stream", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("202s a notification without invoking auth", async () => {
    const res = await POST(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(resolveCaller).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request with WWW-Authenticate + resource_metadata", async () => {
    resolveCaller.mockResolvedValue(null);
    const res = await POST(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });

  it("rejects a cookie session — MCP requires a bearer credential", async () => {
    resolveCaller.mockResolvedValue({ kind: "session", betterAuthUserId: "u1", isBearer: false });
    expect((await POST(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status).toBe(401);
  });

  it("handles initialize", async () => {
    const body = await (
      await POST(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
      )
    ).json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("devresponsekit");
  });

  it("lists the generated tool surface (excluding public/special ops)", async () => {
    const body = await (await POST(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["getMe", "listUsers", "createUser", "rotateOauthClientSecret"]),
    );
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).not.toContain("issueToken");
    expect(names).not.toContain("getJwks");
  });

  it("dispatches tools/call getMe to the v1 API, forwarding the bearer", async () => {
    fetchMock.mockResolvedValue(
      apiResponse(200, { betterAuthUserId: "u1", effectiveScopes: ["account.read"] }),
    );
    const res = await POST(
      post(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "getMe", arguments: {} } },
        { authorization: "Bearer drk_live_x" },
      ),
    );
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain("account.read");
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://app.example.com/api/v1/me");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer drk_live_x",
    );
  });

  it("substitutes path params and sends a JSON body (updateOauthClient → PATCH)", async () => {
    await POST(
      post({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "updateOauthClient", arguments: { id: "abc-123", name: "renamed" } },
      }),
    );
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://app.example.com/api/v1/admin/oauth-clients/abc-123");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ name: "renamed" });
  });

  it("surfaces a v1 403 as a tool error result (not a transport failure)", async () => {
    fetchMock.mockResolvedValue(apiResponse(403, { title: "Forbidden", detail: "missing scope" }));
    const body = await (
      await POST(
        post({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "listUsers", arguments: {} },
        }),
      )
    ).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("403");
  });

  it("errors on an unknown tool and an unknown method", async () => {
    const unknownTool = await (
      await POST(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }))
    ).json();
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = await (
      await POST(post({ jsonrpc: "2.0", id: 7, method: "does/not/exist" }))
    ).json();
    expect(unknownMethod.error.code).toBe(-32601);
  });
});
