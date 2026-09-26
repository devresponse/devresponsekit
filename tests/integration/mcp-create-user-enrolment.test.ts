import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * F-480, through the MCP gateway: an agent's `createUser` tool call is a
 * `POST /api/v1/users` by the agent's credential, and that create enrols the
 * new user in the credential's org. An agent approved with only the
 * `admin.users.create` scope used to mint an ACTIVE member of its org, with a
 * password it chose, although it held neither the membership permission
 * (`admin.users.update` / `admin.orgs.update`) nor the approval permission
 * (`admin.users.manage`). Now the call fails as a tool error carrying the
 * v1 problem's `detail`, and nothing is written.
 *
 * The REAL gateway (`/api/mcp` → `tools.server.ts`), the REAL v1 permission
 * guard and the REAL v1 create route run. Only the edges are stubbed: caller
 * resolution (the same API key for the gateway and for the v1 guard, as the
 * exchanged token would resolve), token minting, Better Auth, the audit writer
 * and the database, which records inserts. `fetch`, the gateway's self-call,
 * is routed into the v1 handler in-process.
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
const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";

/** The agent's key: bound to one org, owned by a principal holding every key. */
const agent = vi.hoisted(() => ({ scopes: [] as string[] }));
const auditMock = vi.hoisted(() => vi.fn());
const createBetterAuthUser = vi.hoisted(() => vi.fn());
const mintAccessToken = vi.hoisted(() => vi.fn());

/** Every INSERT the create made: `[table, values]`. */
const inserts = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
function fakeDb(): unknown {
  // Reads find nothing (no existing address, no email-domain binding); an
  // insert returns its own values with an id; the org lookup returns a slug.
  function chain(table: string): unknown {
    let values: Record<string, unknown> | null = null;
    const self: Record<string, unknown> = {
      select: () => self,
      where: () => self,
      returning: () => self,
      values: (v: Record<string, unknown>) => {
        values = v;
        inserts.push([table, v]);
        return self;
      },
      executeTakeFirst: async () => (values ? { id: crypto.randomUUID(), ...values } : undefined),
      executeTakeFirstOrThrow: async () =>
        values ? { id: crypto.randomUUID(), ...values } : { slug: "org-a" },
    };
    return self;
  }
  const handle = {
    selectFrom: (table: string) => chain(table),
    insertInto: (table: string) => chain(table),
  };
  return {
    ...handle,
    transaction: () => ({
      execute: async <T>(callback: (trx: typeof handle) => Promise<T>) => callback(handle),
    }),
  };
}

vi.mock("@/lib/env", () => ({
  getServerEnv: () => env,
  intFromEnv: (_name: string, fallback: number) => fallback,
}));
vi.mock("@/lib/api-auth/resolve-caller.server", () => {
  const resolveCallerDetailed = async () => ({
    ok: true,
    caller: agentCaller(),
  });
  return {
    hasBearerCredential: (headers: Headers) =>
      /^bearer\s/i.test(headers.get("authorization") ?? ""),
    resolveCallerDetailed,
    resolveCaller: async () => (await resolveCallerDetailed()).caller,
  };
});
function agentCaller() {
  return {
    kind: "api_key",
    betterAuthUserId: "ba-agent-owner",
    isBearer: true,
    credentialId: "key-1",
    boundOrganizationId: ORG_ID,
    impersonatorId: null,
    grantedScopes: agent.scopes,
    access: {
      appUserId: "u-owner",
      primaryEmail: "owner@example.com",
      status: "active",
      membershipStatus: "active",
      preferredLocale: "en",
      organizationId: ORG_ID,
      orgBound: true,
      permissions: [
        "superuser",
        "admin.users.create",
        "admin.users.read",
        "admin.users.update",
        "admin.users.manage",
        "admin.orgs.update",
      ],
    },
  };
}
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: (...a: unknown[]) => mintAccessToken(...a),
}));
vi.mock("@/db/database", () => ({ db: fakeDb() }));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  createBetterAuthUser: (...a: unknown[]) => createBetterAuthUser(...a),
}));

