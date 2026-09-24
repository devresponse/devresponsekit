import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as GrantableModule from "@/lib/admin/grantable-permissions.server";

/**
 * Integration tests for the Phase 7 endpoints
 * (docs/admin-manager.md §19 Phase 7):
 *
 *   - POST/DELETE /api/administrator/users/[id]/impersonate
 *   - POST        /api/administrator/users/bulk
 *   - GET         /api/administrator/export/[resource]
 *
 * These pin the cross-cutting handler contract — permission gate,
 * rate-limit guard, audit row written on success — using the same
 * mock surface as the existing `administrator-user-actions.test.ts`.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbMock = vi.fn();
const authImpersonate = vi.fn();
const authStopImpersonate = vi.fn();
const authBan = vi.fn();
const authUnban = vi.fn();
/**
 * IMP-1: the impersonation escalation guard no longer reads the target's
 * context in ONE org (which depended on the actor's `active_org` cookie) — it
 * compares against the UNION of the target's authority across every org they
 * are an active member of. Mocked here so a test can state that union
 * directly; the query's own predicates are pinned in
 * tests/unit/grantable-permissions-any-org.test.ts.
 */
const heldAnyOrg = vi.fn();
/**
 * IMP-2: the union above is compared against the actor's authority in ONE org,
 * so it never notices a target who out-ranks the actor in a tenant the two
 * SHARE. The guard now also compares tenant by tenant, reading both parties'
 * authority from `permissionKeysByActiveOrg`. Mocked here so a test can state
 * each side's per-tenant authority directly; the query's own predicates are
 * pinned in tests/unit/grantable-permissions-by-active-org.test.ts.
 */
const heldByOrg = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  // Lightweight stand-in for the real helper (which lives in the heavy
  // auth-guard module): reads `session.session.impersonatedBy`.
  getImpersonatorId: (
    s: { session?: { impersonatedBy?: string | null; impersonated_by?: string | null } } | null,
  ) => s?.session?.impersonatedBy ?? s?.session?.impersonated_by ?? null,
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/admin/grantable-permissions.server", async () => {
  const actual = await vi.importActual<typeof GrantableModule>(
    "@/lib/admin/grantable-permissions.server",
  );
  return {
    ...actual,
    permissionKeysHeldInAnyOrg: (...a: unknown[]) => heldAnyOrg(...a),
    permissionKeysByActiveOrg: (...a: unknown[]) => heldByOrg(...a),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  impersonateBetterAuthUser: (...a: unknown[]) => authImpersonate(...a),
  stopBetterAuthImpersonating: (...a: unknown[]) => authStopImpersonate(...a),
  banBetterAuthUser: (...a: unknown[]) => authBan(...a),
  unbanBetterAuthUser: (...a: unknown[]) => authUnban(...a),
  setBetterAuthUserPassword: vi.fn(),
  sendBetterAuthPasswordResetEmail: vi.fn(),
  setBetterAuthUserRole: vi.fn(),
  listBetterAuthUserSessions: vi.fn(),
  revokeBetterAuthUserSession: vi.fn(),
  revokeAllBetterAuthUserSessions: vi.fn(),
  createBetterAuthUser: vi.fn(),
  updateBetterAuthUser: vi.fn(),
}));
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: vi.fn(async () => ({ ok: true, status: "active" })),
}));

// ---- DB stubbing (matches the pattern used by administrator-user-actions). --
function makeChain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "executeTakeFirst") return dbMock;
      if (prop === "executeTakeFirstOrThrow") return dbMock;
      if (prop === "execute") return () => Promise.resolve(dbExecuteResult);
      return (..._args: unknown[]) => makeChain();
    },
  };
  return new Proxy({}, handler);
}
let dbExecuteResult: unknown[] = [];

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => makeChain(),
    updateTable: () => makeChain(),
    insertInto: () => makeChain(),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({ updateTable: () => makeChain(), insertInto: () => makeChain() }),
    }),
  },
}));

vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return actual;
});

const TARGET_ID = "11111111-1111-4111-8111-111111111101";
const ACTOR_ID = "22222222-2222-4222-8222-222222222202";

const targetRow = {
  id: TARGET_ID,
  better_auth_user_id: "ba-target",
  primary_email: "target@example.com",
  display_name: "Target",
  status: "active",
};

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers(init.headers ?? {}),
    json: async () => (init.body ? JSON.parse(init.body as string) : {}),
    method: init.method ?? "GET",
  } as unknown as NextRequest;
}

const grantedAccess = (perm: string) => ({
  appUserId: "u-self",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [perm],
});

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  dbMock.mockReset();
  authImpersonate.mockReset();
  authStopImpersonate.mockReset();
  authBan.mockReset();
  authUnban.mockReset();
  heldAnyOrg.mockReset();
  // Default: the target holds nothing anywhere, so the union guard never
  // refuses unless a test says the target holds something.
  heldAnyOrg.mockResolvedValue([]);
  heldByOrg.mockReset();
  // Default: neither party holds anything in any tenant, so the per-tenant
  // bound never refuses unless a test builds the shape.
  heldByOrg.mockResolvedValue(new Map<string, Set<string>>());
  dbExecuteResult = [];
  const rl = await import("@/lib/admin/rate-limit.server");
  rl.__resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

/* -------------------------------------------------------------------------- */
/*  Impersonation                                                             */
/* -------------------------------------------------------------------------- */

