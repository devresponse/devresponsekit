import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests `provisionMcpAgent` with the DB + client-factory mocked: it must
 * create a synthesized machine principal (app_users + membership) at the
 * requested status and a ZERO-SCOPE OAuth client bound to it.
 */
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const createOauthClient = vi.fn();

const transactionRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/db/database", () => ({
  db: {
    // `registerMcpAgent` wraps provisioning in a transaction (review #51);
    // hand the callback the same insert-capturing fake as the pool.
    transaction: () => ({
      execute: (fn: (trx: unknown) => Promise<unknown>) => {
        transactionRuns.count += 1;
        return fn(db);
      },
    }),
    insertInto(table: string) {
      const record = { table, values: {} as Record<string, unknown> };
      inserts.push(record);
      const chain = {
        values(v: Record<string, unknown>) {
          record.values = v;
          return chain;
        },
        returning: () => chain,
        executeTakeFirstOrThrow: () => Promise.resolve({ id: "svc-user-1" }),
        execute: () => Promise.resolve([]),
      };
      return chain;
    },
  },
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  createOauthClient: (...a: unknown[]) => createOauthClient(...a),
}));

import { db } from "@/db/database";
import { provisionMcpAgent, registerMcpAgent } from "@/lib/mcp/registration.server";

beforeEach(() => {
  inserts.length = 0;
  transactionRuns.count = 0;
  createOauthClient.mockReset().mockResolvedValue({
    id: "row-1",
    client_id: "drkc_abc",
    clientSecret: "drkcsec_xyz",
    name: "My Agent",
    scopes: [],
    status: "active",
  });
});

describe("provisionMcpAgent", () => {
  it("creates a scopeless client bound to a synthesized machine principal", async () => {
    const result = await provisionMcpAgent({
      clientName: "My Agent",
      organizationId: "org-1",
      status: "active",
    });

    const usersInsert = inserts.find((i) => i.table === "app_users");
    const membershipInsert = inserts.find((i) => i.table === "app_organization_memberships");
    expect(usersInsert?.values.status).toBe("active");
    expect(String(usersInsert?.values.better_auth_user_id)).toMatch(/^mcp-agent:/);
    expect(membershipInsert?.values).toMatchObject({
      organization_id: "org-1",
      app_user_id: "svc-user-1",
      status: "active",
      source_provider: "mcp",
    });

    expect(createOauthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Agent",
        scopes: [],
        organizationId: "org-1",
        serviceAppUserId: "svc-user-1",
        // Self-registered marker (review #51): the client's creator is its
        // own service user — the quota + reaper key on `created_by =
        // app_user_id`, so this must never become an admin id.
        createdByAppUserId: "svc-user-1",
      }),
      expect.anything(),
    );
    expect(result.client.client_id).toBe("drkc_abc");
    expect(result.betterAuthUserId).toMatch(/^mcp-agent:/);
    expect(result.appUserId).toBe("svc-user-1");
  });

  it("parks the account pending in approval mode", async () => {
    await provisionMcpAgent({
      clientName: "A",
      organizationId: "org-1",
      status: "pending_approval",
    });
    const usersInsert = inserts.find((i) => i.table === "app_users");
    const membershipInsert = inserts.find((i) => i.table === "app_organization_memberships");
    expect(usersInsert?.values.status).toBe("pending_approval");
    expect(membershipInsert?.values.status).toBe("pending_approval");
  });
});

describe("registerMcpAgent (review #51)", () => {
  it("with an unlimited quota (0) provisions inside a transaction without counting", async () => {
    const result = await registerMcpAgent({
      clientName: "A",
      organizationId: "org-1",
      status: "pending_approval",
      maxPerOrg: 0,
    });
    expect(result.ok).toBe(true);
    expect(transactionRuns.count).toBe(1);
    expect(inserts.map((i) => i.table)).toEqual(["app_users", "app_organization_memberships"]);
    // The client insert is handed the TRANSACTION executor, not the pool.
    expect(createOauthClient).toHaveBeenCalledWith(expect.anything(), db);
  });
});