import { POST as mcpPost } from "@/app/api/mcp/route";
import { POST as createUserRoute } from "@/app/api/v1/users/route";

/** The gateway's self-call, answered in-process by the real v1 handler. */
async function routeSelfCall(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname !== "/api/v1/users" || init?.method !== "POST") {
    throw new Error(`unexpected self-call ${init?.method} ${url.pathname}`);
  }
  return createUserRoute(
    new NextRequest(url, { method: init.method, headers: init.headers, body: init.body }),
  );
}

async function callCreateUser(args: Record<string, unknown>) {
  const res = await mcpPost(
    new NextRequest("https://app.example.com/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer drk_live_agent" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "createUser", arguments: args },
      }),
    }),
  );
  return (await res.json()) as {
    result?: { isError?: boolean; content: Array<{ text: string }> };
    error?: { code: number; message: string };
  };
}

const createDenied = () =>
  auditMock.mock.calls
    .map(([row]) => row as Record<string, unknown>)
    .filter((row) => row.eventType === "admin.user.create_denied");

beforeEach(() => {
  inserts.length = 0;
  auditMock.mockReset();
  createBetterAuthUser.mockReset();
  createBetterAuthUser.mockResolvedValue({ user: { id: "ba-new" } });
  mintAccessToken.mockReset();
  mintAccessToken.mockResolvedValue({ token: "eyJ.exchanged.v1", audience: "devresponse-api" });
  vi.stubGlobal("fetch", vi.fn(routeSelfCall));
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP createUser → POST /api/v1/users (F-480)", () => {
  it.each(["pending_approval", "active"])(
    'an agent scoped to ["admin.users.create"] creating a %s user gets a tool error, and nothing is written',
    async (initialAppStatus) => {
      agent.scopes = ["admin.users.create"];
      const body = await callCreateUser({
        email: "agent.made@example.com",
        password: "Agent-Password-1",
        initialAppStatus,
      });

      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBe(true);
      const text = body.result!.content[0]!.text;
      expect(text).toContain("HTTP 403");
      expect(text).toContain("admin.users.update or admin.orgs.update");
      // The exchanged token carried the key's scopes, and no more.
      expect(mintAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ["admin.users.create"], organizationId: ORG_ID }),
      );

      expect(createBetterAuthUser).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
      expect(createDenied()).toEqual([
        expect.objectContaining({
          outcome: "denied",
          reason: "enrolment_not_permitted",
          organizationId: ORG_ID,
          email: "agent.made@example.com",
          metadata: expect.objectContaining({ via: "api.v1" }),
        }),
      ]);
    },
  );

  it("an agent scoped to create and update may not create an ACTIVE user", async () => {
    agent.scopes = ["admin.users.create", "admin.users.update"];
    const body = await callCreateUser({
      email: "agent.active@example.com",
      password: "Agent-Password-1",
      initialAppStatus: "active",
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result!.content[0]!.text).toContain("admin.users.manage");
    expect(createBetterAuthUser).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(createDenied()).toEqual([
      expect.objectContaining({ reason: "activation_not_permitted" }),
    ]);
  });

  it("the same agent creates a PENDING user, enrolled as a pending member of its org", async () => {
    agent.scopes = ["admin.users.create", "admin.users.update"];
    const body = await callCreateUser({
      email: "agent.pending@example.com",
      password: "Agent-Password-1",
    });
    expect(body.result?.isError, body.result?.content[0]?.text).toBeUndefined();
    expect(body.result!.content[0]!.text).toContain("HTTP 201");
    expect(createBetterAuthUser).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([
      ["app_users", expect.objectContaining({ status: "pending_approval" })],
      [
        "app_organization_memberships",
        { organization_id: ORG_ID, app_user_id: expect.any(String), status: "pending_approval" },
      ],
    ]);
    expect(createDenied()).toEqual([]);
  });
});