describe("POST /api/administrator/users/[id]/impersonate", () => {
  const importRoute = () => import("@/app/api/administrator/users/[id]/impersonate/route");
  const url = `http://test.local/api/administrator/users/${TARGET_ID}/impersonate`;

  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 + denied audit when caller lacks admin.users.impersonate", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects self-impersonation with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-target" } }); // same as targetRow
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_impersonate_self");
    expect(authImpersonate).not.toHaveBeenCalled();
  });

  it("starts impersonation and audits success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(authImpersonate).toHaveBeenCalledWith("ba-target", expect.anything());
    // The impersonated-session cookies are delivered by Better Auth's
    // nextCookies plugin during the impersonateUser call, NOT forwarded by the
    // route — so the route returns a plain ok body (P3-1: the old manual
    // Set-Cookie loop was dead, since the helper omits returnHeaders).
    expect(await res.json()).toEqual({ ok: true });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_started",
        outcome: "success",
      }),
    );
  });

  /**
   * F-02 — no nested impersonation. The borrowed session's tenant confinement
   * is its IMPERSONATOR's reach; impersonating again from it would make Better
   * Auth stamp the BORROWED identity as `impersonatedBy`, re-basing the next
   * session's confinement on that identity's (wider) reach.
   */
  describe("F-02: impersonation cannot start from an impersonated session", () => {
    const impersonatedSession = {
      user: { id: "ba-borrowed" }, // co-admin X, borrowed by the root admin
      session: { impersonatedBy: "ba-root-admin" },
    };

    it("refuses (403), before touching the target, audited against the HUMAN", async () => {
      sessionGetter.mockResolvedValue(impersonatedSession);
      accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
      dbMock.mockResolvedValue(targetRow);
      const { POST } = await importRoute();

      const res = await POST(makeRequest(url, { method: "POST" }), {
        params: Promise.resolve({ id: TARGET_ID }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden_while_impersonating");
      expect(authImpersonate).not.toHaveBeenCalled();
      expect(heldAnyOrg).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "admin.user.impersonation_failed",
          outcome: "denied",
          reason: "nested_impersonation",
          actorBetterAuthUserId: "ba-root-admin",
          metadata: expect.objectContaining({ requestedTargetId: TARGET_ID }),
        }),
      );
    });

    it("records no untrusted path segment in the audit row", async () => {
      sessionGetter.mockResolvedValue(impersonatedSession);
      accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
      const { POST } = await importRoute();

      const res = await POST(makeRequest(url, { method: "POST" }), {
        params: Promise.resolve({ id: "not-a-uuid " }),
      });

      expect(res.status).toBe(403);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "nested_impersonation",
          metadata: expect.objectContaining({ requestedTargetId: null }),
        }),
      );
    });

    it("refuses when the cookie Better Auth will act on is a DIFFERENT principal than the guards evaluated", async () => {
      sessionGetter
        .mockResolvedValueOnce({ user: { id: ACTOR_ID } })
        .mockResolvedValue({ user: { id: "ba-someone-else" } });
      accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
      dbMock.mockResolvedValue(targetRow);
      const { POST } = await importRoute();

      const res = await POST(makeRequest(url, { method: "POST" }), {
        params: Promise.resolve({ id: TARGET_ID }),
      });

      expect(res.status).toBe(403);
      expect(authImpersonate).not.toHaveBeenCalled();
      expect(((await res.json()) as { error?: string; reason?: string }).reason).toBe(
        "session_principal_mismatch",
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "denied", reason: "session_principal_mismatch" }),
      );
    });

    it("refuses a caller with no cookie session at all (a bearer credential) with 403, never a 502 (F-13)", async () => {
      // Impersonation is the one cookie-session-only admin action: Better Auth
      // acts on the caller's own session cookie and hands back a new one. The
      // guard admits a bearer caller, so the route refuses it here, before the
      // plugin could fail on the missing cookie.
      sessionGetter.mockResolvedValueOnce({ user: { id: ACTOR_ID } }).mockResolvedValue(null);
      accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
      dbMock.mockResolvedValue(targetRow);
      const { POST } = await importRoute();

      const res = await POST(makeRequest(url, { method: "POST" }), {
        params: Promise.resolve({ id: TARGET_ID }),
      });

      expect(res.status).toBe(403);
      expect(authImpersonate).not.toHaveBeenCalled();
      expect(((await res.json()) as { reason?: string }).reason).toBe("session_principal_mismatch");
    });

    it("refuses when the COOKIE Better Auth will act on is borrowed, even if the guard's caller was not", async () => {
      // Defence in depth: the guard resolves one principal (e.g. a bearer
      // credential it prefers), but Better Auth's impersonateUser acts on the
      // session cookie. The route re-reads that cookie before handing off.
      sessionGetter
        .mockResolvedValueOnce({ user: { id: ACTOR_ID } })
        .mockResolvedValue(impersonatedSession);
      accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
      dbMock.mockResolvedValue(targetRow);
      const { POST } = await importRoute();

      const res = await POST(makeRequest(url, { method: "POST" }), {
        params: Promise.resolve({ id: TARGET_ID }),
      });

      expect(res.status).toBe(403);
      expect(authImpersonate).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "nested_impersonation",
          actorBetterAuthUserId: "ba-root-admin",
        }),
      );
    });
  });

  it("audits failure and returns 502 when Better Auth throws", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockRejectedValue(new Error("boom"));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
      }),
    );
  });

  // test-2: the privilege-escalation guard. Impersonation grants the actor
  // the target's session, so a NON-superadmin must not assume a session that
  // carries a permission they themselves lack (e.g. an org admin assuming a
  // SUPERADMIN). The attempt must be rejected 403 and audited.
  it("blocks a non-superadmin from impersonating a more-privileged target (403 + audit)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    // Actor (ACTOR_ID) holds impersonate but NOT superuser; the target
    // additionally holds superuser — a permission the actor lacks.
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    heldAnyOrg.mockResolvedValue(["admin.users.impersonate", "superuser"]);
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
        reason: "privilege_escalation",
      }),
    );
  });

  /**
   * MACHINE-2. Impersonation is the one admin action that converts the caller's
   * authority into a different KIND of credential: it returns a COOKIE session
   * for the target, and a cookie session is not org-bound. An ORG-BOUND bearer
   * credential that could perform it would launder itself into exactly the
   * unbounded reach MACHINE-2 denies.
   *
   * The subset check below cannot catch the case that matters: a bound
   * SUPERUSER credential's `permissions` is the whole ADMIN_PERMISSION_CATALOG
   * (getUserAccessContext expands the marker on the bound path too), so
   * `targetPermissions.some(p => !actorPermissions.has(p))` is
   * structurally unsatisfiable and every target passes. Hence the outright
   * refusal, pinned here for both actor shapes.
   */
  it("MACHINE-2: refuses an ORG-BOUND credential outright (403 + audit)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_ID
        ? { ...grantedAccess("admin.users.impersonate"), orgBound: true }
        : { ...grantedAccess("admin.users.read"), permissions: ["admin.users.read"] },
    );
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
        reason: "org_bound_credential",
      }),
    );
  });

  it("MACHINE-2: refuses an ORG-BOUND SUPERUSER credential, which the subset check cannot", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_ID
        ? {
            ...grantedAccess("admin.users.impersonate"),
            // The expanded set a bound superuser credential really carries: a
            // superset of any target's, so `escalates` would be false.
            permissions: ["admin.users.impersonate", "admin.users.read", "superuser"],
            orgBound: true,
          }
        : {
            ...grantedAccess("admin.users.read"),
            permissions: ["admin.users.read", "superuser"],
          },
    );
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
  });

  // Inverse: a non-superadmin actor whose permissions are a strict superset
  // of the target's is NOT escalating, so impersonation proceeds.
  it("allows a non-superadmin to impersonate a less-privileged (subset) target", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue({
      ...grantedAccess("admin.users.impersonate"),
      permissions: ["admin.users.impersonate", "admin.users.read"],
    });
    heldAnyOrg.mockResolvedValue(["admin.users.read"]);
    dbMock.mockResolvedValue(targetRow);
    const cookieHeaders = new Headers();
    cookieHeaders.append("set-cookie", "ba.session=imp; Path=/; HttpOnly");
    authImpersonate.mockResolvedValue({ headers: cookieHeaders });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(authImpersonate).toHaveBeenCalledWith("ba-target", expect.anything());
  });

  /**
   * IMP-1. The exact shape the old single-org check missed: the target holds
   * NOTHING in the actor's org (so the pre-fix guard, which read the target's
   * context in the actor's `active_org`, saw an empty permission set and let
   * the impersonation start) but is an ADMIN of a tenant the actor knows
   * nothing about. The session handed back would have been pivotable into that
   * tenant by rewriting the unsigned `active_org` cookie.
   *
   * The guard now asks for the target's authority across EVERY org they are an
   * active member of, and refuses on the first permission the actor lacks.
   */
  it("IMP-1: refuses when the target holds a permission the actor lacks in ANY org", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    // Nothing in the actor's org; `admin.roles.update` in another tenant.
    heldAnyOrg.mockResolvedValue(["shell.view", "admin.roles.update"]);
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });

    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
    // The union is asked for by APP USER id (the `[id]` segment), not the
    // Better Auth id, and never carries an org — that is the whole point.
    expect(heldAnyOrg).toHaveBeenCalledWith(TARGET_ID);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
        reason: "privilege_escalation",
      }),
    );
  });

  /**
   * IMP-2. The union above and the tenant confinement in `getUserAccessContext`
   * were believed to cover each other; they measure different axes and so never
   * intersect. The confinement caps WHICH tenants a borrowed session may
   * resolve (the impersonator's own) and says nothing about rank inside them,
   * while the union compares the target's cross-org total against the actor's
   * authority in ONE org — their active one. The seam between them:
   *
   *   actor  — admin of ORG_A, ordinary ROLE-LESS member of ORG_B
   *   target — plain member of ORG_A, ADMIN of ORG_B
   *
   * The union passes (the actor's org-A set is a superset of the target's
   * total), the confinement ADMITS org B (the actor really is a member), and
   * rewriting the unsigned `active_org` cookie lands a session holding
   * `admin.roles.update` in a tenant the actor has no authority in.
   *
   * These two drive the shape through the real handler with only the two
   * authority lookups stubbed.
   */
  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  /** Per-tenant authority for the target and the actor, by app-user id. */
  function byOrgFixture(target: Record<string, string[]>, actor: Record<string, string[]>) {
    const toMap = (spec: Record<string, string[]>) =>
      new Map(Object.entries(spec).map(([org, keys]) => [org, new Set(keys)]));
    heldByOrg.mockImplementation(async (appUserId: string) =>
      toMap(appUserId === TARGET_ID ? target : actor),
    );
  }

  it("IMP-2: refuses a target who out-ranks the actor in a tenant they SHARE", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue({
      ...grantedAccess("admin.users.impersonate"),
      // The actor's authority in their ACTIVE org — a superset of the target's
      // cross-org union, which is exactly why the union guard waves this
      // through and something else has to refuse it.
      permissions: ["admin.users.impersonate", "admin.users.read", "admin.roles.update"],
    });
    heldAnyOrg.mockResolvedValue(["admin.users.read", "admin.roles.update"]);
    byOrgFixture(
      // Target: nothing in A, an admin in B.
      { [ORG_A]: [], [ORG_B]: ["admin.users.read", "admin.roles.update"] },
      // Actor: an admin in A, an active member of B holding NOTHING there.
      {
        [ORG_A]: ["admin.users.impersonate", "admin.users.read", "admin.roles.update"],
        [ORG_B]: [],
      },
    );
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });

    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
    // Both parties are measured, and by APP USER id.
    expect(heldByOrg).toHaveBeenCalledWith(TARGET_ID);
    expect(heldByOrg).toHaveBeenCalledWith("u-self");
    const refusal = auditMock.mock.calls
      .map(([row]) => row as { reason?: string })
      .find((row) => row.reason === "privilege_escalation_in_shared_org");
    expect(refusal).toMatchObject({
      eventType: "admin.user.impersonation_failed",
      outcome: "failure",
      // A reason of its own: the union guard's `privilege_escalation` would
      // hide which of the two bounds fired.
      reason: "privilege_escalation_in_shared_org",
      // F-32: filed under the actor's org (their active one, "o-1")…
      organizationId: "o-1",
      // …so it says HOW MANY shared tenants the target outranks them in, and
      // never WHICH. Org B can never be the actor's own org here (the union
      // above would have refused first), so its id is always another tenant's,
      // and every auditor of the actor's org would read it.
      metadata: { targetBetterAuthUserId: "ba-target", outrankedOrgCount: 1 },
    });
    expect(JSON.stringify(refusal)).not.toContain(ORG_B);
  });

  it("IMP-2: allows it when the actor holds the same authority in that shared tenant", async () => {
    // The control. Same fixture except the actor is an admin of org B too, so
    // the borrowed session can reach nothing they could not reach themselves —
    // which is the whole invariant, and must not be broken by refusing
    // everyone.
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue({
      ...grantedAccess("admin.users.impersonate"),
      permissions: ["admin.users.impersonate", "admin.users.read", "admin.roles.update"],
    });
    heldAnyOrg.mockResolvedValue(["admin.users.read", "admin.roles.update"]);
    byOrgFixture(
      { [ORG_A]: [], [ORG_B]: ["admin.users.read", "admin.roles.update"] },
      {
        [ORG_A]: ["admin.users.impersonate"],
        [ORG_B]: ["admin.users.read", "admin.roles.update"],
      },
    );
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });

    expect(res.status).toBe(200);
    expect(authImpersonate).toHaveBeenCalledWith("ba-target", expect.anything());
  });

  it("IMP-2: a tenant the ACTOR does not belong to is not judged here", async () => {
    // The per-tenant bound deliberately says nothing about an org the actor is
    // not an active member of: the confinement already makes it unreachable,
    // and judging it would re-impose the union's blanket refusal twice over.
    // (The one target that would escape both — a GLOBAL SUPERUSER, whose
    // marker expands for the principal wherever the session lands — is refused
    // by the union, which is why that check stays.)
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue({
      ...grantedAccess("admin.users.impersonate"),
      permissions: ["admin.users.impersonate", "admin.reports.read"],
    });
    heldAnyOrg.mockResolvedValue(["admin.reports.read"]);
    byOrgFixture(
      { [ORG_A]: [], [ORG_B]: ["admin.reports.read"] },
      { [ORG_A]: ["admin.users.impersonate", "admin.reports.read"] }, // no ORG_B membership
    );
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });

    expect(res.status).toBe(200);
  });

  it("IMP-1: a SUPERADMIN actor still skips the union check entirely", async () => {
    // The union is strictly more refusing than the old single-org check, so the
    // superadmin exemption has to keep working or support loses the escape
    // hatch for every rank refusal.
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue({
      ...grantedAccess("admin.users.impersonate"),
      permissions: ["admin.users.impersonate", "superuser"],
    });
    heldAnyOrg.mockResolvedValue(["superuser", "admin.roles.update"]);
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });

    expect(res.status).toBe(200);
    expect(heldAnyOrg).not.toHaveBeenCalled();
    // …and the per-tenant bound with it: a superadmin holds every permission
    // in every org, so there is no rank to escalate to (IMP-2).
    expect(heldByOrg).not.toHaveBeenCalled();
  });
});

