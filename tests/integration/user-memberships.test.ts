import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/users/[id]/memberships/route";

/**
 * ADR-0001 — a user's memberships, org-scoped (P0-4, 0% covered before).
 *
 * The target user is already scoped (resolveTargetUser, mocked). This pins
 * the added membership scoping:
 *   - POST may only enroll into an org the actor can access (else 404),
 *   - PATCH/DELETE mutate ONLY the memberships the org-scoped lookup
 *     resolved — never the raw request id list — so a foreign-org id passed
 *     alongside a valid one cannot be mutated.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  org: { id: string; slug: string } | undefined;
  memberships: Array<{ id: string; organization_id: string; slug: string }>;
} = { org: undefined, memberships: [] };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
  auditOrgAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
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
  if (table === "app_organization_memberships") return { total: String(state.memberships.length) };
  if (table === "app_organizations") return state.org;
  return undefined;
}
function execFor(table: string): unknown[] {
  if (table === "app_organization_memberships") return state.memberships;
  return [];
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow") return async () => ({ id: "m-new" });
        if (prop === "execute") return async () => execFor(table);
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
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

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
  const url = `http://test.local/api/administrator/users/${USER}/memberships`;
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: USER }) };

let GET: typeof Route.GET;
let POST: typeof Route.POST;
let PATCH: typeof Route.PATCH;
let DELETE: typeof Route.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.org = { id: ORG_A, slug: "org-a" };
  state.memberships = [{ id: M1, organization_id: ORG_A, slug: "org-a" }];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET, POST, PATCH, DELETE } =
    await import("@/app/api/administrator/users/[id]/memberships/route"));
});
afterEach(() => vi.resetModules());

describe("GET /users/[id]/memberships", () => {
  it("ORG ADMIN gets 200 (list narrowed to their org)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.read"]));
    expect((await GET(jsonReq(undefined), ctx)).status).toBe(200);
  });
  it("SUPERADMIN gets 200 (all orgs)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.users.read"]));
    expect((await GET(jsonReq(undefined), ctx)).status).toBe(200);
  });
});

describe("POST /users/[id]/memberships — enroll into an org", () => {
  it("201 when enrolling into the actor's own org", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.update"]));
    expect((await POST(jsonReq({ organizationId: ORG_A }), ctx)).status).toBe(201);
  });

  it("404 when enrolling into a FOREIGN org", async () => {
    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.update"]));
    expect((await POST(jsonReq({ organizationId: ORG_B }), ctx)).status).toBe(404);
  });

  it("SUPERADMIN may enroll into any org (201)", async () => {
    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(superadmin(["admin.users.update"]));
    expect((await POST(jsonReq({ organizationId: ORG_B }), ctx)).status).toBe(201);
  });
});

describe("PATCH/DELETE — mutate only the org-scoped resolved ids", () => {
  it("PATCH only touches resolved memberships, not the raw id list", async () => {
    // Caller asks to mutate two ids, but the org-scoped lookup only resolves
    // one (the other belongs to a foreign org and is filtered out).
    state.memberships = [{ id: M1, organization_id: ORG_A, slug: "org-a" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.update"]));
    const res = await PATCH(jsonReq({ membershipIds: [M1, M2], status: "suspended" }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(1); // NOT 2 — the foreign id was never resolved
  });

  it("PATCH 404 when no membership resolves in scope", async () => {
    state.memberships = [];
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.update"]));
    expect((await PATCH(jsonReq({ membershipIds: [M2], status: "active" }), ctx)).status).toBe(404);
  });

  it("DELETE only removes resolved memberships", async () => {
    state.memberships = [{ id: M1, organization_id: ORG_A, slug: "org-a" }];
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.update"]));
    const res = await DELETE(jsonReq({ membershipIds: [M1, M2] }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number };
    expect(body.removed).toBe(1);
  });

  it("403 without admin.users.update", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.read"]));
    expect((await DELETE(jsonReq({ membershipIds: [M1] }), ctx)).status).toBe(403);
  });
});
