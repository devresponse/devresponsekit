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
  /** Stands in for `created_at` (and the `id` tiebreak) in an ORDER BY. */
  seq: number;
}

let memberships: MembershipRow[] = [];

/**
 * Better Auth ids that resolve as GLOBAL SUPERUSERS (IMP-2). Their reach is
 * conferred by permission rather than by membership, so the confinement must
 * skip them entirely — see the superadmin case below.
 */
let superusers = new Set<string>();

/**
 * Better Auth ids that are currently BANNED (F-08). A Better Auth ban writes
 * none of the rows the fixtures above model, which is exactly why it has to
 * be consulted on its own.
 */
let banned = new Set<string>();
vi.mock("@/lib/api-auth/ban-status.server", () => ({
  isBetterAuthUserBanned: async (id: string) => banned.has(id),
}));

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
    // Every fixture ORGANIZATION (`o.status`, F-09) and ACCOUNT (`u.status`)
    // is active. Those predicates must not be read off the membership row's
    // own `status`, or a suspended membership would vanish as if its org had
    // been suspended.
    if (rawCol === "o.status" || rawCol === "u.status") return value === "active";
    const col = String(rawCol).split(".").pop()!;
    const actual = row[col];
    if (op === "in") return Array.isArray(value) && value.includes(actual);
    return actual === value;
  });
}

/**
 * One recorded `orderBy` term, reduced to a sort key per fixture row. The
 * resolver ranks with comparisons (`eb => eb("m.status", "=", "active")`,
 * F-33), so a callback is evaluated against a recording `eb` and scores 1 for
 * a row the comparison holds for; a plain column (`created_at`, `id`) reads
 * `seq`.
 */
interface OrderTerm {
  key: (row: Record<string, unknown>) => number;
  desc: boolean;
}

function orderTerm(expr: unknown, direction: unknown): OrderTerm {
  const desc = direction === "desc";
  if (typeof expr === "function") {
    const [rawCol, op, value] = expr((...args: unknown[]) => args) as unknown[];
    if (op !== "=") throw new Error(`unmodelled orderBy comparison ${String(op)}`);
    const col = String(rawCol).split(".").pop()!;
    return { key: (row) => (row[col] === value ? 1 : 0), desc };
  }
  return { key: (row) => Number(row.seq), desc };
}

