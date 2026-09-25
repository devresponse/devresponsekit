import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * F-34, end to end: an MCP `tools/call` through the REAL gateway dispatch
 * (`/api/mcp` → `tools.server.ts`) into the REAL `/api/v1` list handlers.
 *
 * The gateway sent an array argument as ONE comma-joined query value, and v1
 * could not read that as a list: `listUsers {"filter[status]": ["blocked",
 * "suspended"]}` became `filter[status]=blocked,suspended`, which the users
 * route dropped as an unknown status — the agent got EVERY user back as the
 * blocked ones — `listAuditEvents` with two outcomes matched no row at all,
 * and `sort: ["created_at.desc", "status.asc"]` came back ascending.
 *
 * Only the edges are stubbed: caller resolution and token minting at the
 * gateway, the v1 permission guard (an org admin), and the database, which
 * RECORDS the query builder calls so the assertions are about the SQL the
 * handler built. `fetch` — the gateway's self-call — is routed into the v1
 * handler in-process. The same path against a live Postgres is
 * tests/db/mcp-v1-list-filters.db.test.ts.
 */
const env = vi.hoisted(() => ({
  MCP_ENABLED: true,
  MCP_AUDIENCE_GRACE: false,
  MCP_FORWARD_CLIENT_IP: false,
  MCP_DISPATCH_BASE_URL: undefined as string | undefined,
  BETTER_AUTH_URL: "https://app.example.com",
  API_JWT_AUDIENCE: "devresponse-api",
  API_JWT_ENABLED: true,
}));

/** Every query-builder call the handler made, in order: `[method, args]`. */
const calls = vi.hoisted(() => [] as Array<[string, unknown[]]>);
function recordingChain(): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "execute") return () => Promise.resolve([]);
      if (prop === "executeTakeFirst") return () => Promise.resolve(undefined);
      return (...args: unknown[]) => {
        calls.push([String(prop), args]);
        return recordingChain();
      };
    },
  });
}

vi.mock("@/lib/env", () => ({
  getServerEnv: () => env,
  intFromEnv: (_name: string, fallback: number) => fallback,
}));
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCallerDetailed: async () => ({
    ok: true,
    caller: {
      kind: "api_key",
      betterAuthUserId: "ba-1",
      isBearer: true,
      credentialId: "key-1",
      boundOrganizationId: "org-1",
      grantedScopes: ["admin.users.read", "admin.audit.read"],
      access: { organizationId: "org-1" },
    },
  }),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: async () => ({ token: "eyJ.exchanged.v1", audience: "devresponse-api" }),
}));
/** An org admin: `resolveOrgScope` runs for real and yields `org-1`. */
vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: async () => ({
    ok: true,
    grant: {
      requestId: "req-1",
      caller: {
        betterAuthUserId: "ba-1",
        credentialId: "key-1",
        kind: "api_key",
        access: {
          appUserId: "u-1",
          status: "active",
          membershipStatus: "active",
          organizationId: "org-1",
          permissions: ["admin.users.read", "admin.audit.read"],
        },
      },
    },
  }),
  enforceApiRateLimit: () => null,
}));
vi.mock("@/db/database", () => ({
  db: { selectFrom: (...args: unknown[]) => (calls.push(["selectFrom", args]), recordingChain()) },
}));
// Imported by the users route's POST; not what this file exercises.
vi.mock("@/lib/admin/audit-helpers.server", () => ({ auditUserAction: vi.fn() }));
vi.mock("@/lib/admin/auth-admin.server", () => ({ createBetterAuthUser: vi.fn() }));

import { POST as mcpPost } from "@/app/api/mcp/route";
import { GET as listUsersRoute } from "@/app/api/v1/users/route";
import { GET as listAuditEventsRoute } from "@/app/api/v1/audit-events/route";

const V1_ROUTES: Record<string, (request: NextRequest) => Promise<Response>> = {
  "/api/v1/users": listUsersRoute,
  "/api/v1/audit-events": listAuditEventsRoute,
};

