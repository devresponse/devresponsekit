import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/users/[id]/audit/route";

/**
 * GET /users/[id]/audit — a user's audit trail, org-scoped (ADR-0001).
 * The target user is already scoped by resolveTargetUser (mocked); this pins
 * the route contract:
 *   - requires `admin.audit.read` (403 without it — stricter than the page's
 *     own admin.users.read),
 *   - ORG ADMIN and SUPERADMIN both get 200 (the org filter is applied for the
 *     org admin; SUPERADMIN sees every org),
 *   - the response is a paginated list envelope.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

const state: { events: Array<Record<string, unknown>> } = { events: [] };

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
  if (table === "app_audit_events") return state.events;
  return [];
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst")
          return async () => ({ total: String(state.events.length) });
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
  const url = `http://test.local/api/administrator/users/${USER}/audit`;
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
  state.events = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      event_type: "admin.user.membership_added",
      outcome: "success",
      actor_better_auth_user_id: "ba-actor",
      app_user_id: "u-target",
      organization_id: ORG_A,
      target_application_id: null,
      provider: null,
      email: null,
      ip_address: null,
      user_agent: null,
      reason: null,
      metadata: {},
      created_at: "2026-06-16T00:00:00.000Z",
    },
  ];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET } = await import("@/app/api/administrator/users/[id]/audit/route"));
});
afterEach(() => vi.resetModules());

describe("GET /users/[id]/audit", () => {
  it("ORG ADMIN with admin.audit.read gets 200 (events narrowed to their org)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.audit.read"]));
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("SUPERADMIN gets 200 (all orgs)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.audit.read"]));
    expect((await GET(getReq(), ctx)).status).toBe(200);
  });

  it("403 without admin.audit.read (admin.users.read is not enough)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.users.read"]));
    expect((await GET(getReq(), ctx)).status).toBe(403);
  });
});
