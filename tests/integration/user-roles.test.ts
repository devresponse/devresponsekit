import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/users/[id]/roles/route";

/**
 * GET /users/[id]/roles — a user's application role assignments, org-scoped
 * (ADR-0001). The target user is already scoped by resolveTargetUser (mocked);
 * this pins the route contract:
 *   - requires `admin.users.read` (403 without it),
 *   - ORG ADMIN and SUPERADMIN both get 200 (the org filter is applied to the
 *     query for the org admin; SUPERADMIN sees every org),
 *   - the response is a paginated list envelope.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

const state: { roles: Array<Record<string, unknown>> } = { roles: [] };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
// The denial path in requireAdminPermission writes a "denied" audit row.
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
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
function execFor(table: string): unknown[] {
  if (table === "app_user_roles") return state.roles;
  return [];
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => ({ total: String(state.roles.length) });
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
  db: { selectFrom: (t: unknown) => makeChain(tableKey(t)) },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

function getReq(): NextRequest {
  const url = `http://test.local/api/administrator/users/${USER}/roles`;
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    json: async () => undefined,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: USER }) };

let GET: typeof Route.GET;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter]) m.mockReset();
  state.roles = [
    {
      id: `${ORG_A}:role-1`,
      role_id: "role-1",
      role_key: "superuser",
      role_name: "Superuser",
      role_description: null,
      organization_id: ORG_A,
      organization_slug: "org-a",
      organization_name: "ORG A",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET } = await import("@/app/api/administrator/users/[id]/roles/route"));
});
afterEach(() => vi.resetModules());

describe("GET /users/[id]/roles", () => {
  it("ORG ADMIN gets 200 (assignments narrowed to their org)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.read"]));
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("SUPERADMIN gets 200 (all orgs)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.users.read"]));
    expect((await GET(getReq(), ctx)).status).toBe(200);
  });

  it("403 without admin.users.read", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.read"]));
    expect((await GET(getReq(), ctx)).status).toBe(403);
  });
});