/** The gateway's self-call, answered in-process by the real v1 handler. */
const selfCalls: URL[] = [];
async function routeSelfCall(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  selfCalls.push(url);
  const handler = V1_ROUTES[url.pathname];
  if (!handler) throw new Error(`unexpected self-call ${url.pathname}`);
  return handler(new NextRequest(url, { method: init?.method, headers: init?.headers }));
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await mcpPost(
    new NextRequest("https://app.example.com/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer drk_live_x" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  return (await res.json()) as {
    result?: { isError?: boolean; content: Array<{ text: string }> };
    error?: { code: number; message: string };
  };
}

/** The API payload inside the tool result's untrusted-data fence. */
function fencedPayload(text: string): string {
  const token = /--- BEGIN UNTRUSTED DATA ([0-9a-f]{16}) ---/.exec(text)?.[1];
  expect(token, text).toBeDefined();
  return text.split(`--- BEGIN UNTRUSTED DATA ${token} ---\n`)[1]!.split(`\n--- END`)[0]!;
}

/** The `where(column, op, value)` calls the handler made (callbacks skipped). */
function columnWheres(): unknown[][] {
  return calls
    .filter(([m, args]) => m === "where" && typeof args[0] === "string")
    .map(([, a]) => a);
}

beforeEach(() => {
  calls.length = 0;
  selfCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(routeSelfCall));
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP → v1 list filters (F-34)", () => {
  it("listUsers with two statuses filters on BOTH, not on none", async () => {
    const body = await callTool("listUsers", { "filter[status]": ["blocked", "suspended"] });
    expect(body.error).toBeUndefined();
    expect(body.result?.isError, body.result?.content[0]?.text).toBeUndefined();
    expect(selfCalls[0]!.searchParams.getAll("filter[status]")).toEqual(["blocked", "suspended"]);
    expect(columnWheres()).toContainEqual(["status", "in", ["blocked", "suspended"]]);
  });

  it("listAuditEvents with two outcomes matches EITHER, inside the caller's org", async () => {
    const body = await callTool("listAuditEvents", { "filter[outcome]": ["denied", "error"] });
    expect(body.result?.isError, body.result?.content[0]?.text).toBeUndefined();
    expect(columnWheres()).toEqual([
      ["organization_id", "=", "org-1"],
      ["outcome", "in", ["denied", "error"]],
    ]);
  });

  it("applies several sort directives in order, each in its own direction", async () => {
    const body = await callTool("listUsers", { sort: ["created_at.desc", "status.asc"] });
    const payload = JSON.parse(fencedPayload(body.result!.content[0]!.text)) as { sort: unknown };
    expect(payload.sort).toEqual([
      { field: "created_at", direction: "desc" },
      { field: "status", direction: "asc" },
    ]);
    const directions = calls.filter(([m]) => m === "orderBy").map(([, args]) => args[1]);
    // The two directives, then the `id` tiebreaker every OFFSET page ends on (F-41).
    expect(directions).toEqual(["desc", "asc", "asc"]);
  });

  it("surfaces a v1 400 as a tool error — never as an unfiltered page", async () => {
    // Past the gateway's schema check (a string), refused by v1: an empty
    // exact-match value used to match nothing at all, silently.
    const body = await callTool("listAuditEvents", { "filter[event_type]": [""] });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toContain("HTTP 400");
    expect(fencedPayload(body.result!.content[0]!.text)).toBe(
      "`filter[event_type]` must not be empty.",
    );
    expect(calls.filter(([m]) => m === "selectFrom")).toEqual([]);
  });

  it("refuses an unknown status at the gateway: the API is never called", async () => {
    const body = await callTool("listUsers", { "filter[status]": ["bogus"] });
    expect(body.error?.code).toBe(-32602);
    expect(selfCalls).toEqual([]);
  });
});

/**
 * The raw v1 contract behind the same fix: whatever a client sends that the
 * route cannot apply is a `400 invalid_request` problem, not a dropped
 * filter (which widened the answer to every row) and not a comma split.
 */
describe("GET /api/v1/users and /api/v1/audit-events — strict list queries (F-34)", () => {
  const get = (path: string, query: string) => {
    const url = new URL(`https://app.example.com${path}?${query}`);
    return V1_ROUTES[path]!(new NextRequest(url));
  };

  it.each([
    ["/api/v1/users", "filter%5Bstatus%5D=blocked%2Csuspended", /repeat the parameter/],
    ["/api/v1/users", "filter[status]=bogus", /one of: active, pending_approval/],
    ["/api/v1/users", "filter[role]=admin", /filters on: filter\[status\]\./],
    ["/api/v1/users", "sort=created_at.desc%2Cstatus.asc", /`sort` value/],
    ["/api/v1/users", "sort=password.asc", /`sort` value/],
    ["/api/v1/audit-events", "filter[outcome]=denied,error", /repeat the parameter/],
    ["/api/v1/audit-events", "filter[outcome]=oops", /one of: success, denied, error, failure/],
    ["/api/v1/audit-events", "filter[created_at][from]=2026-01-01", /filters on:/],
  ])("%s?%s is a 400 problem, and queries nothing", async (path, query, detail) => {
    const res = await get(path, query);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await res.json()) as { code: string; detail: string; requestId: string };
    expect(problem).toMatchObject({ code: "invalid_request", requestId: "req-1" });
    expect(problem.detail).toMatch(detail);
    expect(calls).toEqual([]);
  });

  it("repeated values of a free-text filter are all applied, commas and all", async () => {
    const res = await get(
      "/api/v1/audit-events",
      "filter[event_type]=a.b&filter[event_type]=c%2Cd&filter[outcome]=success",
    );
    expect(res.status).toBe(200);
    expect(columnWheres()).toEqual([
      ["organization_id", "=", "org-1"],
      ["event_type", "in", ["a.b", "c,d"]],
      ["outcome", "in", ["success"]],
    ]);
  });
});
