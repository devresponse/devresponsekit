import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as OrgAuthSettingsRoute from "@/app/api/administrator/organizations/[id]/auth-settings/route";
import type * as DefaultsRoute from "@/app/api/administrator/auth-settings/defaults/route";

/**
 * Integration tests for the signup-policy endpoints (0007):
 *
 *   /api/administrator/organizations/:id/auth-settings   (GET/PATCH/DELETE)
 *   /api/administrator/auth-settings/defaults            (GET/PATCH)
 *
 * The DB layer is stubbed — these pin the handler contract: permission
 * gates, the superadmin-only rule on the platform defaults, body
 * validation, response envelopes, machine codes, and audit emission.
 * ADR-0001 foreign-org scoping is covered in org-scoped-admin-routes.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const selectFirst = vi.fn();
const executeMock = vi.fn();
const updateExecute = vi.fn();
const insertExecute = vi.fn();
const deleteFirst = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("@/db/database", () => {
  function makeChain(kind: "select" | "update" | "insert" | "delete"): unknown {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === "executeTakeFirst") {
          if (kind === "delete") return deleteFirst;
          return selectFirst;
        }
        if (prop === "executeTakeFirstOrThrow") return selectFirst;
        if (prop === "execute") {
          if (kind === "update") return updateExecute;
          if (kind === "insert") return insertExecute;
          return executeMock;
        }
        return (...args: unknown[]) => {
          const cb = args[0];
          if (typeof cb === "function") {
            try {
              (cb as (eb: unknown) => unknown)(
                new Proxy(() => ({}), { get: () => () => ({}), apply: () => ({}) }),
              );
            } catch {
              /* ignore */
            }
          }
          return makeChain(kind);
        };
      },
    };
    return new Proxy({}, handler);
  }
  return {
    db: {
      selectFrom: () => makeChain("select"),
      insertInto: () => makeChain("insert"),
      updateTable: () => makeChain("update"),
      deleteFrom: () => makeChain("delete"),
    },
  };
});

const ORG_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORG_ENDPOINT = `http://test.local/api/administrator/organizations/${ORG_ID}/auth-settings`;
const DEFAULTS_ENDPOINT = "http://test.local/api/administrator/auth-settings/defaults";

/** Superset row serving BOTH the org lookup and the settings lookup. */
const DB_ROW = {
  id: ORG_ID,
  slug: "test-org",
  organization_id: ORG_ID,
  require_email_verification: true,
  signup_approval_mode: "admin_approval",
  allowed_auth_methods: null,
  auto_approve_email_domains: null,
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

const VALID_BODY = {
  requireEmailVerification: false,
  signupApprovalMode: "auto_active",
  allowedAuthMethods: ["email", "google"],
  autoApproveEmailDomains: ["acme.com"],
};

function getReq(url: string): NextRequest {
  return { nextUrl: new URL(url), headers: new Headers() } as unknown as NextRequest;
}
function jsonReq(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const OK_ACCESS = (perms: string[]) => ({
  appUserId: "u-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [...perms, "superuser"],
});
const ORG_ADMIN = (perms: string[]) => ({
  ...OK_ACCESS(perms),
  organizationId: ORG_ID,
  permissions: perms,
});

let orgGET: typeof OrgAuthSettingsRoute.GET;
let orgPATCH: typeof OrgAuthSettingsRoute.PATCH;
let orgDELETE: typeof OrgAuthSettingsRoute.DELETE;
let defGET: typeof DefaultsRoute.GET;
let defPATCH: typeof DefaultsRoute.PATCH;

const ctx = () => ({ params: Promise.resolve({ id: ORG_ID }) });

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    selectFirst,
    executeMock,
    updateExecute,
    insertExecute,
    deleteFirst,
  ])
    m.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
  selectFirst.mockResolvedValue(DB_ROW);
  executeMock.mockResolvedValue([DB_ROW]);
  updateExecute.mockResolvedValue(undefined);
  insertExecute.mockResolvedValue(undefined);
  deleteFirst.mockResolvedValue({ numDeletedRows: 1n });
  ({
    GET: orgGET,
    PATCH: orgPATCH,
    DELETE: orgDELETE,
  } = await import("@/app/api/administrator/organizations/[id]/auth-settings/route"));
  ({ GET: defGET, PATCH: defPATCH } =
    await import("@/app/api/administrator/auth-settings/defaults/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/organizations/:id/auth-settings", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await orgGET(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller lacks admin.orgs.read", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["shell.view"]));
    const res = await orgGET(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the org does not exist", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    selectFirst.mockResolvedValue(undefined);
    const res = await orgGET(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(404);
  });

  it("returns the settings + effective envelope on success", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    const res = await orgGET(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      settings: { requireEmailVerification: boolean } | null;
      effective: { source: string };
    };
    expect(body.ok).toBe(true);
    expect(body.settings?.requireEmailVerification).toBe(true);
    expect(body.effective.source).toBe("organization");
  });
});