/**
 * F-32: impersonation rows are filed under the tenant it happened in, so the
 * org whose member was borrowed sees both ends. A delegated admin's start is
 * stamped with their org; a superadmin's is a platform row (its active org
 * says nothing about the target's tenant); the stop, which has no guard to
 * resolve a scope from, reuses the org its start row was filed under.
 */
describe("impersonation audit organization (F-32)", () => {
  const importRoute = () => import("@/app/api/administrator/users/[id]/impersonate/route");
  const url = `http://test.local/api/administrator/users/${TARGET_ID}/impersonate`;

  const startWith = async (access: ReturnType<typeof grantedAccess>) => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(access);
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    return POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
  };

  it("stamps a delegated admin's start with their org", async () => {
    const res = await startWith(grantedAccess("admin.users.impersonate"));
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_started",
        appUserId: TARGET_ID,
        organizationId: "o-1",
      }),
    );
  });

  it("files a superadmin's start as a platform row, not under its active org", async () => {
    const res = await startWith({
      ...grantedAccess("admin.users.impersonate"),
      permissions: ["admin.users.impersonate", "superuser"],
    });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_started",
        organizationId: null,
      }),
    );
  });

  it("stamps a refusal with the actor's org", async () => {
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    heldAnyOrg.mockResolvedValue(["admin.users.impersonate", "superuser"]);
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        reason: "privilege_escalation",
        organizationId: "o-1",
      }),
    );
  });

  it("files the stop under the org its start row was filed under", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" },
      session: { impersonatedBy: ACTOR_ID },
    });
    // 1st read: the impersonated user's row; 2nd: the latest start row.
    dbMock.mockResolvedValueOnce(targetRow).mockResolvedValueOnce({ organization_id: "o-1" });
    authStopImpersonate.mockResolvedValue({ headers: new Headers() });
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(dbMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_stopped",
        actorBetterAuthUserId: ACTOR_ID,
        appUserId: TARGET_ID,
        organizationId: "o-1",
      }),
    );
  });

  it("files the stop as a platform row when no start row names an org", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" },
      session: { impersonatedBy: ACTOR_ID },
    });
    dbMock.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(undefined);
    authStopImpersonate.mockRejectedValue(new Error("down"));
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_stop_failed",
        organizationId: null,
      }),
    );
  });
});

