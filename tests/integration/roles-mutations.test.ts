import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ListRoute from "@/app/api/administrator/roles/route";
import type * as IdRoute from "@/app/api/administrator/roles/[id]/route";

/**
 * ADR-0001 — role create/edit/delete scoping (P0-7).
 *   - Create: an ORG ADMIN may create roles ONLY in their own org — never a
 *     global role and never another org's (→ 403). SUPERADMIN may create
 *     global roles.
 *   - Edit/Delete: confined to the actor's org; a global or foreign role is
 *     SUPERADMIN-only and returns 404.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: { role: { id: string; organization_id: string | null; key: string } | undefined } = {
  role: undefined,
};

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
  if (table === "app_roles") return state.role;
  if (table === "app_user_roles") return { count: "0" }; // assertRoleNotInUse
  return undefined;
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow")
          return async () => ({ id: "role-new", key: "new-role" });
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
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    insertInto: (t: unknown) => makeChain(tableKey(t)),
    updateTable: (t: unknown) => makeChain(tableKey(t)),
    deleteFrom: (t: unknown) => makeChain(tableKey(t)),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({ deleteFrom: () => makeChain("trx") }),
    }),
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  const url = `http://test.local/api/administrator/roles${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const idCtx = { params: Promise.resolve({ id: ROLE }) };

let POST: typeof ListRoute.POST;
let PATCH: typeof IdRoute.PATCH;
let DELETE: typeof IdRoute.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.role = { id: ROLE, organization_id: ORG_A, key: "editor" };
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ POST } = await import("@/app/api/administrator/roles/route"));
  ({ PATCH, DELETE } = await import("@/app/api/administrator/roles/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("POST /roles — create scoping", () => {
  const mk = (organizationId: string | null) => ({ key: "x.y", name: "X", organizationId });

  it("ORG ADMIN creates a role in their own org (201)", async () => {
    state.role = undefined; // no uniqueness conflict
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await POST(req("", { method: "POST", body: mk(ORG_A) }))).status).toBe(201);
  });

  it("403 when an ORG ADMIN tries to create a GLOBAL role", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await POST(req("", { method: "POST", body: mk(null) }))).status).toBe(403);
  });

  it("403 when an ORG ADMIN targets another org", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    expect((await POST(req("", { method: "POST", body: mk(ORG_B) }))).status).toBe(403);
  });

  it("SUPERADMIN may create a GLOBAL role (201)", async () => {
    state.role = undefined; // dup-check returns none
    accessGetter.mockResolvedValue(superadmin(["admin.roles.create"]));
    expect((await POST(req("", { method: "POST", body: mk(null) }))).status).toBe(201);
  });
});

describe("PATCH/DELETE /roles/[id] — mutation scoping", () => {
  it("PATCH 200 own-org; 404 foreign; 404 global", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    expect(
      (await PATCH(req(`/${ROLE}`, { method: "PATCH", body: { name: "Renamed" } }), idCtx)).status,
    ).toBe(200);

    state.role = { id: ROLE, organization_id: ORG_B, key: "editor" };
    expect(
      (await PATCH(req(`/${ROLE}`, { method: "PATCH", body: { name: "Renamed" } }), idCtx)).status,
    ).toBe(404);

    state.role = { id: ROLE, organization_id: null, key: "global" };
    expect(
      (await PATCH(req(`/${ROLE}`, { method: "PATCH", body: { name: "Renamed" } }), idCtx)).status,
    ).toBe(404);
  });

  it("DELETE 200 own-org; 404 foreign role", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.delete"]));
    expect((await DELETE(req(`/${ROLE}`, { method: "DELETE" }), idCtx)).status).toBe(200);

    state.role = { id: ROLE, organization_id: ORG_B, key: "editor" };
    expect((await DELETE(req(`/${ROLE}`, { method: "DELETE" }), idCtx)).status).toBe(404);
  });

  it("SUPERADMIN may edit a global role (200)", async () => {
    state.role = { id: ROLE, organization_id: null, key: "global" };
    accessGetter.mockResolvedValue(superadmin(["admin.roles.update"]));
    expect(
      (await PATCH(req(`/${ROLE}`, { method: "PATCH", body: { name: "Renamed" } }), idCtx)).status,
    ).toBe(200);
  });
});
