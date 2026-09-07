import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as EnterpriseAppRoute from "@/app/api/administrator/enterprise-apps/[id]/route";
import type * as RoleByIdRoute from "@/app/api/administrator/roles/[id]/route";
import type * as RolesListRoute from "@/app/api/administrator/roles/route";
import type * as MembersRoute from "@/app/api/administrator/organizations/[id]/members/route";
import type * as BindingsRoute from "@/app/api/administrator/organizations/[id]/provider-bindings/route";
import type * as AuthSettingsRoute from "@/app/api/administrator/organizations/[id]/auth-settings/route";
import type * as AuthDefaultsRoute from "@/app/api/administrator/auth-settings/defaults/route";
import type * as OrgInvitationsRoute from "@/app/api/administrator/organizations/[id]/invitations/route";
import type * as PermissionsRoute from "@/app/api/administrator/permissions/route";
import type * as ExportRoute from "@/app/api/administrator/export/[resource]/route";
import type * as OutboxRoute from "@/app/api/administrator/email/outbox/route";
import type * as OutboxDetailRoute from "@/app/api/administrator/email/outbox/[id]/route";

/**
 * ADR-0001 cross-tenant isolation suite (docs/adr/0001-three-tier-access-control.md).
 *
 * Each test proves that an ORG ADMIN confined to org-a CANNOT reach a
 * resource owned by org-b (or a platform-global resource), and that a
 * SUPERADMIN can. The handlers must return 404 (not 403) on a foreign
 * `[id]` so a resource's existence in another tenant is never confirmed,
 * and an org admin with no resolvable org must get an EMPTY result — never
 * "all". This is the regression guard for the P0 gaps the enterprise
 * re-review flagged: every fixed surface gets a direct deny proof here.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbFirst = vi.fn();
let dbExecuteResult: unknown[] = [];
/**
 * Every `.where(...)` argument list the route built, in order. The proxy chain
 * below is shape-only (it does not execute SQL), so this is how a test proves
 * a route actually APPLIED its tenant predicate rather than merely returning
 * 200 — see the outbox suite (review #220).
 */
let dbWhereCalls: unknown[][] = [];

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...args: unknown[]) => auditMock(...args) }));

function makeChain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "executeTakeFirst") return dbFirst;
      if (prop === "executeTakeFirstOrThrow") return dbFirst;
      if (prop === "execute") return () => Promise.resolve(dbExecuteResult);
      if (prop === "where") {
        return (...args: unknown[]) => {
          dbWhereCalls.push(args);
          return makeChain();
        };
      }
      return (..._args: unknown[]) => makeChain();
    },
  };
  return new Proxy({}, handler);
}

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => makeChain(),
    insertInto: () => makeChain(),
    updateTable: () => makeChain(),
    deleteFrom: () => makeChain(),
  },
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APP_ID = "analytics";

/** ORG ADMIN — confined to `org`, holds `perms`, NOT a superadmin. */
function orgAdmin(org: string, perms: string[]): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "admin-1",
    primaryEmail: "admin@org-a.com",
    status: "active",
    organizationId: org,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: perms,
  };
}

/** SUPERADMIN — holds the `superuser` marker; org scoping is bypassed. */
function superadmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return { ...orgAdmin(ORG_A, perms), organizationId: null, permissions: [...perms, "superuser"] };
}

/** An admin with NO resolvable org and no superuser — a null scope. */
function nullScopeAdmin(perms: string[]): AuthStatusModule.UserAccessContext {
  return { ...orgAdmin(ORG_A, perms), organizationId: null };
}

function req(url: string, init: RequestInit = {}): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers(init.headers ?? {}),
    json: async () => (init.body ? JSON.parse(init.body as string) : {}),
    method: init.method ?? "GET",
  } as unknown as NextRequest;
}

let appGet: typeof EnterpriseAppRoute.GET;
let roleGet: typeof RoleByIdRoute.GET;
let rolesList: typeof RolesListRoute.GET;
let membersGet: typeof MembersRoute.GET;
let bindingsGet: typeof BindingsRoute.GET;
let permissionsPost: typeof PermissionsRoute.POST;
let exportGet: typeof ExportRoute.GET;
let outboxGet: typeof OutboxRoute.GET;
let outboxDetailGet: typeof OutboxDetailRoute.GET;
let authSettingsGet: typeof AuthSettingsRoute.GET;
let authDefaultsGet: typeof AuthDefaultsRoute.GET;
let authDefaultsPatch: typeof AuthDefaultsRoute.PATCH;
let orgInvitationsGet: typeof OrgInvitationsRoute.GET;

