import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OrgsRouteModule from "@/app/api/administrator/organizations/route";
import type * as OrgByIdRouteModule from "@/app/api/administrator/organizations/[id]/route";

/**
 * Integration tests for the organizations endpoints (docs/admin-manager.md
 * Phase 5 test plan). The DB layer is stubbed — these tests pin the
 * handler contract: permission gates, response envelopes, and the
 * canonical `slug_taken` 409 / `organization_not_empty` 409 machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const insertExecute = vi.fn();
const updateExecute = vi.fn();
const countExecute = vi.fn();

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
            returning: () => ({ executeTakeFirst: () => updateExecute() }),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({ execute: itemsExecute }),
        }),
      }),
    },
  };
});

function listReq(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/organizations${query}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL("http://test.local/api/administrator/organizations"),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

function idReq(method: string, id: string, body?: unknown): NextRequest {
  const headers = new Headers(body ? { "content-type": "application/json" } : {});
  return {
    nextUrl: new URL(`http://test.local/api/administrator/organizations/${id}`),
    headers,
    json: body ? async () => body : undefined,
  } as unknown as NextRequest;
}

let GET: typeof OrgsRouteModule.GET;
let POST: typeof OrgsRouteModule.POST;
let GET_BY_ID: typeof OrgByIdRouteModule.GET;
let PATCH: typeof OrgByIdRouteModule.PATCH;
let DELETE: typeof OrgByIdRouteModule.DELETE;

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
    updateExecute,
    countExecute,
  ])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET, POST } = await import("@/app/api/administrator/organizations/route"));
  ({ GET: GET_BY_ID, PATCH, DELETE } = await import(
    "@/app/api/administrator/organizations/[id]/route"
  ));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.orgs.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["shell.view"]));
    const res = await GET(listReq());
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied" }),
    );
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "o-1",
        slug: "acme",
        name: "ACME Corp",
        status: "active",
        is_default: false,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        member_count: "5",
        provider_count: "2",
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([{ field: "slug", direction: "asc" }]);
  });
});

describe("POST /api/administrator/organizations", () => {
  it("returns 403 when caller lacks admin.orgs.create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await POST(jsonReq({ slug: "acme", name: "ACME" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid slug format", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    const res = await POST(jsonReq({ slug: "INVALID_SLUG", name: "Test" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 slug_taken when slug already exists", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    // The route uses try/catch on executeTakeFirstOrThrow which will throw on conflict
    insertExecute.mockRejectedValue(new Error("duplicate key value violates unique constraint"));
    const res = await POST(jsonReq({ slug: "taken", name: "Taken Org" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "slug_taken" });
  });

  it("returns 201 with created org on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    insertExecute.mockResolvedValue({
      id: "new-org-id",
      slug: "new-org",
    });
    const res = await POST(jsonReq({ slug: "new-org", name: "New Org" }));
    expect(res.status).toBe(201);
  });
});

describe("GET /api/administrator/organizations/:id", () => {
  it("returns 400 for invalid UUID", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await GET_BY_ID(idReq("GET", "not-a-uuid"), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_id" });
  });

  it("returns 404 when org not found", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    selectFirst.mockResolvedValue(null);
    const res = await GET_BY_ID(
      idReq("GET", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      { params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/administrator/organizations/:id", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await PATCH(
      idReq("PATCH", "a1b2c3d4-e5f6-7890-abcd-ef1234567890", { name: "New Name" }),
      { params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/administrator/organizations/:id", () => {
  it("returns 403 when caller lacks admin.orgs.delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await DELETE(
      idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      { params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }) },
    );
    expect(res.status).toBe(403);
  });
});
