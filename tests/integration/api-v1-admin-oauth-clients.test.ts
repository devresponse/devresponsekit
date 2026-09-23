import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as Route from "@/app/api/v1/admin/oauth-clients/route";
import type * as RotateSecretRoute from "@/app/api/v1/admin/oauth-clients/[id]/rotate-secret/route";
import type * as ClientRoute from "@/app/api/v1/admin/oauth-clients/[id]/route";

/**
 * /api/v1/admin/oauth-clients — machine-identity registration (was 0%).
 * Security contract (ADR-0001 + design §7):
 *   - org-scoped: an org admin lists/creates only in their own org; a null
 *     scope sees/creates nothing; the client-supplied organizationId is
 *     ignored for org admins,
 *   - the service principal must belong to the actor's org,
 *   - the creator may not grant scopes it does not itself hold,
 *   - the creator may not register a client for a service principal that
 *     OUTRANKS them (MACHINE-2 layer 2): the client BORROWS that principal's
 *     identity, and a global superuser's identity reaches every tenant, so a
 *     non-superadmin actor is refused whatever the scopes.
 *   - the SAME bound applies to `[id]/rotate-secret`, which is an on-behalf
 *     reissue: it hands the actor a fresh one-time secret for a credential
 *     that authenticates as the service principal, carrying the client's
 *     existing scopes forward verbatim (it never runs
 *     `ungrantableScopesForCaller` at all).
 *   - F-01: create, PATCH and rotate-secret all run the shared issuance rule
 *     (`unissuableScopes`): no account-WRITING scope on another principal's
 *     client, and a rotation may only hand the actor a scope set they could
 *     have granted themselves.
 * resolveOrgScope / canAccessOrg / userHasMembershipInOrg /
 * userIsGlobalSuperuser / unissuableScopes / ownerOutranksActor run for real;
 * the guard + repo + DB are mocked.
 */
const requireApiPermission = vi.fn();
const enforceApiRateLimit = vi.fn();
const listOauthClients = vi.fn();
const createOauthClient = vi.fn();
const getOauthClientById = vi.fn();
const rotateOauthClientSecret = vi.fn();
const updateOauthClient = vi.fn();
const auditEvent = vi.fn();

const state: {
  serviceUser: { id: string; status: string } | undefined;
  membership: { id: string } | undefined;
  /** Drives the REAL `userIsGlobalSuperuser` (an `app_user_roles` join). */
  serviceIsSuperuser: boolean;
} = {
  serviceUser: undefined,
  membership: undefined,
  serviceIsSuperuser: false,
};

vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: (...a: unknown[]) => enforceApiRateLimit(...a),
}));
vi.mock("@/lib/api-auth/oauth-clients.server", () => ({
  listOauthClients: (...a: unknown[]) => listOauthClients(...a),
  createOauthClient: (...a: unknown[]) => createOauthClient(...a),
  getOauthClientById: (...a: unknown[]) => getOauthClientById(...a),
  rotateOauthClientSecret: (...a: unknown[]) => rotateOauthClientSecret(...a),
  updateOauthClient: (...a: unknown[]) => updateOauthClient(...a),
  revokeOauthClient: vi.fn(),
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
              table === "app_users"
                ? state.serviceUser
                : table === "app_organization_memberships"
                  ? state.membership
                  : table === "app_user_roles"
                    ? state.serviceIsSuperuser
                      ? { id: "perm-superuser" }
                      : undefined
                    : undefined;
          if (prop === "execute") return async () => [];
          return () => chain(table);
        },
      },
    );
  }
  return { db: { selectFrom: (t: unknown) => chain(tableKey(t)) } };
});

const SVC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT_ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

function grant(opts: {
  permissions: string[];
  organizationId: string | null;
  grantedScopes?: string[] | null;
}) {
  return {
    ok: true,
    grant: {
      caller: {
        betterAuthUserId: "ba1",
        grantedScopes: opts.grantedScopes ?? null,
        access: {
          permissions: opts.permissions,
          organizationId: opts.organizationId,
          appUserId: "admin-app-user",
        },
      },
      requestId: "r1",
    },
  };
}
const orgAdmin = (extra: string[] = []) =>
  grant({
    permissions: ["admin.clients.read", "admin.clients.manage", ...extra],
    organizationId: "o1",
  });
