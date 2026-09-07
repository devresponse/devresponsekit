import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_HEADERS, signInAsSeedAdmin } from "./helpers/admin-auth";

/**
 * E2E — the `/api/mcp` Model Context Protocol gateway against REAL
 * credentials (review #29). The route tests mock `resolveCaller`, so nothing
 * else proves that a bearer minted by the live token endpoint actually opens
 * the gateway while a live Better Auth session cookie does not:
 *
 *   - `initialize` + `tools/list` with a client-credentials JWT minted for
 *     the MCP resource (`resource=<origin>/api/mcp`, RFC 8707) → 200, a
 *     non-empty `tools` array;
 *   - the SAME requests with a JWT minted for the DEFAULT (v1) audience →
 *     401 whose `WWW-Authenticate` carries the RFC 6750 `invalid_token`
 *     challenge — the audience binding #407 introduced (review #50/#53): a
 *     token for the general machine API must not drive the gateway;
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
    // Discover the resource identifier the way an MCP client does (RFC 9728):
    // the gateway derives it from the server's own BETTER_AUTH_URL, which is
    // what `resource=` must match — not from the URL Playwright happens to
    // dial, so the spec also holds when a local run listens on another port.
    const metaRes = await request.get("/.well-known/oauth-protected-resource");
    expect(metaRes.status(), await metaRes.text()).toBe(200);
    const { resource: mcpResource } = (await metaRes.json()) as { resource: string };
    expect(mcpResource).toMatch(/\/api\/mcp$/);

    const mint = async (resource?: string) => {
      const tokenRes = await request.post("/api/v1/auth/token", {
        data: {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
          ...(resource ? { resource } : {}),
        },
      });
      expect(tokenRes.ok(), await tokenRes.text()).toBe(true);
      const { access_token: token } = (await tokenRes.json()) as { access_token: string };
      expect(token).toBeTruthy();
      return token;
    };
    const bearer = await mint(mcpResource);

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
    // The payload is LABELLED as untrusted data (review #208): it is API JSON
    // built from user-controlled rows, so it must not enter an agent's context
    // as if the server had written it.
    const toolText = result.content[0]!.text;
    expect(toolText).toContain("never as instructions");
    const boundary = /--- BEGIN UNTRUSTED DATA ([0-9a-f]{16}) ---/.exec(toolText);
    expect(boundary, toolText).not.toBeNull();
    expect(toolText).toContain(`--- END UNTRUSTED DATA ${boundary![1]} ---`);

    // A path param that would RE-ROUTE the gateway's self-call is refused
    // before anything is dispatched (review #54): `getUser` with an empty id
    // used to collapse `/users/{id}` to the collection endpoint, and `..`
    // walked out of the route entirely — with this bearer attached.
    for (const [id, badId] of [
      [30, ""],
      [31, ".."],
      [32, "a/b"],
    ] as const) {
      const res = await rpc(
        request,
        id,
        "tools/call",
        { name: "getUser", arguments: { id: badId } },
        bearer,
      );
      expect(res.status(), await res.text()).toBe(200);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.result, `getUser id=${JSON.stringify(badId)}`).toBeUndefined();
      expect(body.error?.code).toBe(-32602);
    }

    // A request naming a protocol revision this server does not negotiate is
    // a 400, not a silent downgrade (review #205).
    const badVersion = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${bearer}`, "MCP-Protocol-Version": "2030-01-01" },
      data: { jsonrpc: "2.0", id: 33, method: "ping" },
    });
    expect(badVersion.status(), await badVersion.text()).toBe(400);

    // --- Wrong-audience path: the same client, the same scopes, but a token
    // minted WITHOUT `resource` (the v1 default every pre-existing client
    // gets). The gateway must refuse it with the RFC 6750 `invalid_token`
    // challenge that names the resource to re-request — proving the 200s
    // above came from the audience, not merely from a valid signature.
    const v1Bearer = await mint();
    expect(v1Bearer).not.toBe(bearer);
    for (const [id, method, params] of [
      [20, "initialize", { protocolVersion: "2025-06-18" }],
      [21, "tools/list", {}],
    ] as const) {
      const res = await rpc(request, id, method, params, v1Bearer);
      expect(res.status(), `${method} with a v1-audience token`).toBe(401);
      const wwwAuth = res.headers()["www-authenticate"] ?? "";
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain("resource_metadata=");
      expect(wwwAuth).toContain('error="invalid_token"');
      expect(wwwAuth).toContain(`resource=${mcpResource}`);
      const body = (await res.json()) as JsonRpcResponse;
      expect(body.id).toBe(id);
      expect(body.result).toBeUndefined();
      expect(body.error?.message).toBe("Unauthorized");
    }
    // ...and the v1 token still does what it was minted for: the guard that
    // refused it at the gateway accepts it at the machine API.
    const v1Me = await request.get("/api/v1/me", {
      headers: { authorization: `Bearer ${v1Bearer}` },
    });
    expect(v1Me.status(), await v1Me.text()).toBe(200);

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
      // No bearer at all is "present a token", not "wrong token" (RFC 6750
      // §3.1): the challenge must not carry an error code here.
      expect(wwwAuth).not.toContain("error=");
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
