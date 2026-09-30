import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as LoggerModule from "@/lib/observability/logger.server";
import type * as AppsRouteModule from "@/app/api/administrator/enterprise-apps/route";
import type * as AppByIdRouteModule from "@/app/api/administrator/enterprise-apps/[id]/route";
import { pgForeignKeyViolation, pgUniqueViolation } from "../helpers/pg-errors";

/**
 * Integration tests for the enterprise-apps endpoints (docs/admin-manager.md
 * §8.7). The DB layer is stubbed — these tests pin
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
/** F-84: the DELETE's statements on its transaction handle, by table. */
const trxDeletes = vi.fn();
/** F-82: the sweep of an app's handoff sessions (DB-backed in tests/db). */
const endHandoffs = vi.fn();
const logErrMock = vi.fn();
/** F-74: each comparison a `where((eb) => …)` callback built, as `eb(...)` args. */
const ebCalls: unknown[][] = [];

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
vi.mock("@/lib/sso.server", () => ({
  endSsoHandoffsOfApplication: (...args: unknown[]) => endHandoffs(...args),
}));
vi.mock("@/lib/observability/logger.server", async () => {
  const actual = await vi.importActual<typeof LoggerModule>("@/lib/observability/logger.server");
  return { ...actual, logServerError: (...args: unknown[]) => logErrMock(...args) };
});

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
                    apply: (_target, _this, args: unknown[]) => {
                      ebCalls.push(args);
                      return {};
                    },
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
  // F-84: the app DELETE runs in a transaction: it locks the app row (answered
  // by `selectFirst`, like every other read here), deletes the app's handoff
  // nonces, then the app. Every DELETE on the handle is recorded in
  // `trxDeletes` by table; the app's own also answers `deleteExecute`, so a
  // rejection staged there models that statement's FK violation.
  const trx = {
    selectFrom: () => makeChain(),
    deleteFrom: (table: string) => ({
      where: () => ({
        execute: async () => {
          trxDeletes(table);
          return table === "app_enterprise_applications" ? deleteExecute() : [];
        },
      }),
    }),
  };
  return {
    db: {
      transaction: () => ({
        execute: (cb: (handle: unknown) => Promise<unknown>) => cb(trx),
      }),
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

// Contract suite: the actor holds the `superuser` marker so ADR-0001 org
// scoping (covered separately) is bypassed and success paths are reachable.
// "Lacks permission" 403 tests stay valid — `superuser` is never the gated
// permission, and a global app (organization_id null) is SUPERADMIN-only.
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
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    itemsExecute,
    selectFirst,
    insertExecute,
    updateExecute,
    deleteExecute,
    trxDeletes,
    endHandoffs,
    logErrMock,
  ])
    m.mockReset();
  ebCalls.length = 0;
  itemsExecute.mockResolvedValue([]);
  endHandoffs.mockResolvedValue(0);
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
    accessGetter.mockResolvedValue(ORG_ADMIN(["shell.view"]));
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

  it("reads every value of a repeated organization filter, `null` as the global apps (F-74)", async () => {
    // A repeated filter used to be dropped, which listed every app.
    // tests/db/admin-list-repeated-filters.db.test.ts runs it against Postgres.
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.read"]));
    const org = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
    const res = await GET(listReq(`?filter[organization_id]=${org}&filter[organization_id]=null`));
    expect(res.status).toBe(200);
    expect(ebCalls).toContainEqual(["a.organization_id", "is", null]);
    expect(ebCalls).toContainEqual(["a.organization_id", "in", [org]]);
  });
});

