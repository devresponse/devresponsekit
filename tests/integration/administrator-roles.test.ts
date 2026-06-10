import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RolesRouteModule from "@/app/api/administrator/roles/route";
import type * as RoleByIdRouteModule from "@/app/api/administrator/roles/[id]/route";

/**
 * Integration tests for the roles endpoints (docs/admin-manager.md
 * §5.1, §19, Phase 4 test plan). The DB layer is stubbed — these
 * tests pin the *handler contract*: permission gates, response
 * envelopes, and the canonical `role_in_use` 409 / `key_taken` 409
 * machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const totalExecute = vi.fn();
const insertExecute = vi.fn();
const transactionExecute = vi.fn();
const selectFirst = vi.fn();
const userRolesCount = vi.fn();

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

// Universal Kysely-builder stub. Different tests configure the
// terminal mock that matters for the path they exercise.
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
          onConflict: () => ({ execute: insertExecute }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({ execute: itemsExecute, returning: () => ({ execute: itemsExecute }) }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({ execute: itemsExecute, where: () => ({ execute: itemsExecute }) }),
        }),
      }),
      transaction: () => ({
        execute: (cb: (trx: unknown) => Promise<unknown>) => transactionExecute(cb),
      }),
    },
  };
});

function listReq(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/roles${query}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL("http://test.local/api/administrator/roles"),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

let GET: typeof RolesRouteModule.GET;
let POST: typeof RolesRouteModule.POST;
let DELETE_BY_ID: typeof RoleByIdRouteModule.DELETE;

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    itemsExecute,
    totalExecute,
    insertExecute,
    transactionExecute,
    selectFirst,
    userRolesCount,
  ])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET, POST } = await import("@/app/api/administrator/roles/route"));
  ({ DELETE: DELETE_BY_ID } = await import("@/app/api/administrator/roles/[id]/route"));
});
afterEach(() => vi.resetModules());

const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: perms,
});

describe("GET /api/administrator/roles", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.roles.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["shell.view"]));
    const res = await GET(listReq());
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "r-1",
        organization_id: null,
        key: "admin.platform",
        name: "Platform admin",
        description: null,
        created_at: "2025-01-01T00:00:00Z",
        permission_count: "5",
        member_count: "1",
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([{ field: "key", direction: "asc" }]);
  });
});

describe("POST /api/administrator/roles", () => {
  it("returns 403 when caller lacks admin.roles.create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.read"]));
    const res = await POST(jsonReq({ key: "x.y", name: "X" }));
    expect(res.status).toBe(403);
  });

  it("rejects invalid keys with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.create"]));
    const res = await POST(jsonReq({ key: "bad key with space", name: "X" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 with key_taken when global key already exists", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.create"]));
    // The pre-insert duplicate-check returns a row.
    selectFirst.mockResolvedValue({ id: "r-existing" });
    const res = await POST(jsonReq({ key: "admin.platform", name: "X" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("key_taken");
  });

  it("returns 201 + audits success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.create"]));
    selectFirst.mockResolvedValue(undefined); // no duplicate
    insertExecute.mockResolvedValue({ id: "r-new", key: "x.y" });
    const res = await POST(jsonReq({ key: "x.y", name: "X" }));
    expect(res.status).toBe(201);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.role.created", outcome: "success" }),
    );
  });
});

describe("DELETE /api/administrator/roles/[id]", () => {
  function delReq(): NextRequest {
    return {
      nextUrl: new URL("http://test.local/api/administrator/roles/r-1"),
      headers: new Headers(),
    } as unknown as NextRequest;
  }
  const ctx = {
    params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
  };

  it("returns 403 when caller lacks admin.roles.delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.read"]));
    const res = await DELETE_BY_ID(delReq(), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when id is not a UUID", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.delete"]));
    const res = await DELETE_BY_ID(delReq(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the role does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.delete"]));
    selectFirst.mockResolvedValue(undefined);
    const res = await DELETE_BY_ID(delReq(), ctx);
    expect(res.status).toBe(404);
  });

  it("returns 409 role_in_use when the role still has assignments", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.delete"]));
    // First select: existing role row. Second select (count): 3.
    selectFirst
      .mockResolvedValueOnce({ id: "r-1", organization_id: null, key: "x.y" })
      .mockResolvedValueOnce({ count: "3" });
    const res = await DELETE_BY_ID(delReq(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("role_in_use");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "role_in_use" }),
    );
  });

  it("deletes the role and its permissions in one transaction on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.roles.delete"]));
    selectFirst
      .mockResolvedValueOnce({ id: "r-1", organization_id: null, key: "x.y" })
      .mockResolvedValueOnce({ count: "0" });
    transactionExecute.mockImplementation(async (cb: (trx: unknown) => Promise<unknown>) => {
      // Stub trx mirrors the production-builder shape just enough for
      // the two `deleteFrom(...).where(...).execute()` chains.
      const trx = {
        deleteFrom: () => ({
          where: () => ({ execute: vi.fn().mockResolvedValue(undefined) }),
        }),
      };
      await cb(trx);
    });
    const res = await DELETE_BY_ID(delReq(), ctx);
    expect(res.status).toBe(200);
    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.role.deleted", outcome: "success" }),
    );
  });
});