function builderFor(table: string): unknown {
  const wheres: unknown[][] = [];
  const orders: OrderTerm[] = [];

  const rows = (): Record<string, unknown>[] => {
    if (table === "app_users") {
      return [{ ...TARGET, better_auth_user_id: TARGET.betterAuthUserId }];
    }
    if (table.startsWith("app_organization_memberships")) {
      const found = memberships.filter((m) => matches(m, wheres));
      // The recorded ORDER BY, applied in order; `seq` settles what is left,
      // as an unordered read would return rows in some fixed order too.
      return [...found].sort((a, b) => {
        for (const { key, desc } of orders) {
          const diff = key(a) - key(b);
          if (diff !== 0) return desc ? -diff : diff;
        }
        return a.seq - b.seq;
      });
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
        if (prop === "orderBy") {
          return (expr: unknown, direction?: unknown) => {
            orders.push(orderTerm(expr, direction));
            return proxy;
          };
        }
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
            if (table === "app_user_roles as ur") {
              // TWO superuser probes land on this table with a terminal
              // takeFirst. `userIsGlobalSuperuser` keys on the app_users id
              // (the TARGET — never a superuser in these fixtures);
              // `betterAuthUserIsGlobalSuperuser` keys on the Better Auth id
              // (the IMPERSONATOR, IMP-2). Only the second is answerable here,
              // and only for an id the test opted in.
              const betterAuthId = wheres.find(([col]) =>
                String(col).endsWith("better_auth_user_id"),
              )?.[2];
              return typeof betterAuthId === "string" && superusers.has(betterAuthId)
                ? { id: "p-superuser" }
                : undefined;
            }
            // `rows()` already applies the recorded ORDER BY, so the first row
            // is what the resolver's `limit 1` would get.
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
  superusers = new Set();
  banned = new Set();
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

  it("F-33: ranking ACTIVE memberships first never reaches outside the confinement", async () => {
    // The resolver now prefers an active membership over the one the cookie
    // names. Here the only org the admin shares with the target is A, and the
    // target's A membership is SUSPENDED while their B membership (outside
    // the admin's tenancy) is active. The ranking must choose among the rows
    // the confinement admits — A alone — and resolve the suspended row, which
    // every guard refuses; it must never go looking for the active row in B.
    memberships = memberships.map((m) =>
      m.app_user_id === TARGET.id && m.organization_id === ORG_A
        ? { ...m, status: "suspended" }
        : m,
    );
    getCurrentSession.mockResolvedValue(impersonatedSession);
    cookieValue.mockImplementation((name: string) => (name === "active_org" ? ORG_A : undefined));
    const { GET } = await import("@/app/api/v1/me/route");

    expect((await GET(meRequest())).status).toBe(403);

    // The control: the target's OWN session, same rows, lands in B (F-33).
    const own = await resolveMe(ownSession, ORG_A);
    expect(own.organizationId).toBe(ORG_B);
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

  it("an impersonator who IS a member of org B may reach org B — RANK IS CAPPED ELSEWHERE", async () => {
    seedMemberships([ORG_A, ORG_B]);
    const me = await resolveMe(impersonatedSession, ORG_B);

    expect(me.organizationId).toBe(ORG_B);
    // Assuming the target's authority INSIDE the admin's own tenancy is the
    // point of impersonation, so it must survive.
    expect(me.permissions).toContain("admin.roles.update");

    // READ THIS BEFORE TREATING THE LINE ABOVE AS A STATEMENT OF INTENT.
    //
    // This resolver enforces TENANCY, not RANK, and on its own that is not
    // enough (IMP-2). Shared membership does not imply shared authority: an
    // admin of org A who is an ordinary ROLE-LESS member of org B would land
    // here too, holding the target's `admin.roles.update` in a tenant where
    // they have none themselves — the original escalation, merely narrowed
    // from "any tenant the target belongs to" to "any tenant they SHARE".
    //
    // What makes reaching org B legitimate is that
    // `POST /api/administrator/users/[id]/impersonate` has already refused
    // every actor who does NOT hold, in org B itself, everything the target
    // holds there. That per-tenant bound is pinned in
    // tests/integration/administrator-phase7.test.ts ("refuses a target who
    // out-ranks the actor in a tenant they SHARE"); the data source it reads
    // is pinned in tests/unit/grantable-permissions-by-active-org.test.ts.
    // Do not relax either one on the strength of this assertion.
  });

  it("IMP-2: a SUPERADMIN impersonator reaches a tenant they are not a member of", async () => {
    // The platform operator's primary support path, which the IMP-1 membership
    // intersection turned into a dead session: a superadmin reaches every
    // tenant AS THEMSELVES (that is what `hasCrossOrgReach` and `canAccessUser`
    // answer, and `POST /api/administrator/organizations` never enrols the
    // creator), so measuring their reach by membership rows resolved nothing at
    // all — 403 everywhere, and a redirect to a page outside the secure layout
    // that renders neither the Stop control nor a sign-out button.
    //
    // This cannot reopen the pivot: the attack needs a NON-superadmin actor,
    // because a superadmin already holds every permission in every org and has
    // nothing to escalate to.
    seedMemberships([]); // not a member of ORG_A or ORG_B — or of anything
    superusers.add("ba-admin");

    const me = await resolveMe(impersonatedSession, ORG_B);

    expect(me.organizationId).toBe(ORG_B);
    expect(me.permissions).toContain("admin.roles.update");
  });

  it("IMP-2: a NON-superadmin in exactly that position still resolves nothing", async () => {
    // The control that keeps the exemption from being a hole: identical
    // fixture, an ordinary admin behind the session, and the account guard
    // refuses outright.
    seedMemberships([]);
    getCurrentSession.mockResolvedValue(impersonatedSession);
    cookieValue.mockImplementation((name: string) => (name === "active_org" ? ORG_B : undefined));
    const { GET } = await import("@/app/api/v1/me/route");

    expect((await GET(meRequest())).status).toBe(403);
  });

  it("F-08: a BANNED superadmin's borrowed session resolves nothing", async () => {
    // The containment scenario. A peer bans the compromised superadmin S while
    // S is impersonating a customer. The ban leaves S's role, membership and
    // `app_users` rows untouched, so without F-08 S still read as a global
    // superuser and the borrowed session kept its UNCONFINED reach — the case
    // just above. The ban must win.
    seedMemberships([]);
    superusers.add("ba-admin");
    banned.add("ba-admin");
    getCurrentSession.mockResolvedValue(impersonatedSession);
    cookieValue.mockImplementation((name: string) => (name === "active_org" ? ORG_B : undefined));
    const { GET } = await import("@/app/api/v1/me/route");

    expect((await GET(meRequest())).status).toBe(403);
  });

  it("F-08: …and so does a banned org admin's, inside their own tenant", async () => {
    // Same-tenant impersonation (the control below) with the admin banned.
    banned.add("ba-admin");
    getCurrentSession.mockResolvedValue(impersonatedSession);
    cookieValue.mockImplementation((name: string) => (name === "active_org" ? ORG_A : undefined));
    const { GET } = await import("@/app/api/v1/me/route");

    expect((await GET(meRequest())).status).toBe(403);
  });

  it("ordinary same-tenant impersonation is unaffected", async () => {
    const me = await resolveMe(impersonatedSession, ORG_A);

    expect(me.organizationId).toBe(ORG_A);
    // `shell.view` is implied by an active membership.
    expect(me.permissions).toContain("shell.view");
  });
});
