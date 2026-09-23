import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as MembersRouteModule from "@/app/api/administrator/organizations/[id]/members/route";

/**
 * Integration tests for the organization members endpoints (docs/admin-manager.md
 * Phase 5 test plan). The DB layer is stubbed — these tests pin the handler
 * contract: permission gates, response envelopes, and machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const insertExecute = vi.fn();

/**
 * Rows `activeGlobalSuperuserGrants` sees (REVOKE-2). Kept apart from
 * `itemsExecute` because PATCH/DELETE now read TWO different tables:
 * the memberships they are about to mutate, and the surviving superuser
 * grants. Empty by default, so a platform with nothing to protect behaves
 * exactly as before.
 */
const superuserGrants: {
  rows: Array<{ app_user_id: string; organization_id: string; role_id: string }>;
  /**
   * What the rank guard's single-row `userHoldsSuperuserGrant` probe (F-09)
   * finds for the member. `undefined` = no superuser grant anywhere; a row =
   * one, possibly asleep in a suspended org.
   */
  holdsGrant: { id: string } | undefined;
} = { rows: [], holdsGrant: undefined };

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("@/db/database", () => {
  function makeChain(table: string) {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") {
            return table === "app_user_roles" ? async () => superuserGrants.rows : itemsExecute;
          }
          if (prop === "executeTakeFirst") {
            return table === "app_user_roles"
              ? async () => superuserGrants.holdsGrant
              : selectFirst;
          }
          if (prop === "executeTakeFirstOrThrow") {
            return async () => {
              const v = await selectFirst();
              if (!v) throw new Error("no_row");
              return v;
            };
          }
          return (...args: unknown[]) => {
            const cb = args[0];
            if (typeof cb === "function") {
              try {
                (cb as (eb: unknown) => unknown)(
                  new Proxy(() => ({}), {
                    get: () => () => ({}),
                    apply: () => ({}),
                  }),
                );
              } catch {
                /* ignore */
              }
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const tableKey = (t: unknown) => String(t).split(" ")[0] ?? "";
  const updateChain = () => ({
    set: () => ({
      where: () => ({
        execute: itemsExecute,
        where: () => ({ execute: itemsExecute }),
      }),
    }),
  });
  const deleteChain = () => ({
    where: () => ({
      execute: itemsExecute,
      where: () => ({
        execute: itemsExecute,
        where: () => ({ execute: itemsExecute }),
      }),
    }),
  });
  return {
    db: {
      selectFrom: (t: unknown) => makeChain(tableKey(t)),
      insertInto: () => ({
        values: () => ({
          returning: () => ({
            executeTakeFirstOrThrow: () => insertExecute(),
          }),
          onConflict: () => ({
            doNothing: () => ({
              returning: () => ({ executeTakeFirst: selectFirst }),
            }),
          }),
        }),
      }),
      updateTable: updateChain,
      deleteFrom: deleteChain,
      // PATCH/DELETE now check REVOKE-2 and write in ONE transaction, so the
      // trx stub has to read as well as write.
      transaction: () => ({
        execute: async (cb: (trx: unknown) => Promise<unknown>) =>
          cb({
            selectFrom: (t: unknown) => makeChain(tableKey(t)),
            updateTable: updateChain,
            deleteFrom: deleteChain,
          }),
      }),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function listReq(query: string = ""): NextRequest {
  const url = new URL(
    `http://test.local/api/administrator/organizations/${ORG_ID}/members${query}`,
  );
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL(`http://test.local/api/administrator/organizations/${ORG_ID}/members`),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

let GET: typeof MembersRouteModule.GET;
let POST: typeof MembersRouteModule.POST;
let PATCH: typeof MembersRouteModule.PATCH;
let DELETE: typeof MembersRouteModule.DELETE;

// These suites pin the handler CONTRACT (envelopes, machine codes), not
// ADR-0001 tenant scoping (covered by the org-scoped-* suites). The actor
// therefore holds the `superuser` marker so org scoping is bypassed and the
// success paths are reachable. "Lacks permission" 403 tests stay valid:
// `superuser` is never the specific permission a handler gates on.
const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [...perms, "superuser"],
});

// A non-superadmin ORG ADMIN: holds `perms` in an org but NOT the global
// `superuser` marker. "Lacks permission" (403) tests use this — a superuser
// now passes every admin check by design (getUserAccessContext + the gate
// short-circuit), so only a non-superuser can be denied a specific permission.
const ORG_ADMIN = (perms: string[]) => ({
  ...OK_ACCESS(perms),
  organizationId: "o-1",
  permissions: perms,
});

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    itemsExecute,
    selectFirst,
    insertExecute,
  ])
    m.mockReset();
  superuserGrants.rows = [];
  superuserGrants.holdsGrant = undefined;
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({
    id: ORG_ID,
    slug: "test-org",
    name: "Test Org",
    status: "active",
    is_default: false,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    total: "0",
  });
  ({ GET, POST, PATCH, DELETE } =
    await import("@/app/api/administrator/organizations/[id]/members/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations/:id/members", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.orgs.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["shell.view"]));
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "m-1",
        organization_id: ORG_ID,
        app_user_id: "u-2",
        status: "active",
        source_provider: null,
        provider_organization_key: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        user_display_name: "John Doe",
        user_primary_email: "john@example.com",
      },
    ]);
    const res = await GET(listReq(), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
  });
});

