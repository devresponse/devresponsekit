import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * F-58 — a superadmin-only action refused to a caller without cross-org reach
 * is audited.
 *
 * Each of these handlers answers an org admin who HOLDS the route's permission
 * with a 403, because the action is platform-wide (the permission catalog, a
 * tenant's lifecycle, the global email templates and sign-up defaults, a global
 * role or app, moving an app between tenants, an app id outside the caller's
 * org namespace, I-01). The permission pipeline had
 * already let the caller through, so nothing recorded the attempt. Each now
 * writes one `administrator.access.denied` row (reason
 * `cross_org_reach_required`, the attempted `action` in metadata) under the
 * actor's org, and still writes nothing else. The set-role and create-with-
 * `admin`-role twins are pinned in their own suites.
 *
 * The real guard runs (session → access context → permission check); the
 * database is a stub that records every write, so "nothing else" is checked.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

/** Every insert / update / delete the handler issued, by table. */
const writes = vi.hoisted(() => [] as string[]);
/** What a `select … executeTakeFirst()` answers, by table. Unset: no row. */
const firstRows = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/db/database", () => {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return undefined;
          if (prop === "executeTakeFirst") return async () => firstRows[table];
          if (prop === "execute") return async () => [];
          return () => chain(table);
        },
      },
    );
  const write = (table: string) => {
    writes.push(table);
    return chain(table);
  };
  return {
    db: {
      selectFrom: (table: string) => chain(table),
      insertInto: write,
      updateTable: write,
      deleteFrom: write,
      transaction: () => ({ execute: async () => undefined }),
    },
  };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";

/** An org admin of ORG_A holding exactly `permissions`, with no cross-org reach. */
const orgAdmin = (permissions: string[]) => ({
  appUserId: "u-admin",
  primaryEmail: "admin@org-a.test",
  status: "active",
  organizationId: ORG_A,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions,
});

function req(path: string, method: string, body?: unknown): NextRequest {
  const url = `http://test.local/api/administrator/${path}`;
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}
const idCtx = (id = ID) => ({ params: Promise.resolve({ id }) });

interface ReachGate {
  name: string;
  permission: string;
  action: string;
  /** Extra metadata the refusal records beyond `action`. */
  metadata?: Record<string, unknown>;
  /** Rows the handler reads before its gate. */
  setup?: () => void;
  invoke: () => Promise<Response>;
}

const APP = {
  id: "crm",
  label: "CRM",
  origin: "https://crm.example.com",
  subdomain: "crm",
  sso_audience: "crm",
};