beforeEach(async () => {
  for (const m of [sessionGetter, accessGetter, auditMock, dbFirst]) m.mockReset();
  dbExecuteResult = [];
  dbWhereCalls = [];
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  ({ GET: appGet } = await import("@/app/api/administrator/enterprise-apps/[id]/route"));
  ({ GET: roleGet } = await import("@/app/api/administrator/roles/[id]/route"));
  ({ GET: rolesList } = await import("@/app/api/administrator/roles/route"));
  ({ GET: membersGet } = await import("@/app/api/administrator/organizations/[id]/members/route"));
  ({ GET: bindingsGet } =
    await import("@/app/api/administrator/organizations/[id]/provider-bindings/route"));
  ({ POST: permissionsPost } = await import("@/app/api/administrator/permissions/route"));
  ({ GET: exportGet } = await import("@/app/api/administrator/export/[resource]/route"));
  ({ GET: outboxGet } = await import("@/app/api/administrator/email/outbox/route"));
  ({ GET: outboxDetailGet } = await import("@/app/api/administrator/email/outbox/[id]/route"));
  ({ GET: authSettingsGet } =
    await import("@/app/api/administrator/organizations/[id]/auth-settings/route"));
  ({ GET: authDefaultsGet, PATCH: authDefaultsPatch } =
    await import("@/app/api/administrator/auth-settings/defaults/route"));
  ({ GET: orgInvitationsGet } =
    await import("@/app/api/administrator/organizations/[id]/invitations/route"));
});
afterEach(() => vi.resetModules());

describe("P0-6 GET /enterprise-apps/[id] — app owned by org-b", () => {
  const ctx = { params: Promise.resolve({ id: APP_ID }) };
  const url = `http://test.local/api/administrator/enterprise-apps/${APP_ID}`;
  beforeEach(() => {
    dbFirst.mockResolvedValue({
      id: APP_ID,
      label: "Analytics",
      description: null,
      origin: "https://analytics.org-b.com",
      subdomain: "analytics",
      sso_audience: "aud",
      status: "active",
      sort_order: 0,
      organization_id: ORG_B,
      organization_slug: "org-b",
      organization_name: "Org B",
      created_at: "2025-01-01T00:00:00Z",
    });
  });

  it("ORG ADMIN of org-a gets 404 (no cross-tenant read, no existence leak)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.apps.read"]));
    expect((await appGet(req(url), ctx)).status).toBe(404);
  });

  it("SUPERADMIN reaches the app in org-b", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.apps.read"]));
    expect((await appGet(req(url), ctx)).status).toBe(200);
  });
});

describe("P0-7 GET /roles/[id] — role owned by org-b", () => {
  const ctx = { params: Promise.resolve({ id: ROLE_ID }) };
  const url = `http://test.local/api/administrator/roles/${ROLE_ID}`;
  beforeEach(() => {
    dbFirst.mockResolvedValue({
      id: ROLE_ID,
      organization_id: ORG_B,
      key: "org-b.editor",
      name: "Editor",
      description: null,
      created_at: "2025-01-01T00:00:00Z",
    });
  });

  it("ORG ADMIN of org-a gets 404 for another org's role", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.roles.read"]));
    expect((await roleGet(req(url), ctx)).status).toBe(404);
  });

  it("SUPERADMIN reaches the role in org-b", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.roles.read"]));
    expect((await roleGet(req(url), ctx)).status).toBe(200);
  });
});

describe("P0-7 GET /roles (list) — null-scope admin", () => {
  it("an admin with no resolvable org gets an EMPTY list, never 'all'", async () => {
    accessGetter.mockResolvedValue(nullScopeAdmin(["admin.roles.read"]));
    // The DB would return rows, but the handler must short-circuit to empty.
    dbExecuteResult = [{ id: ROLE_ID, organization_id: ORG_B, key: "leak", name: "Leak" }];
    const res = await rolesList(req("http://test.local/api/administrator/roles"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

describe("0007 GET /organizations/[id]/auth-settings — org-b", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B }) };
  const url = `http://test.local/api/administrator/organizations/${ORG_B}/auth-settings`;
  beforeEach(() => {
    dbFirst.mockResolvedValue({
      id: ORG_B,
      slug: "org-b",
      organization_id: ORG_B,
      require_email_verification: true,
      signup_approval_mode: "admin_approval",
      allowed_auth_methods: null,
      auto_approve_email_domains: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
  });

  it("ORG ADMIN of org-a gets 404 for org-b's signup policy", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.read"]));
    expect((await authSettingsGet(req(url), ctx)).status).toBe(404);
  });

  it("SUPERADMIN reaches org-b's signup policy", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.orgs.read"]));
    expect((await authSettingsGet(req(url), ctx)).status).toBe(200);
  });
});

describe("0008 GET /organizations/[id]/invitations — org-b", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B }) };
  const url = `http://test.local/api/administrator/organizations/${ORG_B}/invitations`;
  beforeEach(() => dbFirst.mockResolvedValue({ id: ORG_B, slug: "org-b", name: "Org B" }));

  it("ORG ADMIN of org-a gets 404 for org-b's invitations", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.read"]));
    expect((await orgInvitationsGet(req(url), ctx)).status).toBe(404);
  });

  it("SUPERADMIN reaches org-b's invitations", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.orgs.read"]));
    expect((await orgInvitationsGet(req(url), ctx)).status).toBe(200);
  });
});

