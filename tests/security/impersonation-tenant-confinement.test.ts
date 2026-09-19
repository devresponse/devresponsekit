import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * IMP-1 — AN IMPERSONATED SESSION CANNOT PIVOT INTO A TENANT THE IMPERSONATOR
 * DOES NOT BELONG TO.
 *
 * The vulnerability this pins closed: impersonation was tenant-confined only
 * by ENUMERATION. `POST/GET /api/preferences/active-org(/apply)` refuse to
 * switch while `impersonatedBy` is set, and the impersonate route's escalation
 * guard leaned on that — but `active_org` is a plain UNSIGNED cookie that
 * `getUserAccessContext` reads for whichever user the SESSION names, which
 * during an impersonation is the TARGET. `httpOnly` stops other sites reading
 * it; it does not stop the browser's own owner rewriting it in devtools or
 * replaying the request with curl. So an org-A admin could impersonate a user
 * who is a plain member in A but an ADMIN in org B, set `active_org` to B, and
 * wield the target's admin permissions in a tenant the guard never evaluated.
 *
 * Unlike the unit tests, this drives the WHOLE cookie chain for real —
 * `resolveCaller` → `getSessionAccessContext` → `getUserAccessContext` →
 * `active-org.server` — against a membership table that answers truthfully,
 * and reads the answer off a real route (`GET /api/v1/me`, which reports the
 * resolved org and the effective permissions). Only the session lookup, the
 * cookie store and the database are stubbed.
 *
 * The three controls are what stop this passing by simply denying everyone:
 * the target's OWN session must still be able to select org B, an impersonator
 * who IS in org B must still be able to reach it, and ordinary same-tenant
 * impersonation must be unaffected.
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TARGET = {
  id: "u-target",
  betterAuthUserId: "ba-target",
  primary_email: "target@x.com",
  status: "active",
  preferred_locale: "en",
};

/**
 * The membership table, answered truthfully by the stub below. The target is
 * an active member of BOTH tenants — that is what makes the pivot possible at
 * all — and the impersonator's memberships vary per test.
 */
interface MembershipRow extends Record<string, unknown> {
  app_user_id: string;
  better_auth_user_id: string;
  organization_id: string;
  status: string;
  /** Stands in for `created_at asc` (the earliest-membership fallback). */
  seq: number;
}

let memberships: MembershipRow[] = [];

/** Permissions the target's roles confer, per organization. */
const PERMISSIONS_BY_ORG: Record<string, string[]> = {
  [ORG_A]: [],
  // The prize: admin authority in a tenant the impersonating admin is not in.
  [ORG_B]: ["admin.users.read", "admin.roles.update"],
};

const cookieValue = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => ({ value: cookieValue(name) }) }),
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => getCurrentSession(),
  getImpersonatorId: () => null,
}));

/** Applies the recorded `where` tuples to a fixture row (`=` and `in` only). */
function matches(row: Record<string, unknown>, wheres: unknown[][]): boolean {
  return wheres.every(([rawCol, op, value]) => {
    const col = String(rawCol).split(".").pop()!;
    const actual = row[col];
    if (op === "in") return Array.isArray(value) && value.includes(actual);
    return actual === value;
  });
}

function builderFor(table: string): unknown {
  const wheres: unknown[][] = [];

  const rows = (): Record<string, unknown>[] => {
    if (table === "app_users") {
      return [{ ...TARGET, better_auth_user_id: TARGET.betterAuthUserId }];
    }
    if (table.startsWith("app_organization_memberships")) {
      const found = memberships.filter((m) => matches(m, wheres));
      return [...found].sort((a, b) => a.seq - b.seq);
    }
    return [];
  };

  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "where") {
          return (...args: unknown[]) => {
            // `eb => …` callbacks are not used by the queries under test.
            if (args.length === 3) wheres.push(args);
            return proxy;
          };
        }
        // `orderBy("created_at")` is modelled by the `seq` sort in `rows()`.
        if (prop === "execute") {
          return async () => {
            // The effective-permission UNION (`app_user_roles as ur` ∪ groups),
            // keyed on whichever org the membership resolution settled on.
            if (table === "app_user_roles as ur") {
              const org = wheres.find(([c]) => String(c).endsWith("organization_id"))?.[2];
              return (PERMISSIONS_BY_ORG[String(org)] ?? []).map((key) => ({ key }));
            }
            return rows();
          };
        }
        if (prop === "executeTakeFirst") {
          return async () => {
            // `userIsGlobalSuperuser` probes `app_user_roles as ur` with a
            // terminal takeFirst — nobody here is a global superuser.
            if (table === "app_user_roles as ur") return undefined;
            // `rows()` already returns memberships in `seq` order, which stands
            // in for `created_at asc`, so the first row is what both the
            // cookie lookup and the earliest-membership fallback would get.
            return rows()[0];
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/db/database", () => ({
  db: { selectFrom: (table: string) => builderFor(table) },
  pgPool: {},
}));

