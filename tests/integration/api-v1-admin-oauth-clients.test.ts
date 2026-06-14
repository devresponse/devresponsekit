import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * /api/v1/admin/oauth-clients — machine-identity registration (was 0%).
 * Security contract (ADR-0001 + design §7):
 *   - org-scoped: an org admin lists/creates only in their own org; a null
 *     scope sees/creates nothing; the client-supplied organizationId is
 *     ignored for org admins,
 *   - the service principal must belong to the actor's org,
 *   - the creator may not grant scopes it does not itself hold.
 * resolveOrgScope / userHasMembershipInOrg / ungrantableScopesForCaller run
 * for real; the guard + repo + DB are mocked.
 */
const requireApiPermission = vi.fn();
const enforceApiRateLimit = vi.fn();
const listOauthClients = vi.fn();
const createOauthClient = vi.fn();
const auditEvent = vi.fn();

const state: { serviceUser: { id: string; status: string } | undefined; membership: { id: string } | undefined } = {
  serviceUser: undefined,
  membership: undefined,
};

vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: (...a: unknown[]) => enforceApiRateLimit(...a),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  listOauthClients: (...a: unknown[]) => listOauthClients(...a),
  createOauthClient: (...a: unknown[]) => createOauthClient(...a),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));
vi.mock("@/db/database", () => {
  function tableKey(t: unknown) {
    return String(t).split(" ")[0] ?? "";
  }
  function chain(table: string): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "executeTakeFirst")
            return async () =>
              table === "app_users" ? state.serviceUser : table === "app_organization_memberships" ? state.membership : undefined;
          if (prop === "execute") return async () => [];
          return () => chain(table);
        },
      },
    );
  }
  return { db: { selectFrom: (t: unknown) => chain(tableKey(t)) } };
});

const SVC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function req(init?: { method?: string; body?: unknown; query?: string }): NextRequest {
  const url = `http://test.local/api/v1/admin/oauth-clients${init?.query ?? ""}`;
  return {
    nextUrl: new URL(url),
    url,
    method: init?.method ?? "GET",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => init?.body,
  } as unknown as NextRequest;
}

function grant(opts: { permissions: string[]; organizationId: string | null; grantedScopes?: string[] | null }) {
  return {
    ok: true,
    grant: {
      caller: {
        betterAuthUserId: "ba1",
        grantedScopes: opts.grantedScopes ?? null,
        access: { permissions: opts.permissions, organizationId: opts.organizationId, appUserId: "admin-app-user" },
      },
      requestId: "r1",
    },
  };
}
const orgAdmin = (extra: string[] = []) => grant({ permissions: ["admin.clients.read", "admin.clients.manage", ...extra], organizationId: "o1" });
const superadmin = () => grant({ permissions: ["admin.clients.read", "admin.clients.manage", "superuser"], organizationId: null });
const nullScope = () => grant({ permissions: ["admin.clients.read", "admin.clients.manage"], organizationId: null });

let GET: typeof import("@/app/api/v1/admin/oauth-clients/route").GET;
let POST: typeof import("@/app/api/v1/admin/oauth-clients/route").POST;

beforeEach(async () => {
  for (const m of [requireApiPermission, enforceApiRateLimit, listOauthClients, createOauthClient, auditEvent]) m.mockReset();
  enforceApiRateLimit.mockReturnValue(null);
  listOauthClients.mockResolvedValue({ items: [{ id: "c1" }], total: 1 });
  createOauthClient.mockResolvedValue({ id: "c-new", client_id: "drkc_x", name: "n", scopes: [], clientSecret: "drkcsec_SECRET" });
  state.serviceUser = { id: SVC, status: "active" };
  state.membership = { id: "m1" };
  ({ GET, POST } = await import("@/app/api/v1/admin/oauth-clients/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/admin/oauth-clients", () => {
  it("returns the guard response when denied", async () => {
    const { NextResponse } = await import("next/server");
    requireApiPermission.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    expect((await GET(req())).status).toBe(403);
  });

  it("null scope → empty list, repo NOT queried", async () => {
    requireApiPermission.mockResolvedValue(nullScope());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(listOauthClients).not.toHaveBeenCalled();
  });

  it("ORG ADMIN lists scoped to their org", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin());
    await GET(req());
    expect(listOauthClients).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "o1" }));
  });

  it("SUPERADMIN lists across all orgs (organizationId undefined)", async () => {
    requireApiPermission.mockResolvedValue(superadmin());
    await GET(req());
    expect(listOauthClients).toHaveBeenCalledWith(expect.objectContaining({ organizationId: undefined }));
  });
});

describe("POST /api/v1/admin/oauth-clients", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ name: "svc", scopes: [], serviceAppUserId: SVC, ...extra });

  it("400 when the service principal does not exist", async () => {
    state.serviceUser = undefined;
    requireApiPermission.mockResolvedValue(orgAdmin());
    expect((await POST(req({ method: "POST", body: body() }))).status).toBe(400);
  });

  it("400 when the service principal is not in the org admin's org", async () => {
    state.membership = undefined; // userHasMembershipInOrg → false
    requireApiPermission.mockResolvedValue(orgAdmin());
    expect((await POST(req({ method: "POST", body: body() }))).status).toBe(400);
  });

  it("403 invalid_scope when granting a scope the creator does not hold", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(req({ method: "POST", body: body({ scopes: ["admin.users.read"] }) }));
    expect(res.status).toBe(403);
    expect(createOauthClient).not.toHaveBeenCalled();
  });

  it("ORG ADMIN success forces the client into THEIR org (client-supplied org ignored)", async () => {
    const FOREIGN_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(req({ method: "POST", body: body({ organizationId: FOREIGN_ORG }) }));
    expect(res.status).toBe(201);
    // The org admin's own org wins; the attacker-supplied org is ignored.
    expect(createOauthClient).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "o1" }));
  });

  it("403 forbidden for a null-scope admin", async () => {
    requireApiPermission.mockResolvedValue(nullScope());
    expect((await POST(req({ method: "POST", body: body() }))).status).toBe(403);
  });
});