describe("DELETE /api/administrator/users/[id]/impersonate", () => {
  const importRoute = () => import("@/app/api/administrator/users/[id]/impersonate/route");
  const url = `http://test.local/api/administrator/users/${TARGET_ID}/impersonate`;

  // Regression: while impersonating, the live session IS the target — usually
  // a plain member with NO admin permission. Stop must NOT gate on the
  // impersonated identity's permissions (that 403'd the admin and stranded
  // them in the impersonated view). Authority comes from the session carrying
  // `impersonatedBy`, and the action is audited against the ORIGINAL admin.
  it("stops impersonation for a non-admin impersonated session, audited against the original actor", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" }, // the impersonated member — no admin perms
      session: { impersonatedBy: ACTOR_ID }, // stamped by Better Auth at start
    });
    dbMock.mockResolvedValue(targetRow);
    authStopImpersonate.mockResolvedValue({ headers: new Headers() });
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(authStopImpersonate).toHaveBeenCalled();
    // Stop never consults the impersonated user's permissions.
    expect(accessGetter).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_stopped",
        outcome: "success",
        actorBetterAuthUserId: ACTOR_ID,
      }),
    );
  });

  it("returns 400 not_impersonating when the session is not an impersonation session", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } }); // no impersonatedBy
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_impersonating");
    expect(authStopImpersonate).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(401);
    expect(authStopImpersonate).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  Bulk                                                                       */
