import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { NextRequest } from "next/server";
import type * as EnvModule from "@/lib/env";

/**
 * DB-BACKED test for F-34: a multi-value MCP tool call reaches Postgres as
 * the query the agent asked for.
 *
 * The gateway sent an array argument as ONE comma-joined query value. v1
 * read `filter[status]=blocked,suspended` as a single unknown status and
 * dropped the filter, so "list the blocked and suspended users" answered with
 * EVERY user, active ones included, for the agent to act on;
 * `filter[outcome]=denied,error` matched no audit row, so "were there denials
 * or errors?" read as no; and `sort=created_at.desc,status.asc` came back
 * ascending with the second key gone.
 *
 * Here the MCP route, the gateway's dispatch and argument validation, the v1
 * handlers, the list-query parser and the SQL are all real. Stubbed: caller
 * resolution and token minting at the gateway, the v1 permission guard (an
 * org admin of this suite's org, so the real org scope confines every answer
 * to the fixtures), and `fetch`, which hands the gateway's self-call to the v1
 * handler in-process.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f34_`
 * and clean up after themselves; audit rows go through the sanctioned
 * retention GUC.
 */
const PREFIX = "__dbtest_f34_";
const RUN = randomUUID().slice(0, 8);

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    getServerEnv: () => ({
      ...actual.getServerEnv(),
      MCP_ENABLED: true,
      MCP_AUDIENCE_GRACE: false,
      MCP_FORWARD_CLIENT_IP: false,
      MCP_DISPATCH_BASE_URL: undefined,
      BETTER_AUTH_URL: "https://app.example.com",
    }),
  };
});
vi.mock("@/lib/api-auth/resolve-caller.server", () => ({
  resolveCallerDetailed: async () => ({
    ok: true,
    caller: {
      kind: "api_key",
      betterAuthUserId: `${PREFIX}ba_agent`,
      isBearer: true,
      credentialId: "key-f34",
      boundOrganizationId: null,
      grantedScopes: ["admin.users.read", "admin.audit.read"],
      access: { organizationId: null },
    },
  }),
}));
vi.mock("@/lib/api-auth/jwt.server", () => ({
  mintAccessToken: async () => ({ token: "eyJ.exchanged.v1", audience: "devresponse-api" }),
}));
const grantOrg = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: async () => ({
    ok: true,
    grant: {
      requestId: "req-f34",
      caller: {
        betterAuthUserId: `${PREFIX}ba_agent`,
        credentialId: "key-f34",
        kind: "api_key",
        access: {
          appUserId: null,
          status: "active",
          membershipStatus: "active",
          organizationId: grantOrg.id,
          permissions: ["admin.users.read", "admin.audit.read"],
        },
      },
    },
  }),
  enforceApiRateLimit: () => null,
}));

const { db, pgPool } = await import("@/db/database");
const mcpRoute = await import("@/app/api/mcp/route");
const usersRoute = await import("@/app/api/v1/users/route");
const auditRoute = await import("@/app/api/v1/audit-events/route");

const V1_ROUTES: Record<string, (request: NextRequest) => Promise<Response>> = {
  "/api/v1/users": usersRoute.GET,
  "/api/v1/audit-events": auditRoute.GET,
};
const selfCalls: URL[] = [];

const T_OLD = "2026-01-01T00:00:00.000Z";
const T_NEW = "2026-01-02T00:00:00.000Z";
/** This suite's users, by name; the status each holds and when it was created. */
const USERS = {
  oldBlocked: { status: "blocked", createdAt: T_OLD },
  newSuspended: { status: "suspended", createdAt: T_NEW },
  newBlocked: { status: "blocked", createdAt: T_NEW },
  active: { status: "active", createdAt: T_NEW },
  deactivated: { status: "deactivated", createdAt: T_OLD },
} as const;
type UserName = keyof typeof USERS;
const ids = {} as Record<UserName, string>;
const idToName = new Map<string, UserName>();
let orgId = "";

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  const users = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

