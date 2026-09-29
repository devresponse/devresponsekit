import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ListRoute from "@/app/api/administrator/permissions/route";
import type * as IdRoute from "@/app/api/administrator/permissions/[id]/route";
import { pgUniqueViolation } from "../helpers/pg-errors";

/**
 * ADR-0001 — the permission catalog is platform-global (P0-10). Mutating it
 * affects every tenant, so writes are SUPERADMIN-only even for an
 * org-admin-tier holder of `admin.permissions.manage`. Reads stay open to
 * any `admin.roles.read` holder.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  existing: { id: string; key: string } | undefined;
  /** Thrown by the create's insert (`executeTakeFirstOrThrow`), when set. */
  insertError: Error | undefined;
} = { existing: undefined, insertError: undefined };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function firstFor(table: string) {
  if (table === "app_permissions") return state.existing;
  if (table === "app_role_permissions") return { count: "0" }; // assertPermissionNotInUse
  return undefined;
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow")
          return async () => {
            if (state.insertError) throw state.insertError;
            return { id: "perm-new", key: "custom.perm" };
          };
        if (prop === "execute") return async () => [];
        return (...args: unknown[]) => {
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (x: unknown) => unknown)(makeChain(table));
            } catch {
              /* best-effort */
            }
          }
          return makeChain(table);
        };
      },
    },
  );
}
vi.mock("@/db/database", () => {
  const db = {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    insertInto: (t: unknown) => makeChain(tableKey(t)),
    updateTable: (t: unknown) => makeChain(tableKey(t)),
    deleteFrom: (t: unknown) => makeChain(tableKey(t)),
    // F-97: the DELETE's in-use guard and the delete share one transaction.
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) => cb(db),
    }),
  };
  return { db };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERM = "77777777-7777-4777-8777-777777777777";

function orgAdmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "admin-1",
    primaryEmail: "admin@org-a.com",
    status: "active",
    organizationId: ORG_A,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: perms,
  };
}
function superadmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return { ...orgAdmin(perms), organizationId: null, permissions: [...perms, "superuser"] };
}

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  const url = `http://test.local/api/administrator/permissions${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const idCtx = { params: Promise.resolve({ id: PERM }) };

let POST: typeof ListRoute.POST;
let PATCH: typeof IdRoute.PATCH;
let DELETE: typeof IdRoute.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.existing = { id: PERM, key: "admin.users.read" };
  state.insertError = undefined;
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ POST } = await import("@/app/api/administrator/permissions/route"));
  ({ PATCH, DELETE } = await import("@/app/api/administrator/permissions/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("POST /permissions — SUPERADMIN-only create", () => {
  const body = { key: "custom.perm", description: "x" };
  it("403 for an ORG ADMIN holding admin.permissions.manage", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.permissions.manage"]));
    expect((await POST(req("", { method: "POST", body }))).status).toBe(403);
  });
  it("201 for a SUPERADMIN", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.permissions.manage"]));
    expect((await POST(req("", { method: "POST", body }))).status).toBe(201);
  });
  it("403 when lacking admin.permissions.manage entirely", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    expect((await POST(req("", { method: "POST", body }))).status).toBe(403);
  });
  it("409 key_taken on the key unique, whatever the server's message language (F-132)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.permissions.manage"]));
    state.insertError = pgUniqueViolation("app_permissions_key_key");
    const res = await POST(req("", { method: "POST", body }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "key_taken" });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /permissions/[id] — SUPERADMIN-only edit", () => {
  const body = { description: "new" };
  it("403 for an ORG ADMIN with admin.permissions.manage", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.permissions.manage"]));
    expect((await PATCH(req(`/${PERM}`, { method: "PATCH", body }), idCtx)).status).toBe(403);
  });
  it("200 for a SUPERADMIN", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.permissions.manage"]));
    expect((await PATCH(req(`/${PERM}`, { method: "PATCH", body }), idCtx)).status).toBe(200);
  });
});

describe("DELETE /permissions/[id] — SUPERADMIN-only delete", () => {
  it("403 for an ORG ADMIN with admin.permissions.manage", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.permissions.manage"]));
    expect((await DELETE(req(`/${PERM}`, { method: "DELETE" }), idCtx)).status).toBe(403);
  });
  it("200 for a SUPERADMIN", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.permissions.manage"]));
    expect((await DELETE(req(`/${PERM}`, { method: "DELETE" }), idCtx)).status).toBe(200);
  });
});
