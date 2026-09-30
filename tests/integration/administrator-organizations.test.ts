import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OrgsRouteModule from "@/app/api/administrator/organizations/route";
import type * as OrgByIdRouteModule from "@/app/api/administrator/organizations/[id]/route";
import { organizationEtag } from "@/lib/admin/record-etag.server";
import { expectResponseMatchesSpec } from "../helpers/openapi-response";
import { pgForeignKeyViolation, pgUniqueViolation } from "../helpers/pg-errors";

/**
 * Integration tests for the organizations endpoints (docs/admin-manager.md
 * Phase 5 test plan). The DB layer is stubbed — these tests pin the
 * handler contract: permission gates, response envelopes, and the
 * canonical `slug_taken` 409 / `organization_not_empty` 409 machine codes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const itemsExecute = vi.fn();
const selectFirst = vi.fn();
const insertExecute = vi.fn();
const updateExecute = vi.fn();
const countExecute = vi.fn();
/** F-98: the revoked-credential DELETEs on the transaction, called with their table. */
const purgeExecute = vi.fn();

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
// F-40: the DELETE re-checks the default flag inside its transaction through
// this helper, which takes an advisory lock the stubbed transaction cannot
// run; its real SQL and the race it closes are pinned by
// tests/db/default-organization.db.test.ts.
const isDefaultLockedMock = vi.fn();
vi.mock("@/lib/default-organization.server", () => ({
  isDefaultOrganizationLocked: (...args: unknown[]) => isDefaultLockedMock(...args),
  lockDefaultOrganizationFlag: async () => undefined,
  moveDefaultOrganizationFlag: async () => [],
  clearDefaultOrganizationFlag: async () => "unchanged",
}));

vi.mock("@/db/database", () => {
  function makeChain() {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "execute") return itemsExecute;
          if (prop === "executeTakeFirst") return selectFirst;
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
                /* ignore — eb stub is best-effort */
              }
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  // DB-3: the tenant DELETE runs its success audit and the delete statement in
  // ONE transaction, so the stub must hand the callback something that answers
  // `deleteFrom(...).where(...).execute()`. Deliberately narrow — the audit
  // call inside the transaction goes through the mocked `@/lib/audit.server`,
  // never through this handle.
  //
  // F-98: the DELETE also clears the org's revoked credentials on the handle
  // first. Those statements answer `purgeExecute(table)`, so `itemsExecute`
  // stays the org DELETE alone and a rejection staged on it models that
  // statement's FK violation, not the purge's.
  const trx = {
    // The PATCH's update runs on the handle too (F-40), answering updateExecute,
    // and returns the columns the org's ETag hashes (F-39).
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: () => updateExecute(),
          returning: () => ({ executeTakeFirst: () => updateExecute() }),
        }),
      }),
    }),
    deleteFrom: (table: string) =>
      table === "app_organizations"
        ? {
            where: () => ({
              execute: itemsExecute,
              where: () => ({ execute: itemsExecute }),
            }),
          }
        : { where: () => ({ where: () => ({ execute: () => purgeExecute(table) }) }) },
  };
  return {
    db: {
      transaction: () => ({
        execute: (cb: (handle: unknown) => Promise<void>) => cb(trx),
      }),
      selectFrom: () => makeChain(),
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
      updateTable: () => ({
        set: () => ({
          where: () => ({
            returning: () => ({ executeTakeFirst: () => updateExecute() }),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: () => ({
          execute: itemsExecute,
          where: () => ({ execute: itemsExecute }),
        }),
      }),
    },
  };
});

function listReq(query: string = ""): NextRequest {
  const url = new URL(`http://test.local/api/administrator/organizations${query}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  return {
    nextUrl: new URL("http://test.local/api/administrator/organizations"),
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

function idReq(method: string, id: string, body?: unknown): NextRequest {
  const headers = new Headers(body ? { "content-type": "application/json" } : {});
  return {
    nextUrl: new URL(`http://test.local/api/administrator/organizations/${id}`),
    headers,
    json: body ? async () => body : undefined,
  } as unknown as NextRequest;
}

let GET: typeof OrgsRouteModule.GET;
let POST: typeof OrgsRouteModule.POST;
let GET_BY_ID: typeof OrgByIdRouteModule.GET;
let PATCH: typeof OrgByIdRouteModule.PATCH;
let DELETE: typeof OrgByIdRouteModule.DELETE;

// Predate the three-tier model; assert GLOBAL admin behavior == SUPERADMIN
// now. Org-entity create/update/delete is superadmin-only (ADR-0001), so
// the marker is required for the 201/200 paths. Denial tests still fail on
// the missing specific permission.
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
    updateExecute,
    countExecute,
    isDefaultLockedMock,
    purgeExecute,
  ])
    m.mockReset();
  isDefaultLockedMock.mockResolvedValue(false);
  purgeExecute.mockResolvedValue([]);
  itemsExecute.mockResolvedValue([]);
  selectFirst.mockResolvedValue({ total: "0" });
  ({ GET, POST } = await import("@/app/api/administrator/organizations/route"));
  ({
    GET: GET_BY_ID,
    PATCH,
    DELETE,
  } = await import("@/app/api/administrator/organizations/[id]/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await GET(listReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.orgs.read", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["shell.view"]));
    const res = await GET(listReq());
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("returns the standard list envelope on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    itemsExecute.mockResolvedValue([
      {
        id: "o-1",
        slug: "acme",
        name: "ACME Corp",
        status: "active",
        is_default: false,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        member_count: "5",
        provider_count: "2",
      },
    ]);
    selectFirst.mockResolvedValue({ total: "1" });
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; sort: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sort).toEqual([{ field: "slug", direction: "asc" }]);
  });
});

