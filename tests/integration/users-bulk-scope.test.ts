import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/users/bulk/route";

/**
 * ADR-0001 — bulk user actions are confined to the actor's org.
 *   - A null-scope admin acts on no one (attempted 0).
 *   - An ORG ADMIN's batch resolves only org-member targets: a foreign-org
 *     id passed alongside a valid one is dropped to `not_found`, never acted
 *     on — proving the route operates on the org-scoped resolved set, not
 *     the raw request id list (explicit ids AND "select all").
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const bulkExecMock = vi.fn();

const state: {
  targets: Array<{
    id: string;
    better_auth_user_id: string;
    primary_email: string;
    status: string;
  }>;
} = {
  targets: [],
};

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({ auditUserAction: () => {} }));
vi.mock("@/lib/audit.server", () => ({ auditEvent: () => {} }));
// Fully mocked (NOT importActual) so we don't pull in the Better Auth /
// pgPool chain. The permission map mirrors the real module.
vi.mock("@/lib/admin/user-actions.server", () => ({
  BULK_USER_ACTION_PERMISSIONS: {
    approve: "admin.users.manage",
    block: "admin.users.manage",
    suspend: "admin.users.manage",
    reactivate: "admin.users.manage",
    ban: "admin.users.ban",
    unban: "admin.users.ban",
    soft_delete: "admin.users.delete",
    restore: "admin.users.delete",
  },
  executeBulkUserAction: (action: string, target: { appUserId: string }) =>
    bulkExecMock(action, target) ?? { ok: true, appUserId: target.appUserId },
}));
vi.mock("@/db/database", () => {
  function chain(): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "execute") return async () => state.targets;
          if (prop === "executeTakeFirst") return async () => undefined;
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (x: unknown) => unknown)(chain());
              } catch {
                /* best-effort */
              }
            }
            return chain();
          };
        },
      },
    );
  }
  return { db: { selectFrom: () => chain() } };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

const access = (perms: string[], org: string | null, superuser = false) => ({
  appUserId: "admin-1",
  primaryEmail: "a@x.com",
  status: "active",
  organizationId: org,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: superuser ? [...perms, "superuser"] : perms,
});
const ADMIN_PERMS = ["admin.users.manage", "admin.users.ban", "admin.users.delete"];

function jsonReq(body: unknown): NextRequest {
  const url = "http://test.local/api/administrator/users/bulk";
  return {
    nextUrl: new URL(url),
    url,
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

let POST: typeof Route.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, bulkExecMock]) m.mockReset();
  bulkExecMock.mockImplementation((_a, t: { appUserId: string }) => ({
    ok: true,
    appUserId: t.appUserId,
  }));
  state.targets = [
    { id: U1, better_auth_user_id: "ba-1", primary_email: "u1@org-a.com", status: "active" },
  ];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ POST } = await import("@/app/api/administrator/users/bulk/route"));
});
afterEach(() => vi.resetModules());

describe("POST /users/bulk — org-scoped batch", () => {
  it("a null-scope admin acts on NO ONE (attempted 0)", async () => {
    accessGetter.mockResolvedValue(access(ADMIN_PERMS, null)); // no org, no superuser
    const res = await POST(jsonReq({ action: "suspend", ids: [U1, U2] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempted: number; results: unknown[] };
    expect(body.attempted).toBe(0);
  });

  it("ORG ADMIN: a foreign-org id is dropped to not_found, only the in-org target acts", async () => {
    // The org-scoped lookup resolves only U1; U2 belongs to another org.
    state.targets = [
      { id: U1, better_auth_user_id: "ba-1", primary_email: "u1@org-a.com", status: "active" },
    ];
    accessGetter.mockResolvedValue(access(ADMIN_PERMS, ORG_A));
    const res = await POST(jsonReq({ action: "suspend", ids: [U1, U2] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempted: number;
      succeeded: number;
      failed: number;
      results: Array<{ ok: boolean; appUserId: string; error?: string }>;
    };
    expect(body.attempted).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    const u2 = body.results.find((r) => r.appUserId === U2);
    expect(u2?.error).toBe("not_found");
    // The action helper was invoked for U1 only — never for the foreign U2.
    expect(bulkExecMock).toHaveBeenCalledTimes(1);
  });

  it("SUPERADMIN resolves all targets", async () => {
    state.targets = [
      { id: U1, better_auth_user_id: "ba-1", primary_email: "u1@x.com", status: "active" },
      { id: U2, better_auth_user_id: "ba-2", primary_email: "u2@x.com", status: "active" },
    ];
    accessGetter.mockResolvedValue(access(ADMIN_PERMS, null, true));
    const res = await POST(jsonReq({ action: "suspend", ids: [U1, U2] }));
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(2);
  });

  it('"select all" still flows through the org-scoped lookup', async () => {
    accessGetter.mockResolvedValue(access(ADMIN_PERMS, ORG_A));
    const res = await POST(jsonReq({ action: "suspend", ids: "*", filters: { status: "active" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(1); // only the org-resolved U1
  });

  it("403 when the caller lacks the action's permission", async () => {
    accessGetter.mockResolvedValue(access(["admin.users.read"], ORG_A));
    expect((await POST(jsonReq({ action: "suspend", ids: [U1] }))).status).toBe(403);
  });
});