describe("0007 /auth-settings/defaults — platform-global resource", () => {
  const url = "http://test.local/api/administrator/auth-settings/defaults";

  it("ORG ADMIN cannot read the platform defaults (403, superadmin-only)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.read", "admin.orgs.update"]));
    expect((await authDefaultsGet(req(url))).status).toBe(403);
  });

  it("ORG ADMIN cannot write the platform defaults (403)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.update"]));
    const res = await authDefaultsPatch(
      req(url, {
        method: "PATCH",
        body: JSON.stringify({
          requireEmailVerification: false,
          signupApprovalMode: "auto_active",
          allowedAuthMethods: null,
          autoApproveEmailDomains: null,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("SUPERADMIN reads the platform defaults", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.orgs.read"]));
    dbFirst.mockResolvedValue({
      organization_id: null,
      require_email_verification: true,
      signup_approval_mode: "admin_approval",
      allowed_auth_methods: null,
      auto_approve_email_domains: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect((await authDefaultsGet(req(url))).status).toBe(200);
  });
});

describe("P0-3 GET /organizations/[id]/members — org-b", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B }) };
  const url = `http://test.local/api/administrator/organizations/${ORG_B}/members`;
  beforeEach(() => dbFirst.mockResolvedValue({ id: ORG_B, slug: "org-b" }));

  it("ORG ADMIN of org-a gets 404 for org-b's member list", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.read"]));
    expect((await membersGet(req(url), ctx)).status).toBe(404);
  });

  it("SUPERADMIN reaches org-b's member list", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.orgs.read"]));
    expect((await membersGet(req(url), ctx)).status).toBe(200);
  });
});

describe("P0-5 GET /organizations/[id]/provider-bindings — org-b", () => {
  const ctx = { params: Promise.resolve({ id: ORG_B }) };
  const url = `http://test.local/api/administrator/organizations/${ORG_B}/provider-bindings`;
  beforeEach(() => dbFirst.mockResolvedValue({ id: ORG_B, slug: "org-b" }));

  it("ORG ADMIN of org-a gets 404 for org-b's provider bindings", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.orgs.read"]));
    expect((await bindingsGet(req(url), ctx)).status).toBe(404);
  });
});