const superadmin = () =>
  grant({
    permissions: ["admin.clients.read", "admin.clients.manage", "superuser"],
    organizationId: null,
  });
const nullScope = () =>
  grant({ permissions: ["admin.clients.read", "admin.clients.manage"], organizationId: null });

let GET: typeof Route.GET;
let POST: typeof Route.POST;
let ROTATE_SECRET: typeof RotateSecretRoute.POST;
let PATCH: typeof ClientRoute.PATCH;

beforeEach(async () => {
  for (const m of [
    requireApiPermission,
    enforceApiRateLimit,
    listOauthClients,
    createOauthClient,
    getOauthClientById,
    rotateOauthClientSecret,
    updateOauthClient,
    auditEvent,
  ])
    m.mockReset();
  updateOauthClient.mockResolvedValue(true);
  enforceApiRateLimit.mockReturnValue(null);
  getOauthClientById.mockResolvedValue({
    id: CLIENT_ROW_ID,
    client_id: "drkc_x",
    app_user_id: SVC,
    organization_id: "o1",
    status: "active",
    scopes: [],
  });
  rotateOauthClientSecret.mockResolvedValue("drkcsec_ROTATED");
  listOauthClients.mockResolvedValue({ items: [{ id: "c1" }], total: 1 });
  createOauthClient.mockResolvedValue({
    id: "c-new",
    client_id: "drkc_x",
    name: "n",
    scopes: [],
    clientSecret: "drkcsec_SECRET",
  });
  state.serviceUser = { id: SVC, status: "active" };
  state.membership = { id: "m1" };
  state.serviceIsSuperuser = false;
  ({ GET, POST } = await import("@/app/api/v1/admin/oauth-clients/route"));
  ({ POST: ROTATE_SECRET } =
    await import("@/app/api/v1/admin/oauth-clients/[id]/rotate-secret/route"));
  ({ PATCH } = await import("@/app/api/v1/admin/oauth-clients/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/v1/admin/oauth-clients", () => {
  it("returns the guard response when denied", async () => {
    const { NextResponse } = await import("next/server");
    requireApiPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
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
    expect(listOauthClients).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "o1" }),
    );
  });

  it("SUPERADMIN lists across all orgs (organizationId undefined)", async () => {
    requireApiPermission.mockResolvedValue(superadmin());
    await GET(req());
    expect(listOauthClients).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: undefined }),
    );
  });
});