describe("POST /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await POST(jsonReq({ appUserIds: ["u-2"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid body (empty array)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await POST(jsonReq({ appUserIds: [] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when org not found", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValue(null);
    const res = await POST(jsonReq({ appUserIds: ["u-2"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await PATCH(jsonReq({ membershipIds: ["m-1"], status: "suspended" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/administrator/organizations/:id/members", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await DELETE(jsonReq({ membershipIds: ["m-1"] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid body (empty array)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await DELETE(jsonReq({ membershipIds: [] }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });

  /** 501 ids — one past the product-wide batch ceiling. */
  const overCapIds = () => Array.from({ length: 501 }, () => MEMBERSHIP_ID);

  /**
   * The REVOKE-1 rank guard costs a `getUserAccessContext` per DISTINCT member
   * and runs them one at a time (it must: it stops at the first refusal so a
   * mixed batch writes ONE denial audit row). With no ceiling on the array a
   * single rate-limited request could become thousands of sequential
   * round-trips holding a pool connection, so both schemas cap at the
   * product-wide `MAX_BULK_IDS`.
   */
  it("DELETE rejects a batch above MAX_BULK_IDS with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await DELETE(jsonReq({ membershipIds: overCapIds() }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects a batch above MAX_BULK_IDS with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await PATCH(jsonReq({ membershipIds: overCapIds(), status: "blocked" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH still accepts a batch AT the cap (the ceiling is not off by one)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    itemsExecute.mockResolvedValue([]); // no rows resolve → 404, i.e. PAST validation
    const atCap = Array.from({ length: 500 }, () => MEMBERSHIP_ID);
    const res = await PATCH(jsonReq({ membershipIds: atCap, status: "blocked" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).not.toBe(400);
  });
});

/**
 * REVOKE-1 / REVOKE-2 on the ORG-CENTRIC member routes.
 *
 * This route never calls `resolveTargetUser`, which is exactly why the review
 * #7 rank guard and the last-superadmin invariant were both missing here: an
 * org admin holding only `admin.orgs.update` could block, suspend or delete a
 * SUPERADMIN co-member's membership — the same lockout the user-centric twin
 * refuses. The real `refuseOutrankingTarget` runs in this suite (nothing mocks
 * `user-target.server` here).
 */
const MEMBERSHIP_ID = "b2c3d4e5-f6a7-4890-bcde-f12345678901";
/** One membership row as the route's `loadScopedMembers` join returns it. */
const memberRow = {
  id: MEMBERSHIP_ID,
  app_user_id: "u-member",
  better_auth_user_id: "ba-member",
  primary_email: "member@example.com",
  display_name: "Member",
  status: "active",
};
const memberBody = { membershipIds: [MEMBERSHIP_ID] };

describe("PATCH/DELETE organizations/:id/members — rank guard (REVOKE-1)", () => {
  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    itemsExecute.mockResolvedValue([memberRow]);
  });

  /**
   * Actor is a non-superadmin admin OF THIS ORG (so `canAccessOrg` passes and
   * the rank guard is what decides); the MEMBER resolves to `memberPerms`.
   */
  function ranks(perms: string[], memberPerms: string[]) {
    const inThisOrg = { ...ORG_ADMIN(perms), organizationId: ORG_ID };
    accessGetter.mockImplementation((id: string) =>
      id === "ba-1" ? inThisOrg : { ...inThisOrg, appUserId: "u-member", permissions: memberPerms },
    );
  }

  it("PATCH 403 + denied audit when the member is a SUPERADMIN and the actor is not", async () => {
    ranks(["admin.orgs.update"], ["admin.orgs.update", "superuser"]);
    const res = await PATCH(jsonReq({ ...memberBody, status: "blocked" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        outcome: "denied",
        reason: "target_outranks_actor",
      }),
    );
  });

  it("DELETE 403 when the member is a SUPERADMIN and the actor is not", async () => {
    ranks(["admin.orgs.update"], ["admin.orgs.update", "superuser"]);
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("DELETE 200 for a plain member — ordinary org administration is unchanged", async () => {
    ranks(["admin.orgs.update", "shell.view"], ["shell.view"]);
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(200);
  });

  it("F-09: DELETE 403 when the member's superuser grant is asleep in a SUSPENDED org", async () => {
    // Resolved in this org the member looks plain (the grant's org is not
    // active, so nothing expands) — but the grant is still there, and comes
    // back when that org is reactivated. Rank must not dip in between.
    ranks(["admin.orgs.update", "shell.view"], ["shell.view"]);
    superuserGrants.holdsGrant = { id: "p-superuser" };
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "target_outranks_actor" }),
    );
  });

  it("DELETE 200 for a SUPERADMIN actor against a superadmin member", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(200);
  });
});

describe("PATCH/DELETE organizations/:id/members — last-superadmin invariant (REVOKE-2)", () => {
  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    itemsExecute.mockResolvedValue([memberRow]);
    superuserGrants.rows = [
      { app_user_id: "u-member", organization_id: ORG_ID, role_id: "r-super" },
    ];
  });

  it("PATCH 409 `last_superadmin` when blocking the only remaining superadmin", async () => {
    const res = await PATCH(jsonReq({ ...memberBody, status: "blocked" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "last_superadmin",
      message: "errors.last_superadmin",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.superuser.revocation_denied",
        outcome: "denied",
        reason: "last_global_superuser",
      }),
    );
  });

  it("PATCH 200 REACTIVATING that member — a move TO active can only add a grant", async () => {
    const res = await PATCH(jsonReq({ ...memberBody, status: "active" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(200);
  });

  it("DELETE 409 when removing the only remaining superadmin's membership", async () => {
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(409);
  });

  it("DELETE 200 while another superadmin survives in a different org", async () => {
    superuserGrants.rows = [
      ...superuserGrants.rows,
      { app_user_id: "u-other", organization_id: "other-org", role_id: "r-super" },
    ];
    const res = await DELETE(jsonReq(memberBody), { params: Promise.resolve({ id: ORG_ID }) });
    expect(res.status).toBe(200);
  });
});
