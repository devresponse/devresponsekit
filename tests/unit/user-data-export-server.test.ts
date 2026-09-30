import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-151: `buildUserDataExport` against a scripted query builder. What each
 * query MEANS against real rows (only the subject's data, no secret, the
 * organization confinement) is proven in
 * tests/db/user-data-export-erasure.db.test.ts; this suite pins the mapping
 * from rows to the document, the organization filter being applied to every
 * organization-attributed section and to nothing else, and the audit cap.
 *
 * The fake builder answers each `selectFrom(<table>)` terminal call from a
 * per-table queue, runs `where` callbacks and `$if` branches (so a filter
 * written inside one is recorded, not skipped), and records every call.
 */
type Call = { table: string; method: string; args: unknown[] };
const calls: Call[] = [];
const queues = new Map<string, unknown[]>();

const eb = Object.assign((...args: unknown[]) => ({ cmp: args }), {
  or: (terms: unknown[]) => ({ or: terms }),
  fn: (name: string, args: unknown[]) => ({ fn: name, args }),
});

function chain(table: string): unknown {
  const next = () => queues.get(table)?.shift();
  const self: object = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "execute") return async () => (next() as unknown[] | undefined) ?? [];
        if (prop === "executeTakeFirst") return async () => next();
        if (prop === "$if") {
          return (cond: boolean, apply: (q: unknown) => unknown) => {
            calls.push({ table, method: "$if", args: [cond] });
            return cond ? apply(self) : self;
          };
        }
        return (...args: unknown[]) => {
          if (typeof args[0] === "function") (args[0] as (e: typeof eb) => unknown)(eb);
          calls.push({ table, method: prop, args });
          return self;
        };
      },
    },
  );
  return self;
}

vi.mock("@/db/database", () => ({ db: { selectFrom: (table: string) => chain(table) } }));

const { buildUserDataExport } = await import("@/lib/user-data/export.server");
const { AUDIT_EXPORT_MAX_ROWS } = await import("@/lib/user-data/export-shape");

const T = new Date("2026-09-01T00:00:00Z");
const USER = {
  id: "u-x",
  better_auth_user_id: "ba-x",
  primary_email: "X@Example.test",
  display_name: "Xavier",
  status: "active",
  preferred_locale: "fr",
  created_at: T,
  updated_at: T,
  deactivated_at: null,
};

function script(overrides: Record<string, unknown[]> = {}) {
  const base: Record<string, unknown[]> = {
    app_users: [USER],
    user: [
      { name: "Xavier", email: "x@example.test", emailVerified: true, image: null, createdAt: T },
    ],
    app_organization_invitations: [
      [{ email: "x.old@example.test" }],
      [
        {
          id: "i-1",
          organization_id: "o-1",
          email: "x.old@example.test",
          status: "accepted",
          created_at: T,
          expires_at: T,
          accepted_at: T,
          revoked_at: null,
        },
      ],
    ],
    app_user_locale_preferences: [
      {
        locale: "fr",
        time_zone: "Europe/Kyiv",
        date_format: null,
        number_format_locale: null,
        updated_at: T,
      },
    ],
    "app_organization_memberships as m": [
      [
        {
          organization_id: "o-1",
          slug: "acme",
          name: "Acme",
          status: "active",
          source_provider: "email",
          created_at: T,
          updated_at: T,
        },
      ],
    ],
    "app_user_roles as ur": [
      [{ organization_id: "o-1", role_id: "r-1", key: "admin", name: "Admin", created_at: T }],
    ],
    "app_group_memberships as gm": [
      [{ group_id: "g-1", organization_id: "o-1", key: "ops", name: "Ops", created_at: T }],
    ],
    account: [[{ providerId: "credential", accountId: "ba-x", createdAt: T }]],
    session: [
      [
        {
          createdAt: T,
          updatedAt: T,
          expiresAt: T,
          ipAddress: "192.0.2.1",
          userAgent: "UA",
          impersonatedBy: "ba-admin",
        },
      ],
    ],
    app_api_keys: [
      [
        {
          id: "k-1",
          name: "ci",
          key_prefix: "drk_ab",
          organization_id: "o-1",
          scopes: ["account.read"],
          status: "active",
          created_at: T,
          expires_at: null,
          last_used_at: T,
          last_used_ip: "192.0.2.2",
          revoked_at: null,
          revoked_reason: null,
        },
      ],
    ],
    app_oauth_clients: [
      [
        {
          id: "c-1",
          client_id: "cid",
          name: "svc",
          organization_id: null,
          scopes: [],
          status: "revoked",
          created_at: T,
          revoked_at: T,
        },
      ],
    ],
    app_audit_events: [
      [
        {
          id: "e-1",
          created_at: T,
          event_type: "admin.user.updated",
          outcome: "success",
          actor_better_auth_user_id: "ba-admin",
          app_user_id: null,
          organization_id: "o-1",
          target_application_id: null,
          provider: null,
          // Named by the address learned from the accepted invitation.
          email: "x.old@example.test",
          ip_address: "198.51.100.9",
          user_agent: "admin-UA",
          reason: null,
          request_id: "req",
          metadata: {},
        },
      ],
    ],
  };
  queues.clear();
  for (const [table, rows] of Object.entries({ ...base, ...overrides })) {
    queues.set(table, [...rows]);
  }
}

