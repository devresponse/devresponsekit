import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as AuditRouteModule from "@/app/api/administrator/audit/route";

/**
 * Integration tests for the audit endpoint (docs/admin-manager.md
 * §8.10). The DB layer is stubbed — these tests
 * pin the handler contract: permission gate, list envelope, and the
 * default sort applied when the caller doesn't specify one.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();

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

vi.mock("@/db/database", () => {
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return selectFirst;
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (eb: unknown) => unknown)(
                  new Proxy(() => ({}), {
                    get: () => () => ({}),
                    apply: () => ({}),
                  }),
                );
              } catch {
                /* ignore — eb stub is best-effort */
              }
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return {
    db: { selectFrom: () => makeChain() },
  };
});

function listReq(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/audit${query}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

let GET: typeof AuditRouteModule.GET;

// These predate the three-tier model and assert GLOBAL admin behavior,
// which is now SUPERADMIN — so the helper carries the `superuser` marker.
// Denial tests still fail on the missing specific permission (the marker
// alone never grants `admin.audit.read`).
const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [...perms, "superuser"],
});

// A non-superadmin ORG ADMIN: holds `perms` in an org but NOT the global
// `superuser` marker. "Lacks permission" (403) tests use this — a superuser
// now passes every admin check by design (getUserAccessContext + the gate
// short-circuit), so only a non-superuser can be denied a specific permission.
const ORG_ADMIN = (perms: string[]) => ({
  ...OK_ACCESS(perms),
  organizationId: "o-1",
  permissions: perms,
});

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock, itemsExecute, selectFirst])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET } = await import("@/app/api/administrator/audit/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/audit", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.audit.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.users.read"]));
    const res = await GET(listReq());
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("returns the standard list envelope with default created_at desc sort", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.audit.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "evt-1",
        event_type: "admin.user.banned",
        outcome: "success",
        actor_better_auth_user_id: "ba-actor",
        app_user_id: "u-target",
        organization_id: null,
        target_application_id: null,
        provider: null,
        email: "user@example.com",
        ip_address: "10.0.0.1",
        user_agent: "Mozilla",
        reason: "policy violation",
        metadata: {},
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });

  it("respects status/event filters and search query without erroring", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.audit.read"]));
    selectFirst.mockResolvedValue({ total: "0" });
    const res = await GET(
      listReq("?filter[event_type]=admin.user.banned&filter[outcome]=success&q=banned"),
    );
    expect(res.status).toBe(200);
  });

  it("accepts a created_at range filter without erroring", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.audit.read"]));
    selectFirst.mockResolvedValue({ total: "0" });
    const res = await GET(
      listReq(
        "?filter[created_at][from]=2025-01-01T00:00:00Z&filter[created_at][to]=2025-12-31T00:00:00Z",
      ),
    );
    expect(res.status).toBe(200);
  });
});