const gates: ReachGate[] = [
  {
    name: "GET /auth-settings/defaults",
    permission: "admin.orgs.read",
    action: "platform_auth_policy_read",
    invoke: async () => {
      const { GET } = await import("@/app/api/administrator/auth-settings/defaults/route");
      return GET(req("auth-settings/defaults", "GET"));
    },
  },
  {
    name: "PATCH /auth-settings/defaults",
    permission: "admin.orgs.update",
    action: "platform_auth_policy_update",
    invoke: async () => {
      const { PATCH } = await import("@/app/api/administrator/auth-settings/defaults/route");
      return PATCH(req("auth-settings/defaults", "PATCH", { requireEmailVerification: false }));
    },
  },
  {
    name: "PUT /email/templates/[id]",
    permission: "admin.email.manage",
    action: "email_template_update",
    invoke: async () => {
      const { PUT } = await import("@/app/api/administrator/email/templates/[id]/route");
      return PUT(req(`email/templates/${ID}`, "PUT", { subject: "Hi" }), idCtx());
    },
  },
  {
    name: "POST /enterprise-apps (global)",
    permission: "admin.apps.manage",
    action: "enterprise_app_create",
    metadata: { requestedGlobal: true },
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/enterprise-apps/route");
      return POST(req("enterprise-apps", "POST", { ...APP, organization_id: null }));
    },
  },
  {
    // I-01: in its own org, but under a global name (`crm`, audience `crm`).
    name: "POST /enterprise-apps (own org, global name)",
    permission: "admin.apps.manage",
    action: "enterprise_app_global_name",
    metadata: { applicationId: "crm", ssoAudience: "crm" },
    setup: () => {
      firstRows.app_organizations = { slug: "org-a" };
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/enterprise-apps/route");
      return POST(req("enterprise-apps", "POST", { ...APP, organization_id: ORG_A }));
    },
  },
  {
    name: "PATCH /enterprise-apps/[id] (move between tenants)",
    permission: "admin.apps.manage",
    action: "enterprise_app_rehome",
    metadata: { applicationId: "crm" },
    setup: () => {
      firstRows.app_enterprise_applications = { id: "crm", organization_id: ORG_A };
    },
    invoke: async () => {
      const { PATCH } = await import("@/app/api/administrator/enterprise-apps/[id]/route");
      return PATCH(req("enterprise-apps/crm", "PATCH", { organization_id: null }), idCtx("crm"));
    },
  },
  {
    name: "POST /organizations",
    permission: "admin.orgs.create",
    action: "organization_create",
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/organizations/route");
      return POST(req("organizations", "POST", { slug: "new-org", name: "New" }));
    },
  },
  {
    name: "PATCH /organizations/[id]",
    permission: "admin.orgs.update",
    action: "organization_update",
    invoke: async () => {
      const { PATCH } = await import("@/app/api/administrator/organizations/[id]/route");
      return PATCH(req(`organizations/${ORG_A}`, "PATCH", { name: "Renamed" }), idCtx(ORG_A));
    },
  },
  {
    name: "DELETE /organizations/[id]",
    permission: "admin.orgs.delete",
    action: "organization_delete",
    invoke: async () => {
      const { DELETE } = await import("@/app/api/administrator/organizations/[id]/route");
      return DELETE(req(`organizations/${ORG_A}`, "DELETE"), idCtx(ORG_A));
    },
  },
  {
    name: "POST /permissions",
    permission: "admin.permissions.manage",
    action: "permission_create",
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/permissions/route");
      return POST(req("permissions", "POST", { key: "custom.perm", description: "x" }));
    },
  },
  {
    name: "PATCH /permissions/[id]",
    permission: "admin.permissions.manage",
    action: "permission_update",
    invoke: async () => {
      const { PATCH } = await import("@/app/api/administrator/permissions/[id]/route");
      return PATCH(req(`permissions/${ID}`, "PATCH", { description: "y" }), idCtx());
    },
  },
  {
    name: "DELETE /permissions/[id]",
    permission: "admin.permissions.manage",
    action: "permission_delete",
    invoke: async () => {
      const { DELETE } = await import("@/app/api/administrator/permissions/[id]/route");
      return DELETE(req(`permissions/${ID}`, "DELETE"), idCtx());
    },
  },
  {
    name: "POST /roles (global)",
    permission: "admin.roles.create",
    action: "role_create",
    metadata: { requestedGlobal: true },
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/roles/route");
      return POST(req("roles", "POST", { key: "auditor", name: "Auditor", organizationId: null }));
    },
  },
];

beforeEach(() => {
  for (const m of [sessionGetter, accessGetter, auditMock]) m.mockReset();
  writes.length = 0;
  for (const key of Object.keys(firstRows)) delete firstRows[key];
  sessionGetter.mockResolvedValue({ user: { id: "ba-admin" }, session: { id: "s-1" } });
});
afterEach(() => vi.resetModules());

describe.each(gates)("$name — refused to an org admin holding $permission", (gate) => {
  it("answers the same 403, writes one denied row under the actor's org, and nothing else", async () => {
    accessGetter.mockResolvedValue(orgAdmin([gate.permission]));
    gate.setup?.();
    const res = await gate.invoke();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "forbidden", message: "errors.forbidden" }),
    );
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        actorBetterAuthUserId: "ba-admin",
        organizationId: ORG_A,
        reason: "cross_org_reach_required",
        metadata: { action: gate.action, ...gate.metadata },
      }),
    );
    expect(writes).toEqual([]);
  });

  it("an org-bound superuser credential is refused the same way (MACHINE-2)", async () => {
    accessGetter.mockResolvedValue({
      ...orgAdmin([gate.permission, "superuser"]),
      orgBound: true,
    });
    gate.setup?.();
    const res = await gate.invoke();
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        organizationId: ORG_A,
        reason: "cross_org_reach_required",
      }),
    );
    expect(writes).toEqual([]);
  });
});
