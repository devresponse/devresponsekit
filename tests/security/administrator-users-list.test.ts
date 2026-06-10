import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as UsersRouteModule from "@/app/api/administrator/users/route";

/**
 * Security tests for `/api/administrator/users` (docs/admin-manager.md
 * §14 + §17 test plan / "security" layer). Focused on the
 * authorization and audit boundary — verifies no path through the
 * handler can leak data without the right permission.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const totalExecute = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
// The route module imports createBetterAuthUser (for POST), whose
// import graph reaches @/lib/auth. Mock the wrapper so the real Better
// Auth instance never initializes inside the test runner — its
// discarded async init work otherwise surfaces as unhandled rejections
// attributed to unrelated test files sharing the worker.
vi.mock("@/lib/admin/auth-admin.server", () => ({
  createBetterAuthUser: vi.fn(),
}));

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "execute") return itemsExecute;
            if (prop === "executeTakeFirst") return totalExecute;
            return (...args: unknown[]) => {
              const cb = args[0];
              if (typeof cb === "function") {
                (cb as (eb: unknown) => unknown)(
                  new Proxy(() => ({}), {
                    get: () => () => ({}),
                    apply: () => ({}),
                  }),
                );
              }
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  },
}));

function makeRequest(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/users${query}`);
  return {
    nextUrl: url,
    headers: new Headers(),
  } as unknown as NextRequest;
}

let GET: typeof UsersRouteModule.GET;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  itemsExecute.mockReset();
  totalExecute.mockReset();
  ({ GET } = await import("@/app/api/administrator/users/route"));
});
afterEach(() => vi.resetModules());

describe("security: /api/administrator/users", () => {
  it("rejects unauthenticated callers WITHOUT touching the database", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(totalExecute).not.toHaveBeenCalled();
  });

  it("rejects callers missing admin.users.read WITHOUT touching the database", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view", "audit.view"], // no admin.users.read
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(totalExecute).not.toHaveBeenCalled();
  });

  it("rejects suspended/blocked admins (status check beats permission check)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "suspended",
      organizationId: "o-1",
      membershipStatus: "suspended",
      preferredLocale: "en",
      // even WITH the permission, the suspension wins
      permissions: ["admin.users.read"],
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
  });

  it("audits every denied attempt with outcome=denied (so ops can detect probing)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-malicious" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
    });
    await GET(makeRequest());
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        actorBetterAuthUserId: "ba-malicious",
        reason: "missing_admin_permission",
      }),
    );
  });
});