describe("POST /api/administrator/organizations", () => {
  it("returns 403 when caller lacks admin.orgs.create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await POST(jsonReq({ slug: "acme", name: "ACME" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid slug format", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    const res = await POST(jsonReq({ slug: "INVALID_SLUG", name: "Test" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 slug_taken when slug already exists, whatever the server's message language (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    // The route uses try/catch on executeTakeFirstOrThrow which will throw on conflict
    insertExecute.mockRejectedValue(pgUniqueViolation("app_organizations_slug_key"));
    const res = await POST(jsonReq({ slug: "taken", name: "Taken Org" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "slug_taken" });
  });

  it("returns 201 with the created org, in the shape the admin spec declares (F-74)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.create"]));
    const id = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
    insertExecute.mockResolvedValue({ id, slug: "new-org" });
    const res = await POST(jsonReq({ slug: "new-org", name: "New Org" }));
    expect(res.status).toBe(201);
    // `KeyCreated` requires `key`; the answer lacked it, so the generated
    // SDK's `createOrganization(...).key` was undefined. `slug` stays.
    const body = await expectResponseMatchesSpec(res, "admin", "post", "/organizations");
    expect(body).toEqual({ ok: true, id, key: "new-org", slug: "new-org" });
  });
});

describe("GET /api/administrator/organizations/:id", () => {
  it("returns 400 for invalid UUID", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await GET_BY_ID(idReq("GET", "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_id" });
  });

  it("F-39: answers the organization's ETag, the tag a PATCH may send back as If-Match", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const row = {
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      slug: "acme",
      name: "Acme",
      status: "active",
      is_default: false,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-02T00:00:00Z"),
    };
    selectFirst.mockResolvedValue(row);
    const res = await GET_BY_ID(idReq("GET", row.id), {
      params: Promise.resolve({ id: row.id }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(organizationEtag(row));
    await expectResponseMatchesSpec(res, "admin", "get", "/organizations/{id}");
  });

  it("returns 404 when org not found", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    selectFirst.mockResolvedValue(null);
    const res = await GET_BY_ID(idReq("GET", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/administrator/organizations/:id", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await PATCH(
      idReq("PATCH", "a1b2c3d4-e5f6-7890-abcd-ef1234567890", { name: "New Name" }),
      { params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 slug_taken when the new slug is taken, whatever the server's message language (F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme" });
    updateExecute.mockRejectedValue(pgUniqueViolation("app_organizations_slug_key"));
    const res = await PATCH(
      idReq("PATCH", "a1b2c3d4-e5f6-7890-abcd-ef1234567890", { slug: "taken" }),
      { params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug_taken" });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/administrator/organizations/:id", () => {
  it("returns 403 when caller lacks admin.orgs.delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns ok and audits success BEFORE the delete, on the transaction handle (DB-1, DB-3)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    // existing lookup + assertOrgNotDefault + assertOrgEmpty all read this row.
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    itemsExecute.mockResolvedValue([]); // the delete statement succeeds
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.organization.deleted",
        outcome: "success",
        organizationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        // The org id and slug ride in metadata too: the DB-1 SET NULL cascade
        // nulls the column moments later, so metadata is what still answers
        // WHICH tenant was removed.
        metadata: { organizationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", slug: "acme" },
        // DB-3: written through the transaction handle, not the pool.
        executor: expect.objectContaining({ deleteFrom: expect.any(Function) }),
      }),
    );
    // DB-3: and written BEFORE the delete statement. Reversed (the original
    // bug) the INSERT names an organization_id whose row is already gone and
    // the real FK rejects it — which no mocked `auditEvent` can show, hence
    // tests/db/organizations-delete-route.db.test.ts as well.
    const [auditOrder] = auditMock.mock.invocationCallOrder;
    const [deleteOrder] = itemsExecute.mock.invocationCallOrder;
    expect(auditOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(auditOrder as number).toBeLessThan(deleteOrder as number);
    // F-40: the default flag is re-checked on the transaction before either.
    const [recheckOrder] = isDefaultLockedMock.mock.invocationCallOrder;
    expect(isDefaultLockedMock).toHaveBeenCalledWith(
      expect.objectContaining({ deleteFrom: expect.any(Function) }),
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(recheckOrder as number).toBeLessThan(auditOrder as number);
  });

  it("F-98: clears the org's revoked credentials on the transaction, after the audit and before the delete", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    itemsExecute.mockResolvedValue([]);
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(200);
    // Both credential tables, inside the transaction, so a delete that is
    // refused rolls them back. Which rows (revoked only) is pinned against
    // real Postgres in tests/db/organizations-delete-route.db.test.ts.
    expect(purgeExecute.mock.calls.map(([table]) => table)).toEqual([
      "app_api_keys",
      "app_oauth_clients",
    ]);
    const [auditOrder] = auditMock.mock.invocationCallOrder;
    const [deleteOrder] = itemsExecute.mock.invocationCallOrder;
    for (const purgeOrder of purgeExecute.mock.invocationCallOrder) {
      expect(purgeOrder).toBeGreaterThan(auditOrder as number);
      expect(purgeOrder).toBeLessThan(deleteOrder as number);
    }
  });

  it("F-40: an org made the default after the pool guards ran is refused INSIDE the transaction — 409, nothing deleted", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    // The pool-side guards still see an empty, non-default org...
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    // ...but a "Set as default" on it committed before the re-check under the
    // default-flag lock. Deleting it would have left no default at all.
    isDefaultLockedMock.mockResolvedValue(true);
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "organization_is_default" });
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(purgeExecute).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.organization.delete_blocked",
        outcome: "denied",
        metadata: expect.objectContaining({ reason: "organization_is_default" }),
      }),
    );
  });

  it("maps a FK violation to 409 organization_in_use instead of a raw 500 (DB-1)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    // The org still owns roles/apps/credentials → Postgres raises a FK violation.
    // F-132: recognised by its SQLSTATE, so a non-English message maps too.
    itemsExecute.mockRejectedValue(pgForeignKeyViolation("app_roles_organization_id_fkey"));
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "organization_in_use" });
    // F-98: the denial names the foreign key that refused the delete.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.organization.delete_blocked",
        outcome: "denied",
        metadata: expect.objectContaining({
          reason: "organization_in_use",
          blockedBy: "app_roles_organization_id_fkey",
        }),
      }),
    );
    // The success audit written inside the transaction is discarded by the
    // ROLLBACK, which a stubbed `db.transaction` cannot model — that half of
    // DB-3 is asserted against real Postgres in
    // tests/db/organizations-delete-route.db.test.ts.
  });

  it("answers 404, not 500, when the tenant vanishes before the transaction (DB-5)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    // The existence read still sees the org...
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    // ...but a second superadmin commits its own delete before this request
    // opens its transaction, so the success audit — the FIRST statement in it
    // (DB-3) — is what finds the parent gone. Shaped as node-pg raises it for
    // that FK: SQLSTATE 23503 and the constraint name, which F-132 reads
    // instead of the (translatable) message.
    auditMock.mockRejectedValueOnce(pgForeignKeyViolation("app_audit_events_organization_id_fkey"));
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "organization_not_found" });
    // The delete statement is never reached, and nothing is audited: the 409
    // branch must not claim `organization_in_use` for a tenant that is simply
    // gone, and the rolled-back success row is already discarded.
    expect(itemsExecute).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("does not take an FK violation of the audit row's actor for a vanished tenant (DB-5, F-132)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.delete"]));
    selectFirst.mockResolvedValue({ id: "o-1", slug: "acme", is_default: false, count: "0" });
    auditMock.mockRejectedValueOnce(pgForeignKeyViolation("app_audit_events_app_user_id_fkey"));
    const res = await DELETE(idReq("DELETE", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
      params: Promise.resolve({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
    expect(itemsExecute).not.toHaveBeenCalled();
  });
});
