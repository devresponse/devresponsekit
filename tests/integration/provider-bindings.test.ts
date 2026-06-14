import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as Route from "@/app/api/administrator/organizations/[id]/provider-bindings/route";

/**
 * ADR-0001 — organization provider bindings, org-scoped (P0-5).
 * The `[id]` is the org itself, so every verb is gated by
 * `canAccessOrg(access, id)`: an ORG ADMIN reaches only their own org;
 * a foreign org returns 404 (no existence leak); SUPERADMIN reaches all.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  org: { id: string; slug: string } | undefined;
  bindings: Array<{ id: string; provider: string; provider_organization_key: string }>;
} = { org: undefined, bindings: [] };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditOrgAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function firstFor(table: string) {
  if (table === "app_organizations") return state.org;
  if (table === "app_provider_organizations") return { total: String(state.bindings.length) };
  return undefined;
}
function makeChain(table: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return async () => firstFor(table);
        if (prop === "executeTakeFirstOrThrow") return async () => ({ id: "b-new" });
        if (prop === "execute")
          return async () => (table === "app_provider_organizations" ? state.bindings : []);
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
    deleteFrom: (t: unknown) => makeChain(tableKey(t)),
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BIND = "99999999-9999-4999-8999-999999999999";

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

function req(orgId: string, init?: { method?: string; body?: unknown }): NextRequest {
  const url = `http://test.local/api/administrator/organizations/${orgId}/provider-bindings`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}
const ctx = (orgId: string) => ({ params: Promise.resolve({ id: orgId }) });

let GET: typeof Route.GET;
let POST: typeof Route.POST;
let DELETE: typeof Route.DELETE;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  state.org = { id: ORG_A, slug: "org-a" };
  state.bindings = [{ id: BIND, provider: "google", provider_organization_key: "g-1" }];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET, POST, DELETE } =
    await import("@/app/api/administrator/organizations/[id]/provider-bindings/route"));
});
afterEach(() => vi.resetModules());

describe("provider-bindings — GET", () => {
  it("ORG ADMIN reads their own org (200)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.read"]));
    expect((await GET(req(ORG_A), ctx(ORG_A))).status).toBe(200);
  });
  it("ORG ADMIN gets 404 for a foreign org", async () => {
    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.read"]));
    expect((await GET(req(ORG_B), ctx(ORG_B))).status).toBe(404);
  });
  it("SUPERADMIN reads any org (200)", async () => {
    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(superadmin(["admin.orgs.read"]));
    expect((await GET(req(ORG_B), ctx(ORG_B))).status).toBe(200);
  });
});

describe("provider-bindings — POST", () => {
  const body = { provider: "google", providerOrganizationKey: "g-2" };
  it("ORG ADMIN binds in own org (201)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.update"]));
    expect((await POST(req(ORG_A, { method: "POST", body }), ctx(ORG_A))).status).toBe(201);
  });
  it("ORG ADMIN gets 404 binding in a foreign org", async () => {
    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.update"]));
    expect((await POST(req(ORG_B, { method: "POST", body }), ctx(ORG_B))).status).toBe(404);
  });
});

describe("provider-bindings — DELETE", () => {
  it("ORG ADMIN removes in own org (200); 404 in a foreign org", async () => {
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.update"]));
    expect(
      (await DELETE(req(ORG_A, { method: "DELETE", body: { bindingIds: [BIND] } }), ctx(ORG_A)))
        .status,
    ).toBe(200);

    state.org = { id: ORG_B, slug: "org-b" };
    accessGetter.mockResolvedValue(orgAdmin(["admin.orgs.update"]));
    expect(
      (await DELETE(req(ORG_B, { method: "DELETE", body: { bindingIds: [BIND] } }), ctx(ORG_B)))
        .status,
    ).toBe(404);
  });
});