describe("POST /api/v1/admin/oauth-clients", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    name: "svc",
    scopes: [],
    serviceAppUserId: SVC,
    ...extra,
  });

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
    expect(createOauthClient).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "o1" }),
    );
  });

  it("403 forbidden for a null-scope admin", async () => {
    requireApiPermission.mockResolvedValue(nullScope());
    expect((await POST(req({ method: "POST", body: body() }))).status).toBe(403);
  });

  /**
   * MACHINE-2 layer 2. These fail without the fix: the scopes requested are
   * `[]`, so `ungrantableScopesForCaller` is satisfied and the registration
   * used to return 201 with a one-time `clientSecret` for a superuser identity.
   */
  it("403 when the service principal is a GLOBAL SUPERUSER and the actor is not", async () => {
    state.serviceIsSuperuser = true;
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(req({ method: "POST", body: body() }));
    expect(res.status).toBe(403);
    expect(createOauthClient).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        reason: "service_principal_outranks_actor",
      }),
    );
  });

  it("F-01: 403 invalid_scope for an account-WRITING scope on ANOTHER principal's client", async () => {
    // `account.*` is self-grantable, so the actor bound alone let an org admin
    // register a client that acts on a co-member's own account — the entry
    // point of the cross-tenant key takeover through /api/v1/me/api-keys.
    // `account.read` stays grantable (read-only, tenant-confined).
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(
      req({
        method: "POST",
        body: body({ scopes: ["account.read", "account.apikeys.manage", "account.profile.write"] }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ungrantableScopes: string[] };
    expect(json.ungrantableScopes).toEqual(["account.apikeys.manage", "account.profile.write"]);
    expect(createOauthClient).not.toHaveBeenCalled();
  });

  it("F-01: account.read stays grantable on another principal's client (service /me probe)", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await POST(req({ method: "POST", body: body({ scopes: ["account.read"] }) }));
    expect(res.status).toBe(201);
  });

  it("F-01: an IMPERSONATED session cannot put account-writing scopes on the borrowed user's client", async () => {
    // The session carries the borrowed user's appUserId, which equals the
    // service principal — without `impersonatorId` it would count as the owner.
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: {
        caller: {
          betterAuthUserId: "ba-svc",
          grantedScopes: null,
          impersonatorId: "ba-admin",
          access: {
            permissions: ["admin.clients.read", "admin.clients.manage"],
            organizationId: "o1",
            appUserId: SVC,
          },
        },
        requestId: "r1",
      },
    });
    const res = await POST(
      req({ method: "POST", body: body({ scopes: ["account.apikeys.manage"] }) }),
    );
    expect(res.status).toBe(403);
    expect(createOauthClient).not.toHaveBeenCalled();
  });

  it("F-01: every account scope stays grantable when the principal is the CALLER themselves", async () => {
    // The e2e MCP flow registers a client for the admin's own principal with
    // `account.read` (tests/e2e/mcp-bearer-only.spec.ts); that must keep working.
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: {
        caller: {
          betterAuthUserId: "ba-svc",
          grantedScopes: null,
          access: {
            permissions: ["admin.clients.read", "admin.clients.manage"],
            organizationId: "o1",
            appUserId: SVC,
          },
        },
        requestId: "r1",
      },
    });
    const res = await POST(
      req({ method: "POST", body: body({ scopes: ["account.read", "account.apikeys.manage"] }) }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERADMIN may still register a client for a superuser service principal", async () => {
    state.serviceIsSuperuser = true;
    requireApiPermission.mockResolvedValue(superadmin());
    const res = await POST(req({ method: "POST", body: body() }));
    expect(res.status).toBe(201);
    expect(createOauthClient).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/admin/oauth-clients/[id]/rotate-secret — service-principal reach bound", () => {
  const ctx = { params: Promise.resolve({ id: CLIENT_ROW_ID }) };
  const rotateReq = () => req({ method: "POST" });

  /**
   * The rotate twin was the one on-behalf reissue path layer 2 originally
   * missed. It has NO scope bound of its own — the reissued secret carries the
   * client's existing scopes forward verbatim — so before this bound an org
   * admin holding only `admin.clients.manage` could rotate any superuser-owned
   * client in their own org, pocket the new secret, exchange it at
   * `/api/v1/auth/token`, and wield that superuser's authority in the tenant.
   */
  it("403 when the service principal is a GLOBAL SUPERUSER and the actor is not", async () => {
    state.serviceIsSuperuser = true;
    requireApiPermission.mockResolvedValue(orgAdmin());

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        reason: "service_principal_outranks_actor",
      }),
    );
  });

  it("SUPERADMIN may still rotate a superuser-owned client's secret", async () => {
    state.serviceIsSuperuser = true;
    requireApiPermission.mockResolvedValue(superadmin());

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(200);
    expect(rotateOauthClientSecret).toHaveBeenCalledTimes(1);
  });

  it("ORG ADMIN may still rotate an ORDINARY principal's client (unchanged behaviour)", async () => {
    state.serviceIsSuperuser = false;
    requireApiPermission.mockResolvedValue(orgAdmin());

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(200);
    expect(rotateOauthClientSecret).toHaveBeenCalledTimes(1);
  });

  it("P1-1: a superuser-OWNED bearer credential is NOT exempt from the bound", async () => {
    // `access.permissions` is the credential OWNER's held set, not the
    // credential's authority — a superuser-owned key scoped to
    // `admin.clients.manage` must not be able to reissue a superuser-owned
    // client's secret and escalate from one scope to that client's whole set.
    state.serviceIsSuperuser = true;
    requireApiPermission.mockResolvedValue(
      grant({
        permissions: ["admin.clients.read", "admin.clients.manage", "superuser"],
        organizationId: "o1",
        grantedScopes: ["admin.clients.manage"],
      }),
    );

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/admin/oauth-clients/[id]/rotate-secret — scope bound (F-01)", () => {
  const ctx = { params: Promise.resolve({ id: CLIENT_ROW_ID }) };
  const rotateReq = () => req({ method: "POST" });
  const client = (scopes: string[]) => ({
    id: CLIENT_ROW_ID,
    client_id: "drkc_x",
    app_user_id: SVC,
    organization_id: "o1",
    status: "active",
    scopes,
  });

  it("403 invalid_scope when the client carries a scope the actor cannot grant", async () => {
    // Before F-01 only SUPERUSER principals were bounded: an org admin holding
    // `admin.clients.manage` could rotate another agent's `admin.roles.assign`
    // client, exchange the new secret, and assign themselves roles.
    getOauthClientById.mockResolvedValue(client(["admin.roles.assign"]));
    requireApiPermission.mockResolvedValue(orgAdmin());

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "scope_not_grantable" }),
    );
  });

  it("403 when the client carries another principal's account-WRITING scope", async () => {
    getOauthClientById.mockResolvedValue(client(["account.apikeys.manage"]));
    requireApiPermission.mockResolvedValue(orgAdmin());

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
  });

  it("200 when the actor holds every scope the client carries", async () => {
    getOauthClientById.mockResolvedValue(client(["admin.roles.assign"]));
    requireApiPermission.mockResolvedValue(orgAdmin(["admin.roles.assign"]));

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(200);
    expect(rotateOauthClientSecret).toHaveBeenCalledTimes(1);
  });

  it("a narrow BEARER actor cannot rotate a broader client even if its owner could", async () => {
    getOauthClientById.mockResolvedValue(client(["admin.roles.assign"]));
    requireApiPermission.mockResolvedValue(
      grant({
        permissions: ["admin.clients.read", "admin.clients.manage", "admin.roles.assign"],
        organizationId: "o1",
        grantedScopes: ["admin.clients.manage"],
      }),
    );

    const res = await ROTATE_SECRET(rotateReq(), ctx);

    expect(res.status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
  });
});

