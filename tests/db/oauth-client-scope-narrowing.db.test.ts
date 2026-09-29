import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import type { NextRequest } from "next/server";
import type * as AuditModule from "@/lib/audit.server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as EnvModule from "@/lib/env";

/**
 * DB-BACKED test for F-71: narrowing an OAuth client's scopes takes effect on
 * its outstanding tokens at their next request.
 *
 * Two routes narrow a client: `PATCH /api/v1/admin/oauth-clients/{id}` and the
 * Agents console's `PATCH /api/administrator/mcp-agents/{id}`. Both wrote the
 * new scopes and left every token minted before the edit holding the removed
 * ones until `exp` (900 s by default, up to an hour), so an agent caught
 * misusing `admin.users.manage` kept blocking users after an admin took the
 * scope away. The resolver now caps a token's `scope` claim at the scopes its
 * source client holds NOW, read on the revocation check it already makes.
 *
 * Real here: token signing and verification (an ephemeral Ed25519 key), the
 * caller resolver, the revocation read, the `/api/v1` guard, both PATCH
 * routes and their guards, and Postgres. Stubbed: the admin's cookie session,
 * the access contexts (which permissions each principal holds is not what
 * this pins), and the audit writer. Driven by `pnpm test:db`
 * (vitest.db.config.ts). Fixtures use `__dbtest_f71_` and clean up after
 * themselves.
 */
const PREFIX = "__dbtest_f71_";
const RUN = randomUUID().slice(0, 8);
const SERVICE_BA = `${PREFIX}ba_svc_${RUN}`;
const ADMIN_BA = `${PREFIX}ba_admin_${RUN}`;
const WIDE = ["admin.users.read", "admin.users.manage"];
const MCP_AUDIENCE = "https://app.example.com/api/mcp";

const signing = vi.hoisted(() => ({ jwk: "" }));
const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
signing.jwk = JSON.stringify(await exportJWK(privateKey));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    getServerEnv: () => ({
      ...actual.getServerEnv(),
      API_JWT_ENABLED: true,
      API_JWT_PRIVATE_KEY: signing.jwk,
      API_JWT_PREVIOUS_PRIVATE_KEY: undefined,
      API_JWT_ISSUER: "https://app.example.com",
      API_JWT_AUDIENCE: "devresponse-api",
    }),
  };
});
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: async () => ({ user: { id: ADMIN_BA }, session: { id: `${PREFIX}s` } }),
}));
const contexts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: async (id: string) => contexts.get(id) };
});
vi.mock("@/lib/audit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  auditEvent: async () => {},
}));

const { db, pgPool } = await import("@/db/database");
const { createOauthClient } = await import("@/lib/api-auth/oauth-clients.server");
const { mintAccessToken } = await import("@/lib/api-auth/jwt.server");
const { resolveCallerDetailed } = await import("@/lib/api-auth/resolve-caller.server");
const { requireApiPermission } = await import("@/lib/api-auth/v1-guard.server");
const v1ClientRoute = await import("@/app/api/v1/admin/oauth-clients/[id]/route");
const agentRoute = await import("@/app/api/administrator/mcp-agents/[id]/route");

let orgId = "";
let serviceId = "";
let adminId = "";

function request(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const url = new URL(`http://test.local${path}`);
  const headers = new Headers({ "content-type": "application/json" });
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: init.method ?? "GET",
    headers,
    json: async () => init.body,
  } as unknown as NextRequest;
}

async function newClient(): Promise<string> {
  const client = await createOauthClient({
    name: `${PREFIX}client`,
    scopes: WIDE,
    organizationId: orgId,
    serviceAppUserId: serviceId,
    createdByAppUserId: adminId,
  });
  return client.id;
}

/** A token as the token endpoint mints it for this client, before the edit. */
async function tokenFor(clientRowId: string, audience?: string): Promise<string> {
  const minted = await mintAccessToken({
    subject: SERVICE_BA,
    scopes: WIDE,
    organizationId: orgId,
    jti: randomUUID(),
    audience,
    credential: { kind: "oauth_client", id: clientRowId },
  });
  return minted.token;
}

