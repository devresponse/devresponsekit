import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as Route from "@/app/api/v1/users/[id]/status/route";

/**
 * POST /api/v1/users/[id]/status — REST status adapter (was 0%).
 * Security contract: permission gate (admin.users.manage), ADR-0001 org
 * scoping via canAccessUser (org admin cannot touch a user outside their
 * org → 404, no existence leak), and optimistic concurrency via If-Match
 * (stale → 412). canAccessUser runs for real; guard + status core + DB are
 * mocked.
 */
const requireApiPermission = vi.fn();
const enforceApiRateLimit = vi.fn();
const performAdminStatusChange = vi.fn();

const state: {
  current: { id: string; updated_at: Date } | undefined;
  membership: { id: string } | undefined;
} = { current: undefined, membership: undefined };

vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: (...a: unknown[]) => enforceApiRateLimit(...a),
}));
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: (...a: unknown[]) => performAdminStatusChange(...a),
}));
vi.mock("@/db/database", () => {
  function tableKey(t: unknown) {
    return String(t).split(" ")[0] ?? "";
  }
  function chain(table: string): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "executeTakeFirst")
            return async () =>
              table === "app_users"
                ? state.current
                : table === "app_organization_memberships"
                  ? state.membership
                  : undefined;
          if (prop === "execute") return async () => [];
          return () => chain(table);
        },
      },
    );
  }
  return { db: { selectFrom: (t: unknown) => chain(tableKey(t)) } };
});

const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UPDATED = new Date("2026-01-01T00:00:00.000Z");

function req(id: string, init?: { body?: unknown; ifMatch?: string }): NextRequest {
  const url = `http://test.local/api/v1/users/${id}/status`;
  const headers = new Headers({ "content-type": "application/json" });
  if (init?.ifMatch) headers.set("if-match", init.ifMatch);
  return {
    nextUrl: new URL(url),
    url,
    method: "POST",
    headers,
    json: async () => init?.body ?? { action: "suspend" },
  } as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function grant(opts: { permissions: string[]; organizationId: string | null }) {
  return {
    ok: true,
    grant: {
      caller: {
        betterAuthUserId: "ba1",
        access: {
          permissions: opts.permissions,
          organizationId: opts.organizationId,
          appUserId: "admin-1",
        },
      },
      requestId: "r1",
    },
  };
}
const orgAdmin = () => grant({ permissions: ["admin.users.manage"], organizationId: "o1" });
const superadmin = () =>
  grant({ permissions: ["admin.users.manage", "superuser"], organizationId: null });

let POST: typeof Route.POST;

beforeEach(async () => {
  for (const m of [requireApiPermission, enforceApiRateLimit, performAdminStatusChange])
    m.mockReset();
  enforceApiRateLimit.mockReturnValue(null);
  performAdminStatusChange.mockResolvedValue({ ok: true, status: "suspended" });
  state.current = { id: USER, updated_at: UPDATED };
  state.membership = { id: "m1" };
  ({ POST } = await import("@/app/api/v1/users/[id]/status/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/v1/users/[id]/status", () => {
  it("returns the guard response when denied", async () => {
    const { NextResponse } = await import("next/server");
    requireApiPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    expect((await POST(req(USER), ctx(USER))).status).toBe(401);
  });

  it("400 on a non-UUID id", async () => {
    requireApiPermission.mockResolvedValue(superadmin());
    expect((await POST(req("not-a-uuid"), ctx("not-a-uuid"))).status).toBe(400);
  });

  it("404 when the user does not exist", async () => {
    state.current = undefined;
    requireApiPermission.mockResolvedValue(superadmin());
    expect((await POST(req(USER), ctx(USER))).status).toBe(404);
  });

  it("404 when an ORG ADMIN targets a user outside their org", async () => {
    state.membership = undefined; // canAccessUser → false
    requireApiPermission.mockResolvedValue(orgAdmin());
    expect((await POST(req(USER), ctx(USER))).status).toBe(404);
    expect(performAdminStatusChange).not.toHaveBeenCalled();
  });

  it("412 on a stale If-Match", async () => {
    requireApiPermission.mockResolvedValue(superadmin());
    expect((await POST(req(USER, { ifMatch: 'W/"stale"' }), ctx(USER))).status).toBe(412);
  });

  it("200 for an ORG ADMIN acting on an in-org user", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(req(USER), ctx(USER));
    expect(res.status).toBe(200);
    expect(performAdminStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetAppUserId: USER, newStatus: "suspended" }),
    );
  });

  it("404 when the status core reports the user vanished", async () => {
    performAdminStatusChange.mockResolvedValue({ ok: false, error: "user_not_found" });
    requireApiPermission.mockResolvedValue(superadmin());
    expect((await POST(req(USER), ctx(USER))).status).toBe(404);
  });
});
