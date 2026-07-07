import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the `/api/mcp` Phase 0 endpoint. The env flag,
 * caller resolution, and the two proxied v1 route handlers are mocked, so
 * these exercise the transport contract: the dark-by-default gate, the
 * auth 401, JSON-RPC method routing, and tool proxying + error mapping.
 */
const env = vi.hoisted(() => ({ MCP_ENABLED: true }));
const resolveCaller = vi.fn();
const meGet = vi.fn();
const usersGet = vi.fn();

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCaller: (...args: unknown[]) => resolveCaller(...args),
}));
vi.mock("@/app/api/v1/me/route", () => ({ GET: (...args: unknown[]) => meGet(...args) }));
vi.mock("@/app/api/v1/users/route", () => ({ GET: (...args: unknown[]) => usersGet(...args) }));

import { GET, POST } from "@/app/api/mcp/route";

function post(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://app.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  env.MCP_ENABLED = true;
  resolveCaller.mockReset().mockResolvedValue({ kind: "api_key", betterAuthUserId: "u1" });
  meGet.mockReset();
  usersGet.mockReset();
});

describe("/api/mcp (Phase 0)", () => {
  it("404s (dark) when MCP is disabled", async () => {
    env.MCP_ENABLED = false;
    expect((await POST(post({ jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(404);
    expect((await GET()).status).toBe(404);
  });

  it("405s a GET — no server-initiated SSE stream in Phase 0", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("202s a notification without invoking auth", async () => {
    const res = await POST(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(resolveCaller).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request with WWW-Authenticate", async () => {
    resolveCaller.mockResolvedValue(null);
    const res = await POST(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("handles initialize", async () => {
    const res = await POST(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("devresponsekit");
  });

  it("lists the two read-only tools", async () => {
    const body = await (await POST(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["users_list", "whoami"]);
    expect(
      body.result.tools.every(
        (t: { annotations?: { readOnlyHint?: boolean } }) => t.annotations?.readOnlyHint === true,
      ),
    ).toBe(true);
  });

  it("proxies tools/call whoami to GET /api/v1/me and forwards the bearer", async () => {
    meGet.mockResolvedValue(
      jsonResponse(200, { betterAuthUserId: "u1", effectiveScopes: ["account.read"] }),
    );
    const res = await POST(
      post(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
        { authorization: "Bearer drk_live_x" },
      ),
    );
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain("account.read");
    const subRequest = meGet.mock.calls[0]![0] as NextRequest;
    expect(subRequest.headers.get("authorization")).toBe("Bearer drk_live_x");
  });

  it("surfaces a v1 403 as a tool error result (not a transport failure)", async () => {
    usersGet.mockResolvedValue(jsonResponse(403, { title: "Forbidden", detail: "missing scope" }));
    const body = await (
      await POST(
        post({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "users_list", arguments: {} },
        }),
      )
    ).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("403");
  });

  it("errors on an unknown tool and an unknown method", async () => {
    const unknownTool = await (
      await POST(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }))
    ).json();
    expect(unknownTool.error.code).toBe(-32602);

    const unknownMethod = await (
      await POST(post({ jsonrpc: "2.0", id: 6, method: "does/not/exist" }))
    ).json();
    expect(unknownMethod.error.code).toBe(-32601);
  });
});
