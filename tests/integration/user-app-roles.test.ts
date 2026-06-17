import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/users/[id]/app-roles/route";

/**
 * ADR-0001 — role assignment scoping (POST/DELETE app-roles).
 *
 * The target user is already org-scoped by `resolveTargetUser` (covered in
 * user-target.server tests, mocked here). This suite pins the ASSIGNMENT
 * scoping the P0 work added:
 *   - the body `organizationId` must be in the actor's org (else 404),
 *   - the role must belong to the actor's org (global/foreign role → 404),
 *   - a non-superadmin may NOT assign a role that carries the `superuser`
 *     marker (privilege escalation → 403); a SUPERADMIN may.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  role: { id: string; key: string; organization_id: string | null } | undefined;
  org: { id: string } | undefined;
  /** Permission keys the assigned role confers (AUTHZ-3 subset check). */
  conferredPermKeys: { key: string }[];
} = { role: undefined, org: undefined, conferredPermKeys: [] };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
}));
// requireAdminPermission writes a denial audit row through this module.
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
// Target resolution is exercised elsewhere; here it always resolves so the
// tests reach the role/org scoping under test.
vi.mock("@/lib/admin/user-target.server", () => ({
  resolveTargetUser: async () => ({
    appUserId: "u-target",
    betterAuthUserId: "ba-target",
    primaryEmail: "target@x.com",
  }),
  isResolvedUserResponse: (v: unknown) => v instanceof Response,
}));

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function firstFor(table: string) {
  if (table === "app_roles") return state.role;
  if (table === "app_organizations") return state.org;
  return undefined;
}
function execFor(table: string): unknown[] {
  // permissionKeysForRoles(...) selects the role's conferred permission keys.
  if (table === "app_role_permissions") return state.conferredPermKeys;
  return [];
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "execute") return async () => execFor(table);
        return (...args: unknown[]) => {
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (x: unknown) => unknown)(makeChain(table));
            } catch {
              /* eb/oc stub best-effort */
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
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({
          insertInto: () => makeChain("trx"),
          deleteFrom: () => makeChain("trx"),
        }),
    }),
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function jsonReq(body: unknown): NextRequest {
  return {
    nextUrl: new URL(`http://test.local/api/administrator/users/${USER}/app-roles`),
    url: `http://test.local/api/administrator/users/${USER}/app-roles`,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: USER }) };
const body = (organizationId: string) => ({ roleId: ROLE, organizationId });

let POST: typeof Route.POST;
let DELETE: typeof Route.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.role = { id: ROLE, key: "editor", organization_id: ORG_A };
  state.org = { id: ORG_A };
  state.conferredPermKeys = [];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ POST, DELETE } = await import("@/app/api/administrator/users/[id]/app-roles/route"));
});
afterEach(() => vi.resetModules());

describe("POST /users/[id]/app-roles — assignment scoping", () => {
  it("ORG ADMIN assigns a role in their own org (201)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(201);
  });

  it("404 when the body organizationId is a foreign org", async () => {
    state.role = { id: ROLE, key: "editor", organization_id: ORG_B };
    state.org = { id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_B)), ctx);
    expect(res.status).toBe(404);
  });

  it("404 when the role belongs to another org (even if the org arg is theirs)", async () => {
    state.role = { id: ROLE, key: "editor", organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(404);
  });

  it("404 when assigning a GLOBAL role (org admins cannot)", async () => {
    state.role = { id: ROLE, key: "global", organization_id: null };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(404);
  });

  it("403 when a non-superadmin assigns a role granting `superuser`", async () => {
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(403);
  });

  it("403 when a non-superadmin assigns a role conferring a permission they lack (AUTHZ-3)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.delete" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(403);
  });

  it("201 when the role's permissions are a subset the actor holds (AUTHZ-3)", async () => {
    state.conferredPermKeys = [{ key: "admin.users.read" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign", "admin.users.read"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(201);
  });

  it("SUPERADMIN MAY assign a role granting `superuser` (201)", async () => {
    state.role = { id: ROLE, key: "superuser", organization_id: null };
    state.org = { id: ORG_A };
    state.conferredPermKeys = [{ key: "superuser" }];
    accessGetter.mockResolvedValue(superadmin(["admin.roles.assign"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(201);
  });

  it("400 on an invalid body", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await POST(jsonReq({ roleId: "not-a-uuid" }), ctx);
    expect(res.status).toBe(400);
  });

  it("403 when the caller lacks admin.roles.assign", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    const res = await POST(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /users/[id]/app-roles — revocation scoping", () => {
  it("ORG ADMIN revokes within their own org (200)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await DELETE(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(200);
  });

  it("404 when revoking against a foreign org arg", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await DELETE(jsonReq(body(ORG_B)), ctx);
    expect(res.status).toBe(404);
  });

  it("404 when the role belongs to another org", async () => {
    state.role = { id: ROLE, key: "editor", organization_id: ORG_B };
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.assign"]));
    const res = await DELETE(jsonReq(body(ORG_A)), ctx);
    expect(res.status).toBe(404);
  });
});
