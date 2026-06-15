import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as UserTargetModule from "@/lib/admin/user-target.server";

/**
 * Schema / input-validation hardening — the zod contracts that stand
 * between request bodies and the database. For each mutating admin handler
 * we assert it rejects with 400:
 *   - unknown fields (`.strict()` — no mass-assignment),
 *   - malformed UUIDs,
 *   - oversized strings past the documented `max()` caps (a DoS guard),
 *   - invalid enum values.
 *
 * A SUPERADMIN + permissive DB let every handler reach its schema check, so
 * the ONLY reason for the 400s below is input validation.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
const noop = () => {};
vi.mock("@/lib/audit.server", () => ({ auditEvent: noop }));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: noop,
  auditOrgAction: noop,
  auditRoleAction: noop,
}));
vi.mock("@/lib/admin/user-target.server", async () => {
  const actual = await vi.importActual<typeof UserTargetModule>("@/lib/admin/user-target.server");
  return {
    ...actual, // keep the real isUuid
    resolveTargetUser: async () => ({
      appUserId: "u-target",
      betterAuthUserId: "ba-target",
      primaryEmail: "t@x.com",
    }),
    isResolvedUserResponse: (v: unknown) => v instanceof Response,
  };
});
// Permissive DB: existence checks pass; nothing is asserted on writes since
// every test short-circuits at schema validation.
vi.mock("@/db/database", () => {
  const row = { id: "x", organization_id: "o1", slug: "s", key: "k", name: "n" };
  function chain(): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "executeTakeFirst") return async () => row;
          if (prop === "executeTakeFirstOrThrow") return async () => row;
          if (prop === "execute") return async () => [];
          return () => chain();
        },
      },
    );
  }
  return {
    db: {
      selectFrom: () => chain(),
      insertInto: () => chain(),
      updateTable: () => chain(),
      deleteFrom: () => chain(),
      transaction: () => ({ execute: async (cb: (t: unknown) => Promise<unknown>) => cb(chain()) }),
    },
  };
});

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "admin-1",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [
    "superuser",
    "admin.roles.create",
    "admin.roles.update",
    "admin.permissions.manage",
    "admin.orgs.update",
    "admin.users.update",
  ],
};

function jsonReq(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const BASE = "http://test.local/api/administrator";
const big = (n: number) => "a".repeat(n);

// Route handlers have varying ctx types ((req) vs (req, { params })); a
// permissive callable lets one table hold them all.
type AnyHandler = (req: NextRequest, ctx?: unknown) => Promise<Response>;
interface Handler {
  name: string;
  load: () => Promise<unknown>;
  url: string;
  ctx?: unknown;
  cases: Array<[string, unknown]>;
}

const HANDLERS: Handler[] = [
  {
    name: "roles POST",
    load: async () => (await import("@/app/api/administrator/roles/route")).POST,
    url: `${BASE}/roles`,
    cases: [
      ["unknown field (.strict)", { key: "x.y", name: "X", evil: 1 }],
      ["oversized name", { key: "x.y", name: big(201) }],
      ["illegal key characters", { key: "bad key!", name: "X" }],
    ],
  },
  {
    name: "permissions POST",
    load: async () => (await import("@/app/api/administrator/permissions/route")).POST,
    url: `${BASE}/permissions`,
    cases: [
      ["unknown field (.strict)", { key: "custom.perm", evil: 1 }],
      ["oversized key", { key: big(121) }],
    ],
  },
  {
    name: "provider-bindings POST",
    load: async () =>
      (await import("@/app/api/administrator/organizations/[id]/provider-bindings/route")).POST,
    url: `${BASE}/organizations/${ORG}/provider-bindings`,
    ctx: { params: Promise.resolve({ id: ORG }) },
    cases: [
      ["unknown field (.strict)", { provider: "google", providerOrganizationKey: "g1", evil: 1 }],
      ["oversized provider", { provider: big(65), providerOrganizationKey: "g1" }],
    ],
  },
  {
    name: "org members POST",
    load: async () =>
      (await import("@/app/api/administrator/organizations/[id]/members/route")).POST,
    url: `${BASE}/organizations/${ORG}/members`,
    ctx: { params: Promise.resolve({ id: ORG }) },
    cases: [
      ["malformed appUserId UUID", { appUserId: "not-a-uuid" }],
      ["invalid status enum", { appUserId: USER, status: "wat" }],
      ["unknown field (.strict)", { appUserId: USER, evil: 1 }],
    ],
  },
  {
    name: "user memberships POST",
    load: async () => (await import("@/app/api/administrator/users/[id]/memberships/route")).POST,
    url: `${BASE}/users/${USER}/memberships`,
    ctx: { params: Promise.resolve({ id: USER }) },
    cases: [
      ["malformed organizationId UUID", { organizationId: "nope" }],
      ["invalid status enum", { organizationId: ORG, status: "frozen" }],
      ["unknown field (.strict)", { organizationId: ORG, evil: 1 }],
    ],
  },
  {
    name: "roles/[id]/permissions POST",
    load: async () => (await import("@/app/api/administrator/roles/[id]/permissions/route")).POST,
    url: `${BASE}/roles/${ROLE}/permissions`,
    ctx: { params: Promise.resolve({ id: ROLE }) },
    cases: [
      ["unknown field (.strict)", { ids: ["admin.users.read"], evil: 1 }],
      ["empty ids (min 1)", { ids: [] }],
      ["oversized permission key", { ids: [big(121)] }],
    ],
  },
];

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});
afterEach(() => vi.resetModules());

describe("admin handler input validation (400 on malformed bodies)", () => {
  for (const h of HANDLERS) {
    describe(h.name, () => {
      for (const [desc, body] of h.cases) {
        it(`rejects: ${desc}`, async () => {
          const POST = (await h.load()) as AnyHandler;
          const res = await POST(jsonReq(h.url, body), h.ctx);
          expect(res.status).toBe(400);
        });
      }
    });
  }
});