/** The v1 guard's answer for this token and permission: "granted" or the status. */
async function v1Guard(token: string, permission: string): Promise<"granted" | number> {
  const guard = await requireApiPermission(request("/api/v1/users", { token }), permission);
  return guard.ok ? "granted" : guard.response.status;
}

async function cleanup(): Promise<void> {
  const users = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  // The clients cascade with their service user.
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

beforeAll(async () => {
  await cleanup();
  orgId = (
    await db
      .insertInto("app_organizations")
      .values({ slug: `${PREFIX}org_${RUN}`, name: "F-71 org" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  const user = async (betterAuthUserId: string, tag: string) =>
    (
      await db
        .insertInto("app_users")
        .values({
          better_auth_user_id: betterAuthUserId,
          primary_email: `${PREFIX}${tag}_${RUN}@dbtest.local`,
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  serviceId = await user(SERVICE_BA, "svc");
  adminId = await user(ADMIN_BA, "admin");
  // The `mcp` membership is what makes this service user's clients agents,
  // which the Agents console route requires.
  await db
    .insertInto("app_organization_memberships")
    .values({
      organization_id: orgId,
      app_user_id: serviceId,
      status: "active",
      source_provider: "mcp",
    })
    .execute();

  const context = (appUserId: string, permissions: string[]) => ({
    appUserId,
    primaryEmail: `${appUserId}@dbtest.local`,
    status: "active",
    organizationId: orgId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions,
  });
  // The service user holds both permissions throughout: only the client's
  // scope ceiling changes, so any refusal below is the scope cap.
  contexts.set(SERVICE_BA, { ...context(serviceId, WIDE), orgBound: true });
  // An org admin of the same org, acting through its cookie session.
  contexts.set(ADMIN_BA, context(adminId, ["admin.clients.manage", ...WIDE]));
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("narrowing a client's scopes caps its outstanding tokens (F-71)", () => {
  it("PATCH /api/v1/admin/oauth-clients/{id}: the old token loses the removed scope at once", async () => {
    const clientId = await newClient();
    const token = await tokenFor(clientId);
    expect(await v1Guard(token, "admin.users.manage")).toBe("granted");

    const patched = await v1ClientRoute.PATCH(
      request(`/api/v1/admin/oauth-clients/${clientId}`, {
        method: "PATCH",
        body: { scopes: ["admin.users.read"] },
      }),
      { params: Promise.resolve({ id: clientId }) },
    );
    expect(patched.status).toBe(200);

    // The SAME token, still signature-valid and unexpired, whose claim still
    // names both scopes: the removed one is refused, the kept one still works.
    expect(await v1Guard(token, "admin.users.manage")).toBe(403);
    expect(await v1Guard(token, "admin.users.read")).toBe("granted");
  });

  it("PATCH /api/administrator/mcp-agents/{id}: the agent's tokens lose it too, at the gateway as well", async () => {
    const clientId = await newClient();
    const v1Token = await tokenFor(clientId);
    const mcpToken = await tokenFor(clientId, MCP_AUDIENCE);
    expect(await v1Guard(v1Token, "admin.users.manage")).toBe("granted");

    const patched = await agentRoute.PATCH(
      request(`/api/administrator/mcp-agents/${clientId}`, {
        method: "PATCH",
        body: { scopes: ["admin.users.read"] },
      }),
      { params: Promise.resolve({ id: clientId }) },
    );
    expect(patched.status).toBe(200);

    expect(await v1Guard(v1Token, "admin.users.manage")).toBe(403);
    expect(await v1Guard(v1Token, "admin.users.read")).toBe("granted");
    // The gateway resolves the agent's MCP-audience token through the same
    // resolver, and its self-call exchange copies these scopes, so the
    // exchanged v1 token cannot carry the removed scope either.
    const atGateway = await resolveCallerDetailed(request("/api/mcp", { token: mcpToken }), {
      expectedAudience: MCP_AUDIENCE,
    });
    expect(atGateway.ok && atGateway.caller.grantedScopes).toEqual(["admin.users.read"]);
  });
});