function meRequest(): NextRequest {
  const url = new URL("http://test.local/api/v1/me");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    headers: new Headers({ origin: "http://test.local" }),
  } as unknown as NextRequest;
}

interface MeBody {
  organizationId: string | null;
  permissions: string[];
}

/** Resolves `GET /api/v1/me` for the given session + `active_org` cookie. */
async function resolveMe(session: unknown, activeOrgCookie: string | null): Promise<MeBody> {
  getCurrentSession.mockResolvedValue(session);
  cookieValue.mockImplementation((name: string) =>
    name === "active_org" ? (activeOrgCookie ?? undefined) : undefined,
  );
  const { GET } = await import("@/app/api/v1/me/route");
  const res = await GET(meRequest());
  expect(res.status).toBe(200);
  return (await res.json()) as MeBody;
}

const ownSession = { user: { id: TARGET.betterAuthUserId } };
const impersonatedSession = {
  user: { id: TARGET.betterAuthUserId },
  session: { impersonatedBy: "ba-admin" },
};

/** The target is in both tenants; the admin's memberships are the variable. */
function seedMemberships(adminOrgs: string[]): void {
  memberships = [
    {
      app_user_id: TARGET.id,
      better_auth_user_id: TARGET.betterAuthUserId,
      organization_id: ORG_A,
      status: "active",
      seq: 1,
    },
    {
      app_user_id: TARGET.id,
      better_auth_user_id: TARGET.betterAuthUserId,
      organization_id: ORG_B,
      status: "active",
      seq: 2,
    },
    ...adminOrgs.map((org, i) => ({
      app_user_id: "u-admin",
      better_auth_user_id: "ba-admin",
      organization_id: org,
      status: "active",
      seq: 10 + i,
    })),
  ];
}

beforeEach(() => {
  getCurrentSession.mockReset();
  cookieValue.mockReset();
  seedMemberships([ORG_A]);
});
afterEach(() => vi.resetModules());

describe("IMP-1: the active_org cookie cannot steer an impersonated session out of tenancy", () => {
  it("refuses the pivot: a rewritten cookie naming org B resolves org A instead", async () => {
    // The attack, end to end. The admin is in org A only; the cookie says B.
    const me = await resolveMe(impersonatedSession, ORG_B);

    expect(me.organizationId).toBe(ORG_A);
    // And — the part that actually matters — none of the target's org-B
    // authority came along.
    expect(me.permissions).not.toContain("admin.users.read");
    expect(me.permissions).not.toContain("admin.roles.update");
  });

  it("refuses the pivot even when org B is the target's EARLIEST membership", async () => {
    // The fallback path. With no cookie at all, the resolver picks the
    // earliest membership — so a confinement applied only to the cookie lookup
    // would land the borrowed session in org B anyway.
    memberships = memberships.map((m) =>
      m.app_user_id === TARGET.id ? { ...m, seq: m.organization_id === ORG_B ? 0 : 5 } : m,
    );
    const me = await resolveMe(impersonatedSession, null);

    expect(me.organizationId).toBe(ORG_A);
    expect(me.permissions).not.toContain("admin.roles.update");
  });

  it("resolves NOTHING when the impersonator shares no tenant with the target", async () => {
    // Fail closed rather than falling back to one of the target's own orgs.
    // The empty intersection leaves the session with no membership at all, so
    // `decideSecureAccess` blocks it outright — a 403 from the account guard
    // rather than a reduced-privilege 200.
    seedMemberships(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    getCurrentSession.mockResolvedValue(impersonatedSession);
    cookieValue.mockImplementation((name: string) => (name === "active_org" ? ORG_B : undefined));
    const { GET } = await import("@/app/api/v1/me/route");
    const res = await GET(meRequest());

    expect(res.status).toBe(403);
  });
});

describe("IMP-1 controls: the cookie still works for everyone it should", () => {
  it("the target's OWN session selects org B from the cookie, with its org-B authority", async () => {
    // Proves the refusals above are the confinement biting, not a missing
    // membership or a broken stub.
    const me = await resolveMe(ownSession, ORG_B);

    expect(me.organizationId).toBe(ORG_B);
    expect(me.permissions).toContain("admin.roles.update");
  });

  it("an impersonator who IS a member of org B may reach org B", async () => {
    seedMemberships([ORG_A, ORG_B]);
    const me = await resolveMe(impersonatedSession, ORG_B);

    expect(me.organizationId).toBe(ORG_B);
    // Assuming the target's authority INSIDE the admin's own tenancy is the
    // point of impersonation, so it must survive.
    expect(me.permissions).toContain("admin.roles.update");
  });

  it("ordinary same-tenant impersonation is unaffected", async () => {
    const me = await resolveMe(impersonatedSession, ORG_A);

    expect(me.organizationId).toBe(ORG_A);
    // `shell.view` is implied by an active membership.
    expect(me.permissions).toContain("shell.view");
  });
});
