import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ApiKeysRouteModule from "@/app/api/administrator/api-keys/route";

/**
 * Integration tests for `GET /api/administrator/api-keys`
 * (docs/admin-manager.md §8.8). The DB layer is stubbed — these tests
 * pin the *handler contract*: the `admin.apikeys.read` gate, the
 * standard list envelope, the pageSize clamp, and the audit write on a
 * denied attempt. Mirrors the users-list contract test.
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

// Minimal Kysely-builder stub. The handler chains a `base` query, then
// forks into items (`.execute()`) and a count (`.executeTakeFirst()`).
// We dispatch by terminal method; every intermediate builder method
// (leftJoin/where/select/orderBy/limit/offset) returns the same proxy.
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

function makeRequest(query: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/api-keys${query}`);
  return {
    nextUrl: url,
    headers: new Headers(),
  } as unknown as NextRequest;
}

const activeAdmin = {
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.apikeys.read"],
};

let GET: typeof ApiKeysRouteModule.GET;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  itemsExecute.mockReset();
  totalExecute.mockReset();
  ({ GET } = await import("@/app/api/administrator/api-keys/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/api-keys", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(401);
  });

  it("returns 403 and audits a denied attempt without admin.apikeys.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({ ...activeAdmin, permissions: ["shell.view"] });
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
    accessGetter.mockResolvedValue(activeAdmin);
    itemsExecute.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111101",
        app_user_id: "22222222-2222-4222-8222-222222222202",
        owner_email: "ada@example.com",
        owner_name: "Ada",
        organization_id: "o-1",
        name: "CI deploy bot",
        key_prefix: "drk_live_AbCd1234",
        scopes: ["account.read"],
        status: "active",
        expires_at: null,
        last_used_at: null,
        last_used_ip: null,
        created_at: "2025-01-01T00:00:00.000Z",
        revoked_at: null,
        revoked_reason: null,
        // Folded `count(*) over()` window total rides on the row; the
        // separate count query (below) is now only a fallback for empty
        // out-of-range pages, so mock it to a different value to prove the
        // full page reads the window total.
        __total: "7",
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
    expect(body.total).toBe(7);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });

  it("clamps oversize pageSize at 200", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(activeAdmin);
    itemsExecute.mockResolvedValue([]);
    totalExecute.mockResolvedValue({ total: "0" });
    const res = await GET(makeRequest("?pageSize=999999"));
    const body = (await res.json()) as { pageSize: number };
    expect(body.pageSize).toBe(200);
  });

  it("ignores unknown sort fields, falling back to the default sort", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(activeAdmin);
    itemsExecute.mockResolvedValue([]);
    totalExecute.mockResolvedValue({ total: "0" });
    const res = await GET(makeRequest("?sort=key_hash.asc"));
    const body = (await res.json()) as { sort: unknown[] };
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });
});