describe("POST rotate-secret — status before scope (F-01)", () => {
  it("409 (not a scope denial) for an inactive client, and no denial audit row", async () => {
    getOauthClientById.mockResolvedValue({
      id: CLIENT_ROW_ID,
      client_id: "drkc_x",
      app_user_id: SVC,
      organization_id: "o1",
      status: "revoked",
      scopes: ["admin.roles.assign"],
    });
    requireApiPermission.mockResolvedValue(orgAdmin());

    const res = await ROTATE_SECRET(req({ method: "POST" }), {
      params: Promise.resolve({ id: CLIENT_ROW_ID }),
    });

    expect(res.status).toBe(409);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/admin/oauth-clients/[id] — issuance rule (F-01)", () => {
  const ctx = { params: Promise.resolve({ id: CLIENT_ROW_ID }) };
  const patch = (scopes: string[]) => req({ method: "PATCH", body: { scopes } });

  it("403 for an account-WRITING scope on another principal's client", async () => {
    // The caller may already hold this client's secret, so widening it is
    // issuing the wider set to them.
    requireApiPermission.mockResolvedValue(orgAdmin());
    const res = await PATCH(patch(["account.read", "account.apikeys.manage"]), ctx);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ungrantableScopes: string[] };
    expect(json.ungrantableScopes).toEqual(["account.apikeys.manage"]);
    expect(updateOauthClient).not.toHaveBeenCalled();
  });

  it("403 for an admin scope the caller does not hold (actor bound)", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin());
    expect((await PATCH(patch(["admin.users.read"]), ctx)).status).toBe(403);
    expect(updateOauthClient).not.toHaveBeenCalled();
  });

  it("403 for a BEARER caller widening past its own scopes, whatever its owner holds", async () => {
    requireApiPermission.mockResolvedValue(
      grant({
        permissions: ["admin.clients.read", "admin.clients.manage", "admin.users.read"],
        organizationId: "o1",
        grantedScopes: ["admin.clients.manage"],
      }),
    );
    expect((await PATCH(patch(["admin.users.read"]), ctx)).status).toBe(403);
    expect(updateOauthClient).not.toHaveBeenCalled();
  });

  it("200 for scopes the caller holds, account.read included", async () => {
    requireApiPermission.mockResolvedValue(orgAdmin(["admin.users.read"]));
    const res = await PATCH(patch(["admin.users.read", "account.read"]), ctx);
    expect(res.status).toBe(200);
    expect(updateOauthClient).toHaveBeenCalledWith(CLIENT_ROW_ID, {
      name: undefined,
      scopes: ["admin.users.read", "account.read"],
    });
  });
});