describe("POST /api/administrator/enterprise-apps", () => {
  it("returns 403 when caller lacks admin.apps.manage", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.apps.read"]));
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

  it("returns 409 id_taken when the row already exists, whatever the server's message language (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null); // audience not taken
    insertExecute.mockRejectedValue(pgUniqueViolation("app_enterprise_applications_pkey"));
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

  it("maps a 23505 on the sso_audience UNIQUE index to 409 audience_taken, not id_taken (review #15)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    // The pre-check saw no owner (a concurrent create won the race); the
    // index in migration 0005 is the second line of defence.
    selectFirst.mockResolvedValue(null);
    insertExecute.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint "idx_…"'), {
        code: "23505",
        constraint: "idx_app_enterprise_applications_sso_audience",
      }),
    );
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "devresponse-app:victim",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "audience_taken" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("still maps a 23505 on the primary key to id_taken", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null);
    insertExecute.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "app_enterprise_applications_pkey",
      }),
    );
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

  it("does not report a 23505 on any other unique index as id_taken (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null);
    // An index a later migration might add: its conflict is not an id conflict.
    // In English, which the old message match claimed as id_taken.
    insertExecute.mockRejectedValue(
      pgUniqueViolation("app_enterprise_applications_label_key", "en"),
    );
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
  });

  it("maps a 23503 on the organization FK to 409 organization_not_found (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null);
    insertExecute.mockRejectedValue(
      pgForeignKeyViolation("app_enterprise_applications_organization_id_fkey"),
    );
    const res = await POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "audience",
        organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "organization_not_found" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 201 on successful creation and writes an audit row", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null); // audience not taken
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

  it("returns 409 audience_taken when another app already owns the sso_audience (review #15)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    // The audience lookup finds the victim satellite's row.
    selectFirst.mockResolvedValue({ id: "victim" });
    insertExecute.mockResolvedValue(undefined);
    const res = await POST(
      jsonReq({
        id: "evil",
        label: "Evil",
        origin: "https://evil.example.com",
        subdomain: "evil",
        sso_audience: "devresponse-app:victim",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "audience_taken",
      message: "errors.audience_taken",
    });
    expect(insertExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
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
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.apps.read"]));
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

  /**
   * F-82: disabling an app used to end nothing on the satellites; its handoff
   * sessions kept rolling. Every save that sets `disabled` now sweeps them
   * (idempotent, so a retry after a failed sweep sweeps again).
   */
  it("F-82: disabling ends the app's handoff sessions and audits how many", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", organization_id: null });
    updateExecute.mockResolvedValue(undefined);
    endHandoffs.mockResolvedValue(3);
    const res = await PATCH(idReq("docs", { status: "disabled" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(endHandoffs).toHaveBeenCalledWith("docs");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.updated",
        metadata: { id: "docs", changes: { status: "disabled" }, endedSsoSessions: 3 },
      }),
    );
  });

  it("F-82: a save that does not disable the app ends nothing", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", organization_id: null });
    updateExecute.mockResolvedValue(undefined);
    for (const body of [{ label: "Renamed" }, { status: "available" }]) {
      const res = await PATCH(idReq("docs", body), { params: Promise.resolve({ id: "docs" }) });
      expect(res.status).toBe(200);
    }
    expect(endHandoffs).not.toHaveBeenCalled();
    for (const [row] of auditMock.mock.calls as Array<[{ metadata: object }]>) {
      expect(row.metadata).not.toHaveProperty("endedSsoSessions");
    }
  });

  /**
   * F-82: the status is written before the sweep, so a failed sweep must not
   * leave that committed change unaudited. It is audited with a null count,
   * and the 500 tells the operator to save again, which sweeps again.
   */
  it("F-82: a failed sweep still audits the written status, then answers 500 so the operator retries", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", organization_id: null });
    updateExecute.mockResolvedValue(undefined);
    endHandoffs.mockRejectedValue(new Error("db down"));
    const res = await PATCH(idReq("docs", { status: "disabled" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
    expect(updateExecute).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.updated",
        outcome: "success",
        metadata: { id: "docs", changes: { status: "disabled" }, endedSsoSessions: null },
      }),
    );
  });

  it("maps a 23505 from the sso_audience UNIQUE index on UPDATE to 409 audience_taken (review #15)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst
      .mockResolvedValueOnce({ id: "docs", organization_id: null }) // existing row
      .mockResolvedValueOnce(null); // pre-check: nobody owns it (yet)
    updateExecute.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "idx_app_enterprise_applications_sso_audience",
      }),
    );
    const res = await PATCH(idReq("docs", { sso_audience: "devresponse-app:victim" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "audience_taken" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("maps a 23503 on the organization FK on UPDATE to 409 organization_not_found (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValueOnce({ id: "docs", organization_id: null }); // existing row
    updateExecute.mockRejectedValue(
      pgForeignKeyViolation("app_enterprise_applications_organization_id_fkey"),
    );
    const res = await PATCH(
      idReq("docs", { organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      { params: Promise.resolve({ id: "docs" }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "organization_not_found" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 409 audience_taken when moving sso_audience onto another app's value (review #15)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst
      .mockResolvedValueOnce({ id: "docs", organization_id: null }) // existing row
      .mockResolvedValueOnce({ id: "victim" }); // audience owner (id != docs)
    updateExecute.mockResolvedValue(undefined);
    const res = await PATCH(idReq("docs", { sso_audience: "devresponse-app:victim" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "audience_taken" });
    expect(updateExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("allows an sso_audience change when no OTHER app owns the value", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst
      .mockResolvedValueOnce({ id: "docs", organization_id: null }) // existing row
      .mockResolvedValueOnce(null); // no conflicting owner (own row excluded)
    updateExecute.mockResolvedValue(undefined);
    const res = await PATCH(idReq("docs", { sso_audience: "devresponse-app:docs" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(updateExecute).toHaveBeenCalled();
  });
});

/**
 * F-83: the catalog must never make this deployment an SSO target of itself.
 * Its consume route accepts a handoff for its own SSO_HANDOFF_APPLICATION_ID
 * under `<prefix>:<id>`, so a row carrying both let any member mint a fresh
 * session past the absolute-lifetime cap, or send a victim a one-click consume
 * link that swapped their session for the sender's account. The suite's env
 * (tests/setup/vitest.setup.ts) makes this deployment `portal` under
 * `devresponse-app`.
 */
describe("enterprise apps — this deployment is never its own SSO target (F-83)", () => {
  const OWN_ORIGIN = "https://primary.example.com";

  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null); // no OTHER row owns anything
    insertExecute.mockResolvedValue(undefined);
    updateExecute.mockResolvedValue(undefined);
    vi.stubEnv("BETTER_AUTH_URL", OWN_ORIGIN);
  });
  afterEach(() => vi.unstubAllEnvs());

  const create = (overrides: Record<string, unknown>) =>
    POST(
      jsonReq({
        id: "docs",
        label: "Docs",
        origin: "https://docs.example.com",
        subdomain: "docs",
        sso_audience: "devresponse-app:docs",
        ...overrides,
      }),
    );

  it("refuses to create a row under this deployment's own application id", async () => {
    const res = await create({ id: "portal", sso_audience: "devresponse-app:portal-x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "id_taken" });
    expect(insertExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses this deployment's own audience on create, though no row owns it", async () => {
    const res = await create({ sso_audience: "devresponse-app:portal" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "audience_taken" });
    expect(insertExecute).not.toHaveBeenCalled();
  });

  it("refuses this deployment's own origin on create", async () => {
    const res = await create({ origin: OWN_ORIGIN });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "origin_not_allowed" });
    expect(insertExecute).not.toHaveBeenCalled();
  });

  it("still creates an ordinary row (control)", async () => {
    expect((await create({})).status).toBe(201);
  });

  it("refuses to move an existing row's audience onto this deployment's own", async () => {
    selectFirst.mockResolvedValueOnce({ id: "docs", organization_id: null }); // existing row
    const res = await PATCH(idReq("docs", { sso_audience: "devresponse-app:portal" }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "audience_taken" });
    expect(updateExecute).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses to move an existing row's origin onto this deployment's own", async () => {
    const res = await PATCH(idReq("docs", { origin: OWN_ORIGIN }), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "origin_not_allowed" });
    expect(updateExecute).not.toHaveBeenCalled();
  });
});

/**
 * I-01: app ids and SSO audiences are global names (a primary key and a UNIQUE
 * index). An org admin used to register its org's app as `crm` or
 * `devresponse-app:crm`, and the superadmin who then registered the real
 * satellite got 409 and had to rename it. A caller without cross-org reach now
 * claims only names under its org's slug (`acme.crm`); any other name is
 * refused as a superadmin-only action (403 and a denied row, pinned for each
 * route in superadmin-only-refusals-audited.test.ts).
 */
describe("enterprise apps — an org admin names its apps under its org's slug (I-01)", () => {
  const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ACME_ADMIN = { ...ORG_ADMIN(["admin.apps.manage"]), organizationId: ORG };

  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACME_ADMIN);
    insertExecute.mockResolvedValue(undefined);
    updateExecute.mockResolvedValue(undefined);
  });

  const create = (overrides: Record<string, unknown>) =>
    POST(
      jsonReq({
        id: "acme.crm",
        label: "CRM",
        origin: "https://crm.example.com",
        subdomain: "crm",
        sso_audience: "devresponse-app:acme.crm",
        organization_id: ORG,
        ...overrides,
      }),
    );

  const expectRefused = async (res: Response) => {
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        organizationId: ORG,
        reason: "cross_org_reach_required",
        metadata: expect.objectContaining({ action: "enterprise_app_global_name" }),
      }),
    );
  };

  it("creates an app in its own org under the org's slug", async () => {
    selectFirst
      .mockResolvedValueOnce({ slug: "acme" }) // the org's slug
      .mockResolvedValueOnce(null); // audience not taken
    const res = await create({});
    expect(res.status).toBe(201);
    expect(insertExecute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a global id", { id: "crm" }],
    ["a global audience", { sso_audience: "devresponse-app:crm" }],
    ["a hyphenated id, not the namespace", { id: "acme-crm" }],
    [
      "names in org acme-corp's namespace",
      { id: "acme-corp.crm", sso_audience: "devresponse-app:acme-corp.crm" },
    ],
  ])("refuses %s on create and writes nothing", async (_label, overrides) => {
    selectFirst.mockResolvedValueOnce({ slug: "acme" });
    await expectRefused(await create(overrides));
    expect(insertExecute).not.toHaveBeenCalled();
  });

  it("an org-bound superuser credential is held to the namespace too (MACHINE-2)", async () => {
    accessGetter.mockResolvedValue({
      ...ACME_ADMIN,
      permissions: ["admin.apps.manage", "superuser"],
      orgBound: true,
    });
    selectFirst.mockResolvedValueOnce({ slug: "acme" });
    await expectRefused(await create({ id: "crm", sso_audience: "devresponse-app:crm" }));
    expect(insertExecute).not.toHaveBeenCalled();
  });

  it("a superadmin still registers a global name in any org", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue(null); // audience not taken
    const res = await create({ id: "crm", sso_audience: "devresponse-app:crm" });
    expect(res.status).toBe(201);
  });

  it("moves its app's audience within the namespace", async () => {
    selectFirst
      .mockResolvedValueOnce({
        id: "acme.crm",
        organization_id: ORG,
        sso_audience: "devresponse-app:acme.crm",
      }) // existing row
      .mockResolvedValueOnce({ slug: "acme" }) // the org's slug
      .mockResolvedValueOnce(null); // audience not taken
    const res = await PATCH(idReq("acme.crm", { sso_audience: "sso:acme.crm" }), {
      params: Promise.resolve({ id: "acme.crm" }),
    });
    expect(res.status).toBe(200);
    expect(updateExecute).toHaveBeenCalledTimes(1);
  });

  it("refuses to move its app's audience onto a global name", async () => {
    selectFirst
      .mockResolvedValueOnce({
        id: "acme.crm",
        organization_id: ORG,
        sso_audience: "devresponse-app:acme.crm",
      })
      .mockResolvedValueOnce({ slug: "acme" });
    const res = await PATCH(idReq("acme.crm", { sso_audience: "devresponse-app:crm" }), {
      params: Promise.resolve({ id: "acme.crm" }),
    });
    await expectRefused(res);
    expect(updateExecute).not.toHaveBeenCalled();
  });

  it("saves an app named before the rule, whose form re-sends its stored audience", async () => {
    selectFirst
      .mockResolvedValueOnce({
        id: "crm",
        organization_id: ORG,
        sso_audience: "devresponse-app:crm",
      }) // existing row, a global-looking name
      .mockResolvedValueOnce(null); // audience owned by no OTHER app
    const res = await PATCH(
      idReq("crm", { label: "CRM (renamed)", sso_audience: "devresponse-app:crm" }),
      { params: Promise.resolve({ id: "crm" }) },
    );
    expect(res.status).toBe(200);
    expect(updateExecute).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.app.updated", outcome: "success" }),
    );
  });
});

describe("DELETE /api/administrator/enterprise-apps/:id", () => {
  it("returns 403 when caller lacks admin.apps.manage", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.apps.read"]));
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

  it("returns 409 application_in_use when an FK constraint blocks delete, whatever the server's message language (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs" });
    // Nothing but its nonces references an app today, and those go first
    // (F-84); this is a table a later migration might point at it.
    deleteExecute.mockRejectedValue(pgForeignKeyViolation("app_example_application_id_fkey"));
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

  it("F-84: deletes the app's handoff nonces first, on the same transaction", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs" });
    deleteExecute.mockResolvedValue(undefined);
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    // Before F-84 the app was deleted on its own, and any nonce a launch had
    // left answered 409 (tests/db/enterprise-app-delete-route.db.test.ts).
    expect(trxDeletes.mock.calls.map(([table]) => table)).toEqual([
      "app_sso_handoff_nonces",
      "app_enterprise_applications",
    ]);
  });

  it("F-82: ends the app's handoff sessions after the delete commits, and audits how many", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs", organization_id: null });
    deleteExecute.mockResolvedValue(undefined);
    endHandoffs.mockImplementation(async () => {
      // The app and its nonces are gone first: no handoff can open a new one.
      expect(trxDeletes).toHaveBeenCalledWith("app_enterprise_applications");
      return 2;
    });
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(endHandoffs).toHaveBeenCalledWith("docs");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.deleted",
        metadata: { id: "docs", label: "Docs", endedSsoSessions: 2 },
      }),
    );
  });

  /**
   * F-82: a DELETE cannot be retried once it commits (the next one answers
   * 404), so a failed sweep used to leave the deletion unaudited for good and
   * its sessions unswept. The delete now stands, audited with a null count,
   * and the failure is logged; the missed sessions end at their lifetime bound.
   */
  it("F-82: a failed sweep after the delete commits is logged and audited, and the delete answers 200", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    selectFirst.mockResolvedValue({ id: "docs", label: "Docs", organization_id: null });
    deleteExecute.mockResolvedValue(undefined);
    const failure = new Error("session delete timed out");
    endHandoffs.mockRejectedValue(failure);
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(200);
    expect(trxDeletes).toHaveBeenCalledWith("app_enterprise_applications");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.app.deleted",
        outcome: "success",
        metadata: { id: "docs", label: "Docs", endedSsoSessions: null },
      }),
    );
    expect(logErrMock).toHaveBeenCalledWith(
      "admin.app.sso_session_sweep_failed",
      expect.objectContaining({ err: failure, applicationId: "docs" }),
    );
  });

  it("F-84: answers 404 and audits nothing when the app is gone by the time the transaction locks it", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.apps.manage"]));
    // The lookup still sees the app; the lock inside the transaction does not.
    selectFirst
      .mockResolvedValueOnce({ id: "docs", label: "Docs", organization_id: null })
      .mockResolvedValueOnce(undefined);
    const res = await DELETE(idReq("docs"), {
      params: Promise.resolve({ id: "docs" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "application_not_found" });
    expect(trxDeletes).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(endHandoffs).not.toHaveBeenCalled();
  });
});