beforeAll(async () => {
  await cleanup();
  orgId = (
    await db
      .insertInto("app_organizations")
      .values({ slug: `${PREFIX}org_${RUN}`, name: "F-34 org" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  grantOrg.id = orgId;
  for (const [name, { status, createdAt }] of Object.entries(USERS) as Array<
    [UserName, (typeof USERS)[UserName]]
  >) {
    const ba = `${PREFIX}ba_${name}_${RUN}`;
    const row = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: ba,
        primary_email: `${ba}@dbtest.local`,
        status,
        created_at: sql`${createdAt}::timestamptz`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    idToName.set(row.id, name);
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: orgId, app_user_id: row.id, status: "active" })
      .execute();
  }
  for (const outcome of ["success", "denied", "error", "failure"]) {
    await db
      .insertInto("app_audit_events")
      .values({
        event_type: `dbtest.f34.${outcome}`,
        outcome,
        actor_better_auth_user_id: `${PREFIX}ba_agent`,
        organization_id: orgId,
      })
      .execute();
  }
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

beforeEach(() => {
  selfCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      selfCalls.push(url);
      const handler = V1_ROUTES[url.pathname];
      if (!handler) throw new Error(`unexpected self-call ${url.pathname}`);
      return handler(new NextRequest(url, { method: init?.method, headers: init?.headers }));
    }),
  );
  return () => vi.unstubAllGlobals();
});

interface ToolBody {
  result?: { isError?: boolean; content: Array<{ text: string }> };
  error?: { code: number; message: string };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolBody> {
  const res = await mcpRoute.POST(
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
  return (await res.json()) as ToolBody;
}

/** The v1 list envelope inside a successful tool result's untrusted-data fence. */
function listFrom<T>(body: ToolBody): { items: T[]; total: number } {
  expect(body.error).toBeUndefined();
  const text = body.result!.content[0]!.text;
  expect(body.result!.isError, text).toBeUndefined();
  const token = /--- BEGIN UNTRUSTED DATA ([0-9a-f]{16}) ---/.exec(text)![1];
  const payload = text.split(`--- BEGIN UNTRUSTED DATA ${token} ---\n`)[1]!.split("\n--- END")[0]!;
  return JSON.parse(payload) as { items: T[]; total: number };
}

const names = (items: Array<{ id: string }>) => items.map((u) => idToName.get(u.id));

describe("MCP → v1 → Postgres: multi-value list filters (F-34)", () => {
  it("listUsers blocked + suspended returns exactly those users", async () => {
    const list = listFrom<{ id: string; status: string }>(
      await callTool("listUsers", { "filter[status]": ["blocked", "suspended"] }),
    );
    expect(new Set(names(list.items))).toEqual(
      new Set(["oldBlocked", "newSuspended", "newBlocked"]),
    );
    expect(list.total).toBe(3);
    // One parameter per value on the wire, never a comma-joined one.
    expect(selfCalls[0]!.searchParams.getAll("filter[status]")).toEqual(["blocked", "suspended"]);
  });

  it("listAuditEvents denied + error returns both, and nothing else", async () => {
    const list = listFrom<{ outcome: string; event_type: string }>(
      await callTool("listAuditEvents", { "filter[outcome]": ["denied", "error"] }),
    );
    expect(list.items.map((e) => e.outcome).sort()).toEqual(["denied", "error"]);
    expect(list.total).toBe(2);
  });

  it("keeps each sort direction and honours the second key", async () => {
    const statuses = ["blocked", "suspended"];
    // Newest first; within the tied newest instant, status ascending then
    // descending. A comma-joined sort read the first key as ASCENDING (oldest
    // first) and lost the tiebreak entirely.
    const asc = listFrom<{ id: string }>(
      await callTool("listUsers", {
        "filter[status]": statuses,
        sort: ["created_at.desc", "status.asc"],
      }),
    );
    expect(names(asc.items)).toEqual(["newBlocked", "newSuspended", "oldBlocked"]);
    const desc = listFrom<{ id: string }>(
      await callTool("listUsers", {
        "filter[status]": statuses,
        sort: ["created_at.desc", "status.desc"],
      }),
    );
    expect(names(desc.items)).toEqual(["newSuspended", "newBlocked", "oldBlocked"]);
  });

  it("refuses an unknown status at the gateway, before the API is called", async () => {
    const body = await callTool("listUsers", { "filter[status]": ["blocked", "bogus"] });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("must be one of");
    expect(selfCalls).toEqual([]);
  });

  it("answers a raw comma-joined or unknown value with a 400, never a wider list", async () => {
    for (const query of ["filter[status]=blocked,suspended", "filter[status]=bogus"]) {
      const res = await usersRoute.GET(
        new NextRequest(new URL(`https://app.example.com/api/v1/users?${query}`)),
      );
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    }
    const res = await auditRoute.GET(
      new NextRequest(
        new URL("https://app.example.com/api/v1/audit-events?filter[outcome]=denied,error"),
      ),
    );
    expect(res.status).toBe(400);
  });
});
