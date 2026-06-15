import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as UsersRouteModule from "@/app/api/administrator/users/route";

/**
 * Integration tests for `GET /api/administrator/users` per
 * docs/admin-manager.md §5.1, §5.3 and §17 (test plan).
 *
 * The DB layer is stubbed — these tests pin the *handler contract*:
 * permission gate, response envelope, pageSize clamp, and the audit
 * write on a denied attempt.
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

// Minimal Kysely-builder stub. The handler chains:
//   db.selectFrom("app_users")[.where(...)]*[.select(...)]
//     .execute() | .executeTakeFirst()
// Two terminal-ish branches must be reachable: items.execute() and
// total.executeTakeFirst(). The handler builds a `base` then forks;
// both forks share the same chainable shape. We dispatch by terminal
// method name — `execute()` is items, `executeTakeFirst()` is total.

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      // The handler builds `base`, then forks into:
      //   items: ...select([...]).execute()              -> itemsExecute
      //   total: ...select(sql`count(*)`).executeTakeFirst() -> totalExecute
      // We dispatch by *terminal* method so the test does not have to
      // model the inner builder semantics — `where`, `select`, `orderBy`,
      // `limit`, `offset` all return the same chainable proxy.
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "execute") return itemsExecute;
            if (prop === "executeTakeFirst") return totalExecute;
            return (...args: unknown[]) => {
              const cb = args[0];
              if (typeof cb === "function") {
                // Invoke the eb callback so the handler doesn't crash
                // on the `eb.or([...])` builder shape.
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

function makeRequest(query: string): NextRequest {
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

describe("GET /api/administrator/users", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(401);
  });

  it("returns 403 and audits a denied attempt for callers without admin.users.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view"],
    });
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        reason: "missing_admin_permission",
      }),
    );
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read", "superuser"],
    });
    // The total now rides on each row via the folded `count(*) over()`
    // window column (`__total`). The separate count query is only a
    // fallback for empty out-of-range pages — mock it to a DIFFERENT value
    // to prove a full page reads the window total, never the fallback.
    itemsExecute.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111101",
        better_auth_user_id: "ba-99",
        primary_email: "ada@example.com",
        display_name: "Ada",
        status: "active",
        preferred_locale: "en",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
        __total: "42",
      },
    ]);
    totalExecute.mockResolvedValue({ total: "999" });

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      page: number;
      pageSize: number;
      total: number;
      sort: { field: string; direction: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(42);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    // Default sort applied when none requested.
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });

  it("clamps oversize pageSize at 200 (no DOS via huge pages)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read", "superuser"],
    });
    itemsExecute.mockResolvedValue([]);
    totalExecute.mockResolvedValue({ total: "0" });
    const res = await GET(makeRequest("?pageSize=999999"));
    const body = (await res.json()) as { pageSize: number };
    expect(body.pageSize).toBe(200);
  });

  it("ignores unknown sort fields", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read", "superuser"],
    });
    itemsExecute.mockResolvedValue([]);
    totalExecute.mockResolvedValue({ total: "0" });
    const res = await GET(makeRequest("?sort=evil_secret_field:asc"));
    const body = (await res.json()) as { sort: unknown[] };
    // Falls back to default sort.
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });
});
