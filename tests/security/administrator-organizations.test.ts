import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OrgsRouteModule from "@/app/api/administrator/organizations/route";
import type * as OrgByIdRouteModule from "@/app/api/administrator/organizations/[id]/route";
import type * as MembersRouteModule from "@/app/api/administrator/organizations/[id]/members/route";
import type * as ProvidersRouteModule from "@/app/api/administrator/organizations/[id]/provider-bindings/route";

/**
 * Security tests for the organization endpoints (docs/admin-manager.md
 * §4 + §12). Pin the authorization boundary: every mutating verb must be
 * gated by the right permission AND every probing call must be audited
 * with `outcome=denied` so ops can detect privilege escalation attempts.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();

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
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return selectFirst;
          if (prop === "executeTakeFirstOrThrow") return selectFirst;
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
  return {
    db: {
      selectFrom: () => makeChain(),
      insertInto: () => ({
        values: () => ({
          returning: () => ({ executeTakeFirstOrThrow: selectFirst }),
          onConflict: () => ({
            doNothing: () => ({
              returning: () => ({ executeTakeFirst: selectFirst }),
            }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: itemsExecute,
            returning: () => ({ executeTakeFirst: selectFirst }),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({
            execute: itemsExecute,
            where: () => ({ execute: itemsExecute }),
          }),
        }),
      }),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function orgsGet(): NextRequest {
  return {
    nextUrl: new URL("http://test.local/api/administrator/organizations"),
    headers: new Headers(),
  } as unknown as NextRequest;
}

function jsonReq(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

function emptyReq(url: string): NextRequest {
  return {
    nextUrl: new URL(url),
    headers: new Headers(),
  } as unknown as NextRequest;
}

const ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "x@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: perms,
});

let OrgsGET: typeof OrgsRouteModule.GET;
let OrgsPOST: typeof OrgsRouteModule.POST;
let OrgPATCH: typeof OrgByIdRouteModule.PATCH;
let OrgDELETE: typeof OrgByIdRouteModule.DELETE;
let MembersPOST: typeof MembersRouteModule.POST;
let ProvidersPOST: typeof ProvidersRouteModule.POST;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock, itemsExecute, selectFirst])
    m.mockReset();
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET: OrgsGET, POST: OrgsPOST } = await import("@/app/api/administrator/organizations/route"));
  ({ PATCH: OrgPATCH, DELETE: OrgDELETE } =
    await import("@/app/api/administrator/organizations/[id]/route"));
  ({ POST: MembersPOST } =
    await import("@/app/api/administrator/organizations/[id]/members/route"));
  ({ POST: ProvidersPOST } =
    await import("@/app/api/administrator/organizations/[id]/provider-bindings/route"));
});
afterEach(() => vi.resetModules());

describe("security: organizations list", () => {
  it("rejects unauthenticated callers without touching the database", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await OrgsGET(orgsGet());
    expect(res.status).toBe(401);
    expect(itemsExecute).not.toHaveBeenCalled();
  });

  it("rejects callers missing admin.orgs.read without touching the database", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["shell.view"]));
    const res = await OrgsGET(orgsGet());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects suspended admins (status check beats permission check)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      ...ACCESS(["admin.orgs.read"]),
      status: "suspended",
      membershipStatus: "suspended",
    });
    const res = await OrgsGET(orgsGet());
    expect(res.status).toBe(403);
    expect(itemsExecute).not.toHaveBeenCalled();
  });
});

describe("security: organizations create requires admin.orgs.create (not just read)", () => {
  it("403 when caller has read but not create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.orgs.read"]));
    const res = await OrgsPOST(
      jsonReq("http://test.local/api/administrator/organizations", {
        slug: "test-org",
        name: "Test Org",
      }),
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});

describe("security: organization update requires admin.orgs.update", () => {
  it("403 when caller has read but not update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.orgs.read"]));
    const res = await OrgPATCH(
      jsonReq(`http://test.local/api/administrator/organizations/${ORG_ID}`, {
        name: "Updated Name",
      }),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});

describe("security: organization delete requires admin.orgs.delete", () => {
  it("403 when caller has update but not delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.orgs.read", "admin.orgs.update"]));
    const res = await OrgDELETE(
      emptyReq(`http://test.local/api/administrator/organizations/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});

describe("security: member management requires admin.orgs.update", () => {
  it("403 when caller has read but not update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.orgs.read"]));
    const res = await MembersPOST(
      jsonReq(`http://test.local/api/administrator/organizations/${ORG_ID}/members`, {
        appUserIds: ["u-2"],
      }),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});

describe("security: provider binding requires admin.orgs.update", () => {
  it("403 when caller has read but not update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACCESS(["admin.orgs.read"]));
    const res = await ProvidersPOST(
      jsonReq(`http://test.local/api/administrator/organizations/${ORG_ID}/provider-bindings`, {
        provider: "github",
        providerOrganizationKey: "acme-org",
      }),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });
});