describe("PATCH /api/administrator/organizations/:id/auth-settings", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await orgPATCH(jsonReq(ORG_ENDPOINT, VALID_BODY), ctx());
    expect(res.status).toBe(403);
  });

  it("rejects an unknown approval mode with 400 invalid_body", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await orgPATCH(
      jsonReq(ORG_ENDPOINT, { ...VALID_BODY, signupApprovalMode: "nonsense" }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
  });

  it("rejects an unknown auth method and a malformed domain", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const badMethod = await orgPATCH(
      jsonReq(ORG_ENDPOINT, { ...VALID_BODY, allowedAuthMethods: ["carrier-pigeon"] }),
      ctx(),
    );
    expect(badMethod.status).toBe(400);
    const badDomain = await orgPATCH(
      jsonReq(ORG_ENDPOINT, { ...VALID_BODY, autoApproveEmailDomains: ["not a domain"] }),
      ctx(),
    );
    expect(badDomain.status).toBe(400);
  });

  it("accepts the invite_only approval mode (0008)", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await orgPATCH(
      jsonReq(ORG_ENDPOINT, { ...VALID_BODY, signupApprovalMode: "invite_only" }),
      ctx(),
    );
    expect(res.status).toBe(200);
  });

  it("upserts the policy and audits admin.organization.auth_policy_updated", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await orgPATCH(jsonReq(ORG_ENDPOINT, VALID_BODY), ctx());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(updateExecute).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.organization.auth_policy_updated",
        outcome: "success",
        organizationId: ORG_ID,
      }),
    );
  });
});

describe("DELETE /api/administrator/organizations/:id/auth-settings", () => {
  it("returns 403 when caller lacks admin.orgs.update", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await orgDELETE(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(403);
  });

  it("returns 404 auth_settings_not_found when there is no override", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    deleteFirst.mockResolvedValue({ numDeletedRows: 0n });
    const res = await orgDELETE(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("auth_settings_not_found");
  });

  it("removes the override and audits admin.organization.auth_policy_reset", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const res = await orgDELETE(getReq(ORG_ENDPOINT), ctx());
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.organization.auth_policy_reset" }),
    );
  });
});

describe("/api/administrator/auth-settings/defaults (superadmin only)", () => {
  it("GET returns 403 for an org admin even WITH admin.orgs.read", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.read"]));
    const res = await defGET(getReq(DEFAULTS_ENDPOINT));
    expect(res.status).toBe(403);
  });

  it("PATCH returns 403 for an org admin even WITH admin.orgs.update", async () => {
    accessGetter.mockResolvedValue(ORG_ADMIN(["admin.orgs.update"]));
    const res = await defPATCH(jsonReq(DEFAULTS_ENDPOINT, VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("GET returns the platform default row for a superadmin", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    selectFirst.mockResolvedValue({ ...DB_ROW, organization_id: null });
    const res = await defGET(getReq(DEFAULTS_ENDPOINT));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; effective: { source: string } };
    expect(body.ok).toBe(true);
    expect(body.effective.source).toBe("platform_default");
  });

  it("GET surfaces the fail-closed policy when the seeded row is missing", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.read"]));
    selectFirst.mockResolvedValue(undefined);
    const res = await defGET(getReq(DEFAULTS_ENDPOINT));
    const body = (await res.json()) as {
      settings: unknown;
      effective: { source: string; requireEmailVerification: boolean };
    };
    expect(body.settings).toBeNull();
    expect(body.effective.source).toBe("fail_closed");
    expect(body.effective.requireEmailVerification).toBe(true);
  });

  it("PATCH validates the body and audits admin.platform.auth_policy_updated", async () => {
    accessGetter.mockResolvedValue(OK_ACCESS(["admin.orgs.update"]));
    const bad = await defPATCH(jsonReq(DEFAULTS_ENDPOINT, { requireEmailVerification: true }));
    expect(bad.status).toBe(400);

    selectFirst.mockResolvedValue({ ...DB_ROW, organization_id: null });
    const res = await defPATCH(jsonReq(DEFAULTS_ENDPOINT, VALID_BODY));
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.platform.auth_policy_updated",
        organizationId: null,
      }),
    );
  });
});