/* -------------------------------------------------------------------------- */

describe("POST /api/administrator/users/bulk", () => {
  const importRoute = () => import("@/app/api/administrator/users/bulk/route");
  const url = "http://test.local/api/administrator/users/bulk";

  it("returns 400 on missing/invalid body", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, { method: "POST", body: JSON.stringify({ action: "approve" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller lacks the action's permission", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "ban", ids: [TARGET_ID], reason: "spam" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects ids='*' without filters with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.delete"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "soft_delete", ids: "*" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("filters_required_for_select_all");
  });

  it("returns ok with empty result when no matching ids exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    // dbExecuteResult stays empty so the in-list lookup returns no rows.
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "approve", ids: [TARGET_ID] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempted).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toBe("not_found");
  });

  // bug-8: duplicate ids in the payload must be processed once. Zod's
  // .min/.max only bound element count, not uniqueness, so without dedup a
  // repeated id would double-count attempts (and double-audit / re-apply).
  it("deduplicates repeated ids — three copies of one id collapse to a single attempt", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "approve", ids: [TARGET_ID, TARGET_ID, TARGET_ID] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempted).toBe(1);
    expect(body.results).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /api/administrator/export/[resource]", () => {
  const importRoute = () => import("@/app/api/administrator/export/[resource]/route");

  it("returns 404 for an unknown resource", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/nope"), {
      params: Promise.resolve({ resource: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller lacks the resource's read permission", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.audit.read"));
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/users"), {
      params: Promise.resolve({ resource: "users" }),
    });
    expect(res.status).toBe(403);
  });

  it("streams CSV with correct headers when permitted", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    // Empty execute result — we just want the header row + closure.
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/users"), {
      params: Promise.resolve({ resource: "users" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    // Header row should be the first non-empty line.
    const firstLine = text.split("\n")[0];
    expect(firstLine).toBe(
      "id,better_auth_user_id,primary_email,display_name,status,preferred_locale,created_at,updated_at",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  CSV escape                                                                 */
/* -------------------------------------------------------------------------- */

describe("csvEscape", () => {
  it("quotes values containing commas, quotes, or newlines", async () => {
    const { csvEscape } = await import("@/app/api/administrator/export/[resource]/route");
    expect(csvEscape("simple")).toBe("simple");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(42)).toBe("42");
  });
});
