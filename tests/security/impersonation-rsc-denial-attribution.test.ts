import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * F-07, the RSC half: a denied `/app/administrator/*` render made from an
 * impersonated session is audited against the HUMAN.
 *
 * The RSC gate (`checkAdminPermissionServer`) has no route `request`. It reads
 * the session through `getCurrentSession()`, which records the impersonation
 * on the ambient `headers()` store, and it writes its `administrator.access.denied`
 * row with `{ headers: await headers() }`. The attribution holds only while
 * those two are the SAME object, which no single-module test can see:
 * auth-guard.test.ts pins the record, audit-server.test.ts pins the rule, and
 * admin-permissions.test.ts mocks both. This runs the real session read, the
 * real gate and the real `auditEvent` over one fixed `Headers` object. Only
 * `next/headers`, Better Auth's session lookup, the access context and the
 * audit insert are stubbed.
 */

const HUMAN = "ba-human";
const BORROWED = "ba-borrowed";

const ambient = vi.hoisted(() => ({ headers: new Headers() }));
const audit = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const getSession = vi.fn();
const accessGetter = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => ambient.headers }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } },
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
vi.mock("@/db/database", () => ({
  db: {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === "app_audit_events") audit.rows.push(values);
        return { execute: async () => [] };
      },
    }),
  },
}));

/** Active, but holds no admin permission: every admin page denies. */
const NON_ADMIN = {
  appUserId: "u-session",
  primaryEmail: "session@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["shell.view"],
};

async function deniedRow(): Promise<Record<string, unknown>> {
  const { checkAdminPermissionServer } = await import("@/lib/admin/permissions.server");
  expect(await checkAdminPermissionServer("admin.audit.read")).toBe("denied");
  expect(audit.rows).toHaveLength(1);
  const row = audit.rows[0]!;
  expect(row).toMatchObject({
    event_type: "administrator.access.denied",
    outcome: "denied",
    reason: "missing_admin_permission",
  });
  return row;
}

const metadataOf = (row: Record<string, unknown>) =>
  JSON.parse(row.metadata as string) as Record<string, unknown>;

beforeEach(() => {
  audit.rows.length = 0;
  getSession.mockReset();
  accessGetter.mockReset().mockResolvedValue(NON_ADMIN);
  ambient.headers = new Headers({
    "user-agent": "vitest",
    "x-drk-pathname": "/en/app/administrator/audit",
  });
});
afterEach(() => vi.resetModules());

describe("RSC admin gate — denial rows under impersonation (F-07)", () => {
  it("names the impersonating admin, with the borrowed identity in metadata", async () => {
    getSession.mockResolvedValue({
      user: { id: BORROWED },
      session: { id: "s-imp", impersonatedBy: HUMAN },
    });

    const row = await deniedRow();
    expect(row.actor_better_auth_user_id).toBe(HUMAN);
    expect(metadataOf(row)).toMatchObject({
      required: ["admin.audit.read"],
      surface: "rsc",
      impersonatedBetterAuthUserId: BORROWED,
    });
  });

  it("control: an ordinary session is the actor, with no impersonation metadata", async () => {
    getSession.mockResolvedValue({ user: { id: "ba-self" }, session: { id: "s-own" } });

    const row = await deniedRow();
    expect(row.actor_better_auth_user_id).toBe("ba-self");
    expect(metadataOf(row)).not.toHaveProperty("impersonatedBetterAuthUserId");
  });
});
