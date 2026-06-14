import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RouteModule from "@/app/api/administrator/api-keys/[id]/route";

/**
 * ADR-0001 enforcement test: `GET /api/administrator/api-keys/[id]` must
 * confine an ORG ADMIN to their own org (404 on another org's key) while
 * a SUPERADMIN reaches every org. Proves the cross-tenant IDOR the
 * security review flagged is closed at the route layer.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const rowExecuteTakeFirst = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...args: unknown[]) => auditMock(...args) }));

// The GET handler runs a single chained read ending in `.executeTakeFirst()`.
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "executeTakeFirst") return rowExecuteTakeFirst;
            return () => proxy;
          },
        },
      );
      return proxy;
    },
  },
}));

const KEY_ID = "11111111-1111-4111-8111-111111111101";

function makeRequest(): NextRequest {
  return {
    nextUrl: new URL(`http://test.local/api/administrator/api-keys/${KEY_ID}`),
    headers: new Headers(),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: KEY_ID }) };

function access(overrides: Partial<AuthStatusModule.UserAccessContext>) {
  return {
    appUserId: "admin-1",
    primaryEmail: "admin@x.com",
    status: "active",
    organizationId: "org-a",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["admin.apikeys.read"],
    ...overrides,
  };
}

let GET: typeof RouteModule.GET;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  rowExecuteTakeFirst.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  // The key being requested belongs to org-b.
  rowExecuteTakeFirst.mockResolvedValue({
    id: KEY_ID,
    app_user_id: "u-9",
    owner_email: "owner@x.com",
    organization_id: "org-b",
    name: "k",
    key_prefix: "drk_live_AbCd1234",
    scopes: [],
    status: "active",
  });
  ({ GET } = await import("@/app/api/administrator/api-keys/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/api-keys/[id] — ADR-0001 org scoping", () => {
  it("ORG ADMIN of org-a gets 404 for a key in org-b (no cross-tenant read)", async () => {
    accessGetter.mockResolvedValue(access({ organizationId: "org-a" }));
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(404);
  });

  it("ORG ADMIN gets 200 for a key in their own org", async () => {
    rowExecuteTakeFirst.mockResolvedValue({
      id: KEY_ID,
      app_user_id: "u-9",
      owner_email: "owner@x.com",
      organization_id: "org-a",
      name: "k",
      key_prefix: "drk_live_AbCd1234",
      scopes: [],
      status: "active",
    });
    accessGetter.mockResolvedValue(access({ organizationId: "org-a" }));
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
  });

  it("SUPERADMIN reaches a key in any org (org-b)", async () => {
    accessGetter.mockResolvedValue(
      access({ organizationId: "org-a", permissions: ["admin.apikeys.read", "superuser"] }),
    );
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
  });
});
