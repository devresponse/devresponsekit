import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the `/api/mcp` Model Context Protocol gateway against REAL
 * credentials (review #29). The route tests mock `resolveCaller`, so nothing
 * else proves that a bearer minted by the live token endpoint actually opens
 * the gateway while a live Better Auth session cookie does not:
 *
 *   - `initialize` + `tools/list` with a client-credentials JWT → 200, a
 *     non-empty `tools` array;
 *   - the SAME requests carrying only the admin's session cookie → 401 with
 *     the RFC 9728 `WWW-Authenticate` challenge (a cookie is not an
 *     audience-bound OAuth token, so the gateway must refuse it even though
 *     the very same cookie authenticates the admin API).
 *
 * Requires the gateway and the machine API to be enabled (`MCP_ENABLED=1`,
 * `API_JWT_ENABLED=1` + a signing key) — CI sets all three in the `browser`
 * job; the dark gateway 404s otherwise.
 */
test.beforeEach(async ({ page }) => {
  await signInAsSeedAdmin(page);
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function rpc(
  api: APIRequestContext,
  id: number,
  method: string,
  params: Record<string, unknown>,
  bearer?: string,
) {
  return api.post("/api/mcp", {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    data: { jsonrpc: "2.0", id, method, params },
  });
}

test("MCP accepts a bearer JWT and refuses a session cookie", async ({
  page,
  request,
}, testInfo) => {
  // --- Mint a real bearer the way an agent would: register an OAuth client
  // owned by the seeded admin's service principal, then exchange it.
  const meRes = await page.request.get("/api/v1/me");
  expect(meRes.ok(), await meRes.text()).toBe(true);
  const me = (await meRes.json()) as { appUserId: string; betterAuthUserId: string };

  const createRes = await page.request.post("/api/v1/admin/oauth-clients", {
    headers: ADMIN_API_HEADERS,
    data: {
      name: `e2e-mcp-${testInfo.project.name}-${Date.now()}`,
      scopes: ["account.read"],
      serviceAppUserId: me.appUserId,
    },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const client = (await createRes.json()) as {
    id: string;
    clientId: string;
    clientSecret: string;
  };

  try {
    const tokenRes = await request.post("/api/v1/auth/token", {
      data: {
        grant_type: "client_credentials",
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
    });
    expect(tokenRes.ok(), await tokenRes.text()).toBe(true);
    const { access_token: bearer } = (await tokenRes.json()) as { access_token: string };
    expect(bearer).toBeTruthy();

    // --- Bearer path. The `request` fixture is a cookieless context, so a 200
    // here is the token alone opening the gateway.
    const init = await rpc(
      request,
      1,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e" } },
      bearer,
    );
    expect(init.status(), await init.text()).toBe(200);
    const initBody = (await init.json()) as JsonRpcResponse;
    expect(initBody.error).toBeUndefined();
    expect(initBody.id).toBe(1);
    expect(initBody.result?.protocolVersion).toBe("2025-06-18");
    expect((initBody.result?.serverInfo as { name: string }).name).toBe("devresponsekit");

    const list = await rpc(request, 2, "tools/list", {}, bearer);
    expect(list.status(), await list.text()).toBe(200);
    const listBody = (await list.json()) as JsonRpcResponse;
    expect(listBody.error).toBeUndefined();
    const tools = listBody.result?.tools as { name: string; inputSchema: unknown }[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain("getMe");
    // The token endpoint and JWKS are not tools — they are the auth surface.
    expect(tools.map((t) => t.name)).not.toContain("issueToken");

    // A tool call goes all the way through to the v1 API AS the bearer: the
    // identity that comes back is the client's service principal (the admin).
    const call = await rpc(request, 3, "tools/call", { name: "getMe", arguments: {} }, bearer);
    expect(call.status(), await call.text()).toBe(200);
    const callBody = (await call.json()) as JsonRpcResponse;
    expect(callBody.error).toBeUndefined();
    const result = callBody.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain(me.betterAuthUserId);

    // --- Cookie path: `page.request` carries the admin's live session cookie
    // (it just authenticated the admin API above) and NO bearer.
    for (const [id, method, params] of [
      [10, "initialize", { protocolVersion: "2025-06-18" }],
      [11, "tools/list", {}],
    ] as const) {
      const res = await rpc(page.request, id, method, params);
      expect(res.status(), `${method} with a cookie only`).toBe(401);
      const wwwAuth = res.headers()["www-authenticate"] ?? "";
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain("resource_metadata=");
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.id).toBe(id);
      expect(body.result).toBeUndefined();
      expect(body.error?.message).toBe("Unauthorized");
    }
  } finally {
    const revoke = await page.request.delete(`/api/v1/admin/oauth-clients/${client.id}`, {
      headers: ADMIN_API_HEADERS,
    });
    expect(revoke.ok(), await revoke.text()).toBe(true);
  }
});