describe("P0-10 POST /permissions — global catalog is SUPERADMIN-only", () => {
  const url = "http://test.local/api/administrator/permissions";
  const body = JSON.stringify({ key: "custom.perm", description: "x" });

  it("an ORG ADMIN holding admin.permissions.manage still gets 403", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.permissions.manage"]));
    const res = await permissionsPost(
      req(url, { method: "POST", body, headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("P0-1 GET /export/[resource] — org-scoped exfil guard", () => {
  const ctx = { params: Promise.resolve({ resource: "users" }) };
  const url = "http://test.local/api/administrator/export/users";

  it("a null-scope admin exports ZERO data rows (header only)", async () => {
    accessGetter.mockResolvedValue(nullScopeAdmin(["admin.users.read"]));
    // The DB would yield a row, but a null scope must export nothing.
    dbExecuteResult = [{ id: "u-leak", primary_email: "leak@org-b.com" }];
    const res = await exportGet(req(url), ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Exactly one line: the CSV header. No tenant rows leaked.
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});

describe("GET /email/outbox — org-scoped after the tenant column was added", () => {
  const url = "http://test.local/api/administrator/email/outbox";

  it("an ORG ADMIN now reads their own org's outbox (200, scoped to their org)", async () => {
    // The seeded `admin.platform` role holds admin.email.read WITHOUT the
    // superuser marker — exactly this actor. They are confined to ORG_A's
    // rows by the WHERE clause; they no longer get a blanket 403.
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.email.read"]));
    dbExecuteResult = [{ id: "o-1", organization_id: ORG_A, to_email: "u@org-a.com" }];
    dbFirst.mockResolvedValue({ total: "1" });
    const res = await outboxGet(req(url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("an admin with no resolvable org sees an EMPTY outbox, never 'all'", async () => {
    accessGetter.mockResolvedValue(nullScopeAdmin(["admin.email.read"]));
    dbExecuteResult = [{ id: "o-leak", organization_id: ORG_B, to_email: "u@org-b.com" }];
    dbFirst.mockResolvedValue({ total: "1" });
    const res = await outboxGet(req(url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("SUPERADMIN reads every org's outbox (including org-less platform mail)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.email.read"]));
    dbExecuteResult = [{ id: "o-1", organization_id: null, to_email: "sys@x.com" }];
    dbFirst.mockResolvedValue({ total: "1" });
    expect((await outboxGet(req(url))).status).toBe(200);
  });

  /**
   * review #220 made invitation mail visible to the inviting org by writing
   * `app_outbox.organization_id`. That is only safe while the LIST still
   * filters on that column — the 200s above would stay green even if the
   * predicate were dropped, because this suite's DB is shape-only. These two
   * assert the predicate itself.
   */
  it("APPLIES the org predicate for an ORG ADMIN (no cross-tenant leak)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.email.read"]));
    dbExecuteResult = [];
    dbFirst.mockResolvedValue({ total: "0" });
    await outboxGet(req(url));
    expect(dbWhereCalls).toContainEqual(["o.organization_id", "=", ORG_A]);
    // …and never another tenant's id.
    expect(dbWhereCalls).not.toContainEqual(["o.organization_id", "=", ORG_B]);
  });

  it("adds NO org predicate for a SUPERADMIN (platform-wide by design)", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.email.read"]));
    dbExecuteResult = [];
    dbFirst.mockResolvedValue({ total: "0" });
    await outboxGet(req(url));
    expect(dbWhereCalls.some((c) => c[0] === "o.organization_id")).toBe(false);
  });
});

describe("GET /email/outbox/[id] — bodies are org-scoped like the list (review #221 / #21)", () => {
  const OUTBOX_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ctx = { params: Promise.resolve({ id: OUTBOX_ID }) };
  const url = `http://test.local/api/administrator/email/outbox/${OUTBOX_ID}`;
  const rowIn = (org: string | null) => ({
    id: OUTBOX_ID,
    organization_id: org,
    template_key: "password_reset",
    to_email: "victim@org-b.com",
    subject: "Reset your password",
    body_html: "<p>http://x/reset-password/[redacted]?callbackURL=%2F</p>",
    body_text: "http://x/reset-password/[redacted]?callbackURL=%2F",
    status: "logged",
  });

  it("ORG ADMIN of org-a gets 404 for a row owned by org-b (no existence leak)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.email.read"]));
    dbFirst.mockResolvedValue(rowIn(ORG_B));
    expect((await outboxDetailGet(req(url), ctx)).status).toBe(404);
  });

  it("ORG ADMIN gets 404 for an org-less platform row (SUPERADMIN-only)", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.email.read"]));
    dbFirst.mockResolvedValue(rowIn(null));
    expect((await outboxDetailGet(req(url), ctx)).status).toBe(404);
  });

  it("an admin with no resolvable org gets 404, never the row", async () => {
    accessGetter.mockResolvedValue(nullScopeAdmin(["admin.email.read"]));
    dbFirst.mockResolvedValue(rowIn(ORG_A));
    expect((await outboxDetailGet(req(url), ctx)).status).toBe(404);
  });

  it("ORG ADMIN reads their own org's row — with redacted bodies only", async () => {
    accessGetter.mockResolvedValue(orgAdmin(ORG_A, ["admin.email.read"]));
    dbFirst.mockResolvedValue(rowIn(ORG_A));
    const res = await outboxDetailGet(req(url), ctx);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("/reset-password/[redacted]?");
    expect(text).not.toMatch(/\/reset-password\/(?!\[redacted\])[^/?"]+/);
  });

  it("SUPERADMIN reaches a row in any org and the org-less rows", async () => {
    accessGetter.mockResolvedValue(superadmin(["admin.email.read"]));
    dbFirst.mockResolvedValue(rowIn(null));
    expect((await outboxDetailGet(req(url), ctx)).status).toBe(200);
  });
});