describe("F-01: an IMPERSONATED session is not the principal of the borrowed user's client", () => {
  // The client's service principal IS the caller's appUserId, so without
  // `impersonatorId` the caller would count as the owner.
  const ctx = { params: Promise.resolve({ id: CLIENT_ROW_ID }) };
  const ownClient = {
    id: CLIENT_ROW_ID,
    client_id: "drkc_x",
    app_user_id: "admin-app-user",
    organization_id: "o1",
    status: "active",
    scopes: ["account.apikeys.manage"],
  };
  function impersonated(impersonatorId: string | null) {
    const g = orgAdmin();
    return { ...g, grant: { ...g.grant, caller: { ...g.grant.caller, impersonatorId } } };
  }

  it("rotate-secret: 403 under impersonation, 200 for the owner themselves", async () => {
    getOauthClientById.mockResolvedValue(ownClient);

    requireApiPermission.mockResolvedValue(impersonated("ba-real-admin"));
    expect((await ROTATE_SECRET(req({ method: "POST" }), ctx)).status).toBe(403);
    expect(rotateOauthClientSecret).not.toHaveBeenCalled();

    requireApiPermission.mockResolvedValue(impersonated(null));
    expect((await ROTATE_SECRET(req({ method: "POST" }), ctx)).status).toBe(200);
  });

  it("PATCH: 403 under impersonation, 200 for the owner themselves", async () => {
    getOauthClientById.mockResolvedValue({ ...ownClient, scopes: [] });
    const patch = () => req({ method: "PATCH", body: { scopes: ["account.apikeys.manage"] } });

    requireApiPermission.mockResolvedValue(impersonated("ba-real-admin"));
    expect((await PATCH(patch(), ctx)).status).toBe(403);
    expect(updateOauthClient).not.toHaveBeenCalled();

    requireApiPermission.mockResolvedValue(impersonated(null));
    expect((await PATCH(patch(), ctx)).status).toBe(200);
  });
});

describe("F-05: a bearer caller is bounded by scope ∩ permission, not scope names", () => {
  it("an agent whose ceiling exceeds its role cannot register a client for a more-privileged co-member", async () => {
    // Agent A's scope ceiling names admin.users.delete, but A's service user
    // only holds admin.clients.* — A could never USE admin.users.delete. It
    // tries to confer it on a client for co-member SVC, who does hold it.
    requireApiPermission.mockResolvedValue(
      grant({
        permissions: ["admin.clients.read", "admin.clients.manage"],
        organizationId: "o1",
        grantedScopes: ["admin.clients.manage", "admin.users.delete"],
      }),
    );
    const res = await POST(
      req({
        method: "POST",
        body: { name: "x", scopes: ["admin.users.delete"], serviceAppUserId: SVC },
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ungrantableScopes: string[] };
    expect(json.ungrantableScopes).toEqual(["admin.users.delete"]);
    expect(createOauthClient).not.toHaveBeenCalled();
  });

  it("control: the same agent may confer a scope it both carries and holds", async () => {
    requireApiPermission.mockResolvedValue(
      grant({
        permissions: ["admin.clients.read", "admin.clients.manage"],
        organizationId: "o1",
        grantedScopes: ["admin.clients.manage", "admin.clients.read"],
      }),
    );
    const res = await POST(
      req({
        method: "POST",
        body: { name: "x", scopes: ["admin.clients.read"], serviceAppUserId: SVC },
      }),
    );
    expect(res.status).toBe(201);
  });
});
