import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as MembersRouteModule from "@/app/api/administrator/organizations/[id]/members/route";

/**
 * Integration tests for the organization members endpoints (docs/admin-manager.md
 * Phase 5 test plan). The DB layer is stubbed — these tests pin the handler
 * contract: permission gates, response envelopes, and machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const insertExecute = vi.fn();

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
          if (prop === "executeTakeFirstOrThrow") {
            return async () => {
              const v = await selectFirst();
              if (!v) throw new Error("no_row");
              return v;
            };
          }
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
                /* ignore */
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
    db: {
      selectFrom: () => makeChain(),
      insertInto: () => ({
        values: () => ({
          returning: () => ({
            executeTakeFirstOrThrow: () => insertExecute(),
          }),
          onConflict: () => ({
            doNothing: () => ({
              returning: () => ({ executeTakeFirst: selectFirst }),
            }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: itemsExecute,
            where: () => ({ execute: itemsExecute }),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({
            execute: itemsExecute,
            where: () => ({ execute: itemsExecute }),
          }),
        }),
      }),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function listReq(query: string = ""): NextRequest {
  const url = new URL(
    `http://test.local/api/administrator/organizations/${ORG_ID}/members${query}`,
  );
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL(`http://test.local/api/administrator/organizations/${ORG_ID}/members`),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

let GET: typeof MembersRouteModule.GET;
let POST: typeof MembersRouteModule.POST;
let PATCH: typeof MembersRouteModule.PATCH;
let DELETE: typeof MembersRouteModule.DELETE;

const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: perms,
});

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    itemsExecute,
    selectFirst,
    insertExecute,
  ])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({
    id: ORG_ID,
    slug: "test-org",
    name: "Test Org",
    status: "active",
    is_default: false,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    total: "0",
  });
  ({ GET, POST, PATCH, DELETE } =
    await import("@/app/api/administrator/organizations/[id]/members/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations/:id/members", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.orgs.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["shell.view"]));
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "m-1",
        organization_id: ORG_ID,
        app_user_id: "u-2",
        status: "active",
        source_provider: null,
        provider_organization_key: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        user_display_name: "John Doe",
        user_primary_email: "john@example.com",
      },
    ]);
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
  });
});

describe("POST /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await POST(jsonReq({ appUserIds: ["u-2"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid body (empty array)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await POST(jsonReq({ appUserIds: [] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when org not found", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValue(null);
    const res = await POST(jsonReq({ appUserIds: ["u-2"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await PATCH(jsonReq({ membershipIds: ["m-1"], status: "suspended" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await DELETE(jsonReq({ membershipIds: ["m-1"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid body (empty array)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await DELETE(jsonReq({ membershipIds: [] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });
});
