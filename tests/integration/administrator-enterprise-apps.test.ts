import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as AppsRouteModule from "@/app/api/administrator/enterprise-apps/route";
import type * as AppByIdRouteModule from "@/app/api/administrator/enterprise-apps/[id]/route";

/**
 * Integration tests for the enterprise-apps endpoints (docs/admin-manager.md
 * Phase 6 test plan, §8.10). The DB layer is stubbed — these tests pin
 * the handler contract: permission gates, response envelopes, and the
 * canonical `id_taken` 409 / `application_in_use` 409 / `invalid_origin`
 * 400 machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const insertExecute = vi.fn();
const updateExecute = vi.fn();
const deleteExecute = vi.fn();

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
          execute: () => insertExecute(),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: () => updateExecute(),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: () => deleteExecute(),
        }),
      }),
    },
  };
});

function listReq(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/enterprise-apps${query}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL("http://test.local/api/administrator/enterprise-apps"),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

function idReq(id: string, body?: unknown): NextRequest {
  const headers = new Headers(body ? { "content-type": "application/json" } : {});
  return {
    nextUrl: new URL(`http://test.local/api/administrator/enterprise-apps/${id}`),
    headers,
    json: body ? async () => body : undefined,
  } as unknown as NextRequest;
}

let GET: typeof AppsRouteModule.GET;
let POST: typeof AppsRouteModule.POST;
let GET_BY_ID: typeof AppByIdRouteModule.GET;
let PATCH: typeof AppByIdRouteModule.PATCH;
let DELETE: typeof AppByIdRouteModule.DELETE;

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
    deleteExecute,
  ])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET, POST } = await import("@/app/api/administrator/enterprise-apps/route"));
  ({
    GET: GET_BY_ID,
    PATCH,
    DELETE,
  } = await import("@/app/api/administrator/enterprise-apps/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/enterprise-apps", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.apps.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["shell.view"]));
    const res = await GET(listReq());
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "docs",
        label: "Documentation",
        description: null,
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "devresponse-app:docs",
        status: "available",
        sort_order: 100,
        organization_id: null,
        organization_slug: null,
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([
      { field: "sort_order", direction: "asc" },
      { field: "label", direction: "asc" },
    ]);
  });
});

describe("POST /api/administrator/enterprise-apps", () => {
  it("returns 403 when caller lacks admin.apps.manage", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when id format is invalid", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    const res = await POST(
      jsonReq({
        id: "INVALID ID",
        label: "X",
        origin: "https://x.example.com",
        subdomain: "x",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("returns 400 when subdomain is invalid", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "BAD_SUB",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_origin when origin is not HTTPS", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "http://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_origin" });
  });

  it("returns 409 id_taken when the row already exists", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    insertExecute.mockRejectedValue(new Error("duplicate key value violates unique constraint"));
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "id_taken" });
  });

  it("returns 201 on successful creation and writes an audit row", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    insertExecute.mockResolvedValue(undefined);
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "docs" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.created",
        outcome: "success",
        targetApplicationId: "docs",
      }),
    );
  });
});

describe("GET /api/administrator/enterprise-apps/:id", () => {
  it("returns 400 invalid_id for malformed id", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    const res = await GET_BY_ID(idReq("BAD ID"), {
      params: Promise.resolve({ id: "BAD ID" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when app not found", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    selectFirst.mockResolvedValue(null);
    const res = await GET_BY_ID(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with the row on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs" });
    const res = await GET_BY_ID(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/administrator/enterprise-apps/:id", () => {
  it("returns 403 when caller lacks admin.apps.manage", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    const res = await PATCH(idReq("docs", { label: "x" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 invalid_origin when origin is not HTTPS", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    const res = await PATCH(idReq("docs", { origin: "http://nope.example.com" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_origin" });
  });

  it("returns 404 when target app does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null);
    const res = await PATCH(idReq("docs", { label: "y" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 on successful update and writes an audit row", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs" });
    updateExecute.mockResolvedValue(undefined);
    const res = await PATCH(idReq("docs", { label: "Updated" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.app.updated", outcome: "success" }),
    );
  });
});

describe("DELETE /api/administrator/enterprise-apps/:id", () => {
  it("returns 403 when caller lacks admin.apps.manage", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when target app does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null);
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 application_in_use when an FK constraint blocks delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs" });
    deleteExecute.mockRejectedValue(
      new Error("update or delete on table violates foreign key constraint"),
    );
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "application_in_use" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.delete_blocked",
        outcome: "denied",
      }),
    );
  });

  it("returns 200 on successful delete and writes an audit row", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs" });
    deleteExecute.mockResolvedValue(undefined);
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.app.deleted", outcome: "success" }),
    );
  });
});
