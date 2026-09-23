import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OrgByIdRouteModule from "@/app/api/administrator/organizations/[id]/route";

/**
 * F-09 + REVOKE-2 — `PATCH /api/administrator/organizations/:id` may not
 * suspend the platform into a lockout.
 *
 * F-09 made organization status a membership gate: only an `active` org
 * confers anything, so a `superuser` grant held in a suspended tenant makes
 * nobody a platform superadmin. The seeded superadmin's grant lives in the
 * default org, so without a guard ONE save on the Settings tab ("Status:
 * Suspended") would leave nobody able to reactivate anything — the org
 * admins of every tenant, and the superadmin who clicked Save, all locked out.
 *
 * These run the REAL REVOKE-2 predicate (`wouldStripLastGlobalSuperuser` →
 * `activeGlobalSuperuserGrants` → `stripsLastGlobalSuperuser`) against a
 * stubbed transaction that answers the grant read, so what is pinned is the
 * whole chain: the route passes the org as a removal, the predicate counts
 * every grant held there as removed, and the refusal happens before any write.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

const state: {
  /** The org row the route's existence check reads. */
  org: { id: string; slug: string } | undefined;
  /** What `activeGlobalSuperuserGrants` reads inside the transaction. */
  grants: Array<{ app_user_id: string; organization_id: string; role_id: string }>;
  /** Which executor the grant read ran on (must be the transaction). */
  grantReadOn: "db" | "trx" | null;
  /** Every UPDATE the handler issued, in order. */
  updates: Array<{ values: Record<string, unknown>; where: unknown[][] }>;
} = { org: undefined, grants: [], grantReadOn: null, updates: [] };

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

vi.mock("@/db/database", () => {
  function select(table: string, on: "db" | "trx"): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "execute") {
            return async () => {
              if (table === "app_user_roles") {
                state.grantReadOn = on;
                return state.grants;
              }
              return [];
            };
          }
          if (prop === "executeTakeFirst") {
            return async () => (table === "app_organizations" ? state.org : undefined);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  const tableOf = (t: unknown) => String(t).split(" ")[0] ?? "";
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      const where: unknown[][] = [];
      const chain = {
        where: (...w: unknown[]) => {
          where.push(w);
          return chain;
        },
        execute: async () => {
          state.updates.push({ values, where });
          return [];
        },
      };
      return chain;
    },
  });
  const trx = { selectFrom: (t: unknown) => select(tableOf(t), "trx"), updateTable: update };
  return {
    pgPool: {},
    db: {
      selectFrom: (t: unknown) => select(tableOf(t), "db"),
      updateTable: update,
      transaction: () => ({
        execute: async (cb: (handle: unknown) => Promise<unknown>) => cb(trx),
      }),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OTHER_ORG_ID = "b2c3d4e5-f6a7-4901-8cde-f12345678901";

/** A superadmin at a browser — the only caller the org PATCH admits. */
const SUPERADMIN = {
  appUserId: "u-super",
  primaryEmail: "superuser@example.test",
  status: "active",
  organizationId: ORG_ID,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view", "superuser", "admin.orgs.update"],
  orgBound: false,
};

function patchReq(body: unknown): NextRequest {
  return {
    nextUrl: new URL(`http://test.local/api/administrator/organizations/${ORG_ID}`),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = () => ({ params: Promise.resolve({ id: ORG_ID }) });

let PATCH: typeof OrgByIdRouteModule.PATCH;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-super" } });
  accessGetter.mockResolvedValue(SUPERADMIN);
  state.org = { id: ORG_ID, slug: "default" };
  // The seeded shape: the platform's ONLY superuser grant lives in this org.
  state.grants = [{ app_user_id: "u-super", organization_id: ORG_ID, role_id: "r-superuser" }];
  state.grantReadOn = null;
  state.updates = [];
  ({ PATCH } = await import("@/app/api/administrator/organizations/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("PATCH /organizations/:id — status away from active vs the last superuser grant (F-09, REVOKE-2)", () => {
  it.each(["suspended", "archived", "pending"])(
    "409 last_superadmin when setting %s would suspend the platform's last grant — and nothing is written",
    async (status) => {
      const res = await PATCH(patchReq({ status }), ctx());

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "last_superadmin",
        message: "errors.last_superadmin",
      });
      // The check ran INSIDE the writing transaction (its row locks are what
      // make it race-safe), and the refusal came before any UPDATE.
      expect(state.grantReadOn).toBe("trx");
      expect(state.updates).toEqual([]);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "admin.superuser.revocation_denied",
          outcome: "denied",
          reason: "last_global_superuser",
          organizationId: ORG_ID,
          metadata: expect.objectContaining({
            action: "organization_status_update",
            organizationId: ORG_ID,
            status,
          }),
        }),
      );
      expect(auditMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "admin.organization.updated" }),
      );
    },
  );

  it("suspends normally when a superuser grant survives in ANOTHER active org", async () => {
    state.grants.push({
      app_user_id: "u-other-super",
      organization_id: OTHER_ORG_ID,
      role_id: "r-superuser-2",
    });

    const res = await PATCH(patchReq({ status: "suspended" }), ctx());

    expect(res.status).toBe(200);
    expect(state.grantReadOn).toBe("trx");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.values).toMatchObject({ status: "suspended" });
    expect(state.updates[0]!.where).toEqual([["id", "=", ORG_ID]]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.organization.updated", outcome: "success" }),
    );
  });

  it("suspends normally an org that holds NO superuser grant", async () => {
    state.grants = [
      { app_user_id: "u-super", organization_id: OTHER_ORG_ID, role_id: "r-superuser" },
    ];

    const res = await PATCH(patchReq({ status: "suspended" }), ctx());

    expect(res.status).toBe(200);
    expect(state.updates[0]!.values).toMatchObject({ status: "suspended" });
  });

  it("reactivating (status → active) is never gated — it can only ADD a grant back", async () => {
    const res = await PATCH(patchReq({ status: "active" }), ctx());

    expect(res.status).toBe(200);
    expect(state.grantReadOn).toBeNull();
    expect(state.updates[0]!.values).toMatchObject({ status: "active" });
  });

  it("an edit that leaves status alone (rename) is never gated", async () => {
    const res = await PATCH(patchReq({ name: "Renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(state.grantReadOn).toBeNull();
    expect(state.updates[0]!.values).toMatchObject({ name: "Renamed" });
    expect(state.updates[0]!.values).not.toHaveProperty("status");
  });

  it("setting the default flag still clears the previous default in the SAME transaction", async () => {
    const res = await PATCH(patchReq({ isDefault: true }), ctx());

    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]).toEqual({
      values: { is_default: false },
      where: [["is_default", "=", true]],
    });
    expect(state.updates[1]!.values).toMatchObject({ is_default: true });
  });

  it("an ORG-BOUND credential never reaches the check (the PATCH is superadmin-at-a-browser only)", async () => {
    accessGetter.mockResolvedValue({ ...SUPERADMIN, orgBound: true });
    // `resolveCaller` would mark a bearer caller; a cookie session carrying an
    // org-bound context is the closest this harness gets, and the route's
    // `hasCrossOrgReach` gate is what refuses it.
    const res = await PATCH(patchReq({ status: "suspended" }), ctx());
    expect(res.status).toBe(403);
    expect(state.grantReadOn).toBeNull();
    expect(state.updates).toEqual([]);
  });
});