beforeEach(() => {
  calls.length = 0;
  script();
});

describe("buildUserDataExport (F-151)", () => {
  it("returns null when no account has the id, reading nothing else", async () => {
    script({ app_users: [] });
    expect(await buildUserDataExport("missing")).toBeNull();
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["app_users"]));
  });

  it("maps every section, without secrets, and shapes the audit rows for the subject", async () => {
    const doc = await buildUserDataExport("u-x", { now: new Date("2026-09-29T00:00:00Z") });
    expect(doc).toMatchObject({
      format: "devresponse.user-data-export",
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      organizationScope: null,
      profile: { appUserId: "u-x", betterAuthUserId: "ba-x", primaryEmail: "X@Example.test" },
      authentication: { email: "x@example.test", emailVerified: true },
      preferences: { locale: "fr", timeZone: "Europe/Kyiv" },
      memberships: [{ organizationId: "o-1", organizationSlug: "acme", organizationName: "Acme" }],
      roles: [{ roleId: "r-1", roleKey: "admin" }],
      groups: [{ groupId: "g-1", groupKey: "ops" }],
      linkedAccounts: [{ providerId: "credential", accountId: "ba-x" }],
      sessions: [{ ipAddress: "192.0.2.1", impersonated: true }],
      apiKeys: [{ id: "k-1", keyPrefix: "drk_ab", lastUsedIp: "192.0.2.2" }],
      oauthClients: [{ id: "c-1", clientId: "cid", status: "revoked" }],
      invitations: [{ id: "i-1", status: "accepted" }],
      auditEventsTruncated: false,
    });
    expect(doc!.auditEvents).toEqual([
      expect.objectContaining({
        id: "e-1",
        role: "subject",
        actedBySelf: false,
        email: "x.old@example.test",
        ipAddress: null,
      }),
    ]);
    // The sessions query never selects the token, and no section carries a hash.
    const sessionSelect = calls.find((c) => c.table === "session" && c.method === "select");
    expect(sessionSelect?.args[0]).not.toContain("token");
    expect(JSON.stringify(doc)).not.toMatch(/key_hash|client_secret|password|token"/);
  });

  it("confines every organization-attributed section, and only those, to the given organization", async () => {
    const doc = await buildUserDataExport("u-x", { organizationId: "o-1" });
    expect(doc!.organizationScope).toBe("o-1");
    const scoped = new Set(
      calls
        .filter((c) => c.method === "where" && String(c.args[0]).endsWith("organization_id"))
        .filter((c) => c.args[2] === "o-1")
        .map((c) => c.table),
    );
    expect(scoped).toEqual(
      new Set([
        "app_organization_memberships as m",
        "app_user_roles as ur",
        "app_group_memberships as gm",
        "app_api_keys",
        "app_oauth_clients",
        "app_organization_invitations",
        "app_audit_events",
      ]),
    );
    // Without an organization no branch applies.
    calls.length = 0;
    script();
    await buildUserDataExport("u-x");
    expect(calls.filter((c) => c.method === "$if").every((c) => c.args[0] === false)).toBe(true);
  });

  it("carries at most AUDIT_EXPORT_MAX_ROWS audit rows and says when it cut", async () => {
    const one = {
      id: "e",
      created_at: T,
      event_type: "auth.session.created",
      outcome: "success",
      actor_better_auth_user_id: "ba-x",
      app_user_id: null,
      organization_id: null,
      target_application_id: null,
      provider: null,
      email: null,
      ip_address: null,
      user_agent: null,
      reason: null,
      request_id: null,
      metadata: {},
    };
    script({ app_audit_events: [Array.from({ length: AUDIT_EXPORT_MAX_ROWS + 1 }, () => one)] });
    const doc = await buildUserDataExport("u-x");
    expect(doc!.auditEvents).toHaveLength(AUDIT_EXPORT_MAX_ROWS);
    expect(doc!.auditEventsTruncated).toBe(true);
    const limit = calls.find((c) => c.table === "app_audit_events" && c.method === "limit");
    expect(limit?.args).toEqual([AUDIT_EXPORT_MAX_ROWS + 1]);
  });

  it("leaves authentication and preferences null when there are none (an agent's service account)", async () => {
    script({ user: [], app_user_locale_preferences: [] });
    const doc = await buildUserDataExport("u-x");
    expect(doc!.authentication).toBeNull();
    expect(doc!.preferences).toBeNull();
  });
});
