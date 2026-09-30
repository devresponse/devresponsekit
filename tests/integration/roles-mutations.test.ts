import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ListRoute from "@/app/api/administrator/roles/route";
import type * as IdRoute from "@/app/api/administrator/roles/[id]/route";
import { roleEtag } from "@/lib/admin/record-etag.server";
import { pgForeignKeyViolation, pgUniqueViolation } from "../helpers/pg-errors";

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

const state: {
  role:
    | {
        id: string;
        organization_id: string | null;
        key: string;
        name?: string;
        description?: string | null;
      }
    | undefined;
  /** F-63: what the role insert throws, when set. */
  insertError: Error | undefined;
} = {
  role: undefined,
  insertError: undefined,
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
          return async () => {
            if (state.insertError) throw state.insertError;
            return { id: "role-new", key: "new-role" };
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
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (t: unknown) => makeChain(tableKey(t)),
    insertInto: (t: unknown) => makeChain(tableKey(t)),
    updateTable: (t: unknown) => makeChain(tableKey(t)),
    deleteFrom: (t: unknown) => makeChain(tableKey(t)),
    // F-97: the in-use guard (lock + counts) and the deletes share one transaction.
    // F-39: so do the PATCH's If-Match check and its update.
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({
          selectFrom: (t: unknown) => makeChain(tableKey(t)),
          updateTable: (t: unknown) => makeChain(tableKey(t)),
          deleteFrom: () => makeChain("trx"),
        }),
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

function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): NextRequest {
  const url = `http://test.local/api/administrator/roles${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json", ...init?.headers }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const idCtx = { params: Promise.resolve({ id: ROLE }) };

let POST: typeof ListRoute.POST;
let GET: typeof IdRoute.GET;
let PATCH: typeof IdRoute.PATCH;
let DELETE: typeof IdRoute.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.role = { id: ROLE, organization_id: ORG_A, key: "editor" };
  state.insertError = undefined;
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ POST } = await import("@/app/api/administrator/roles/route"));
  ({ GET, PATCH, DELETE } = await import("@/app/api/administrator/roles/[id]/route"));
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

  // F-63 (#95): a SUPERADMIN naming an org that does not exist (a deleted one)
  // failed the insert's foreign key, a 500. It is the groups create's 404.
  it("F-63: 404 organization_not_found when a SUPERADMIN names an org that does not exist", async () => {
    state.role = undefined;
    // F-132: recognised by SQLSTATE and constraint, so a non-English message maps too.
    state.insertError = pgForeignKeyViolation("app_roles_organization_id_fkey");
    accessGetter.mockResolvedValue(superadmin(["admin.roles.create"]));
    const res = await POST(req("", { method: "POST", body: mk(ORG_B) }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "organization_not_found" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("F-132: 409 key_taken on the (organization_id, key) unique, whatever the server's message language", async () => {
    state.role = undefined;
    state.insertError = pgUniqueViolation("app_roles_organization_id_key_key");
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.create"]));
    const res = await POST(req("", { method: "POST", body: mk(ORG_A) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "key_taken" });
    expect(auditMock).not.toHaveBeenCalled();
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

/**
 * F-39: the role's content ETag. GET answers it; a PATCH naming another tag in
 * `If-Match` is 412 and writes nothing (the compare-and-swap under the row
 * lock is pinned against Postgres in tests/db/record-etag.db.test.ts).
 */
describe("roles/[id] ETag + If-Match (F-39)", () => {
  const current = () => roleEtag({ name: "", description: null, ...state.role! });
  const rename = (headers?: Record<string, string>) =>
    PATCH(req(`/${ROLE}`, { method: "PATCH", body: { name: "Renamed" }, headers }), idCtx);

  beforeEach(() => {
    state.role = {
      id: ROLE,
      organization_id: ORG_A,
      key: "editor",
      name: "Editor",
      description: null,
    };
  });

  it("GET answers the role's ETag", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.read"]));
    const res = await GET(req(`/${ROLE}`), idCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(current());
  });

  it("PATCH with the current tag, with `*` or without one is applied and answers the new tag", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    for (const headers of [{ "if-match": current() }, { "if-match": "*" }, undefined]) {
      const res = await rename(headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe(current());
    }
  });

  it("PATCH with a stale tag is 412 precondition_failed, carrying the current tag, and audits no update", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.roles.update"]));
    const res = await rename({ "if-match": 'W/"stale"' });
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ error: "precondition_failed" });
    expect(res.headers.get("etag")).toBe(current());
    expect(auditMock).not.toHaveBeenCalled();
  });
});
