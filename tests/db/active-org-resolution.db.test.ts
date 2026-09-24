import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";

/**
 * DB-BACKED tests for F-33: which membership the SESSION resolves when a user
 * holds several, and the invitation accept that pins it.
 *
 * Before F-33 `getUserAccessContext` took the membership the `active_org`
 * cookie named, or else the earliest one, WHATEVER ITS STATUS. So:
 *   (a) U, active in orgs A and B, switched to B. B's admin — acting only in
 *       their own tenant — suspended U's B membership. Every request then
 *       resolved the suspended row and `decideSecureAccess` sent U to /blocked,
 *       locking U out of A as well, for up to the cookie's one-year life.
 *   (b) U signed up and was left `pending_approval` in the default org, then
 *       accepted an invitation into X. With no cookie the earliest row (the
 *       pending one) won, and the invite page's navigation landed on
 *       /pending-approval although U was an active member of X.
 * The fix ranks, in one statement: an ACTIVE membership first, then the
 * cookie's org, then the earliest. A non-active membership is still resolved
 * when there is nothing better, so a user with no active membership keeps
 * landing on /pending-approval or /blocked.
 *
 * Everything here runs the REAL resolver, and the real accept route, against
 * live Postgres (driven by `pnpm test:db`, see vitest.db.config.ts). Only the
 * cookie store, the session lookup, the shared rate limiter and the Better Auth
 * ban probe are stubbed. Fixtures use the `__dbtest_f33_` prefix and self-clean
 * (audit rows via the sanctioned retention GUC).
 */
const PREFIX = "__dbtest_f33_";

// The session path reads `active_org` through `next/headers`: the browser's
// (unsigned, user-controlled) cookie.
const cookie = vi.hoisted(() => ({ activeOrg: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "active_org" && cookie.activeOrg ? { value: cookie.activeOrg } : undefined,
  }),
}));

const sessionGetter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: async () => sessionGetter.current }));
// The accept route's per-user bucket lives in Postgres; its budget is not what
// this file tests, and a bypass leaves no bucket rows behind.
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  enforceSharedRateLimit: async () => null,
}));
// The impersonation reach asks Better Auth whether the impersonator is banned;
// nobody is here, and it keeps the Better Auth instance out of this suite.
vi.mock("@/lib/api-auth/ban-status.server", () => ({ isBetterAuthUserBanned: async () => false }));

const { db, pgPool } = await import("@/db/database");
const { decideSecureAccess, getUserAccessContext } = await import("@/lib/auth-status");
const { createInvitation } = await import("@/lib/invitations.server");
const acceptRoute = await import("@/app/api/invitations/accept/route");

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
  }
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name: `DBTest F33 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

interface Fixture {
  id: string;
  ba: string;
  email: string;
}

async function newUser(key: string): Promise<Fixture> {
  const ba = `${PREFIX}ba_${key}`;
  const email = `${PREFIX}${key}@dbtest.local`;
  const row = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: ba, primary_email: email, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, ba, email };
}

/** `created_at` is set explicitly so "earliest membership" is deterministic. */
async function addMembership(
  appUserId: string,
  organizationId: string,
  status: string,
  createdAt: string,
  id?: string,
): Promise<void> {
  await db
    .insertInto("app_organization_memberships")
    .values({
      ...(id ? { id } : {}),
      organization_id: organizationId,
      app_user_id: appUserId,
      status,
      created_at: sql`${createdAt}::timestamptz`,
    })
    .execute();
}

/** Membership ids for the tie: the HIGHER one is written first. */
const TWIN_HIGH_ID = "ffffffff-f33f-4f33-8f33-fffffffff033";
const TWIN_LOW_ID = "00000000-f33f-4f33-8f33-000000000033";

async function setMembershipStatus(
  appUserId: string,
  organizationId: string,
  status: string,
): Promise<void> {
  await db
    .updateTable("app_organization_memberships")
    .set({ status, updated_at: sql`now()` })
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .execute();
}

/** Resolves the SESSION path for `user` with the given `active_org` cookie. */
async function resolve(user: Fixture, activeOrg: string | null) {
  cookie.activeOrg = activeOrg;
  const ctx = await getUserAccessContext(user.ba);
  return { ctx, decision: decideSecureAccess(ctx.status, ctx.membershipStatus) };
}

const org = { a: "", b: "", c: "", dflt: "", x: "", y: "", twinP: "", twinQ: "" };
const u = {} as Record<
  | "multi"
  | "pendingThenInvited"
  | "onlySuspended"
  | "onlyPending"
  | "pendingAndSuspended"
  | "twins"
  | "admin"
  | "invitee"
  | "inviteeSuspended",
  Fixture
>;

beforeAll(async () => {
  await cleanup();

  for (const key of Object.keys(org) as (keyof typeof org)[]) org[key] = await newOrg(key);
  for (const key of [
    "multi",
    "pendingThenInvited",
    "onlySuspended",
    "onlyPending",
    "pendingAndSuspended",
    "twins",
    "admin",
    "invitee",
    "inviteeSuspended",
  ] as const) {
    u[key] = await newUser(key);
  }

  // (a) Active in A (earliest) and B. Each test sets B's status itself.
  await addMembership(u.multi.id, org.a, "active", "2020-01-01T00:00:00Z");
  await addMembership(u.multi.id, org.b, "active", "2021-01-01T00:00:00Z");
  // (b) Pending in the default org (earliest), active in X.
  await addMembership(
    u.pendingThenInvited.id,
    org.dflt,
    "pending_approval",
    "2020-01-01T00:00:00Z",
  );
  await addMembership(u.pendingThenInvited.id, org.x, "active", "2021-01-01T00:00:00Z");
  // No active membership anywhere: the last resort must still resolve one.
  await addMembership(u.onlySuspended.id, org.c, "suspended", "2020-01-01T00:00:00Z");
  await addMembership(u.onlyPending.id, org.dflt, "pending_approval", "2020-01-01T00:00:00Z");
  await addMembership(
    u.pendingAndSuspended.id,
    org.dflt,
    "pending_approval",
    "2020-01-01T00:00:00Z",
  );
  await addMembership(u.pendingAndSuspended.id, org.b, "suspended", "2021-01-01T00:00:00Z");
  // Two active memberships written at the same instant (one transaction), the
  // higher id first, so the order they were written in is not the id order.
  await addMembership(u.twins.id, org.twinP, "active", "2020-01-01T00:00:00Z", TWIN_HIGH_ID);
  await addMembership(u.twins.id, org.twinQ, "active", "2020-01-01T00:00:00Z", TWIN_LOW_ID);
  // An org admin of B only (for the impersonation case).
  await addMembership(u.admin.id, org.b, "active", "2020-01-01T00:00:00Z");
  // Invitation accept: already active in A; invited into Y below. The second
  // invitee's Y membership is SUSPENDED already — an administrator's denial,
  // which accepting an invitation does not lift.
  await addMembership(u.invitee.id, org.a, "active", "2020-01-01T00:00:00Z");
  await addMembership(u.inviteeSuspended.id, org.a, "active", "2020-01-01T00:00:00Z");
  await addMembership(u.inviteeSuspended.id, org.y, "suspended", "2021-01-01T00:00:00Z");
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-33 (a): a membership suspended in ONE org no longer locks the user out of the others", () => {
  it("active A + suspended B + cookie=B resolves to A, and A lets them in", async () => {
    await setMembershipStatus(u.multi.id, org.b, "suspended");
    try {
      const { ctx, decision } = await resolve(u.multi, org.b);
      expect(ctx.organizationId).toBe(org.a);
      expect(ctx.membershipStatus).toBe("active");
      expect(decision).toBe("allow");
    } finally {
      await setMembershipStatus(u.multi.id, org.b, "active");
    }
  });

  it.each(["blocked", "pending_approval"])(
    "…and the same for a B membership that is %s",
    async (status) => {
      await setMembershipStatus(u.multi.id, org.b, status);
      try {
        const { ctx, decision } = await resolve(u.multi, org.b);
        expect(ctx.organizationId).toBe(org.a);
        expect(decision).toBe("allow");
      } finally {
        await setMembershipStatus(u.multi.id, org.b, "active");
      }
    },
  );

  it("the control: while B is active, the cookie still selects B over the earlier A", async () => {
    const { ctx, decision } = await resolve(u.multi, org.b);
    expect(ctx.organizationId).toBe(org.b);
    expect(decision).toBe("allow");
  });

  it("reinstating B brings the user's own last choice back, with no cookie rewrite", async () => {
    await setMembershipStatus(u.multi.id, org.b, "suspended");
    try {
      expect((await resolve(u.multi, org.b)).ctx.organizationId).toBe(org.a);
    } finally {
      await setMembershipStatus(u.multi.id, org.b, "active");
    }
    expect((await resolve(u.multi, org.b)).ctx.organizationId).toBe(org.b);
  });

  it("a cookie that is not a UUID is ignored instead of failing the query (22P02)", async () => {
    // Postgres rejects a malformed `uuid` operand rather than matching nothing,
    // so this used to throw out of every secure render and API call.
    const { ctx, decision } = await resolve(u.multi, "not-a-uuid");
    expect(ctx.organizationId).toBe(org.a);
    expect(decision).toBe("allow");
  });
});

describe("F-33 (b): a pending membership in the default org no longer outranks an active one", () => {
  it("no cookie + pending default-org membership (earliest) + active X resolves to X", async () => {
    const { ctx, decision } = await resolve(u.pendingThenInvited, null);
    expect(ctx.organizationId).toBe(org.x);
    expect(ctx.membershipStatus).toBe("active");
    expect(decision).toBe("allow");
  });

  it("…even when the cookie names the pending org", async () => {
    const { ctx } = await resolve(u.pendingThenInvited, org.dflt);
    expect(ctx.organizationId).toBe(org.x);
  });
});

describe("F-33 last resort: with no active membership, a non-active one still resolves", () => {
  it("only a suspended membership: still the blocked outcome (with or without the cookie)", async () => {
    for (const activeOrg of [org.c, null]) {
      const { ctx, decision } = await resolve(u.onlySuspended, activeOrg);
      expect(ctx.organizationId).toBe(org.c);
      expect(ctx.membershipStatus).toBe("suspended");
      expect(decision).toBe("blocked");
    }
  });

  it("only a pending membership: still the pending-approval outcome", async () => {
    const { ctx, decision } = await resolve(u.onlyPending, null);
    expect(ctx.organizationId).toBe(org.dflt);
    expect(decision).toBe("pending_approval");
  });

  it("among non-active memberships the cookie, then the earliest, still decide", async () => {
    // Pending in the default org (earliest) and suspended in B.
    const named = await resolve(u.pendingAndSuspended, org.b);
    expect(named.ctx.organizationId).toBe(org.b);
    expect(named.decision).toBe("blocked");
    const earliest = await resolve(u.pendingAndSuspended, null);
    expect(earliest.ctx.organizationId).toBe(org.dflt);
    expect(earliest.decision).toBe("pending_approval");
  });
});

describe("F-33 determinism", () => {
  it("two active memberships with the same created_at resolve by id, every time", async () => {
    // Rows written by one transaction share now(). Without the `id` tiebreak
    // the winner is whatever order the plan returns them in, which need not be
    // the same from one request to the next.
    for (let i = 0; i < 5; i += 1) {
      expect((await resolve(u.twins, null)).ctx.organizationId).toBe(org.twinQ);
    }
  });

  it("an ORG-LESS credential breaks the same tie by id too", async () => {
    // The bearer path is not ranked by status, but it still takes "the
    // earliest", and a tie there must not let the credential act in one
    // tenant on this request and another on the next.
    cookie.activeOrg = org.twinP; // ignored on the bearer path (MACHINE-1)
    for (let i = 0; i < 5; i += 1) {
      const ctx = await getUserAccessContext(u.twins.ba, { organizationId: null });
      expect(ctx.organizationId).toBe(org.twinQ);
    }
  });
});

describe("F-33 does not touch the bearer paths or the impersonation confinement", () => {
  it("a credential BOUND to B, where the membership is suspended, fails closed — it never moves to A", async () => {
    await setMembershipStatus(u.multi.id, org.b, "suspended");
    try {
      cookie.activeOrg = org.a; // ignored on the bearer path (MACHINE-1)
      const ctx = await getUserAccessContext(u.multi.ba, { organizationId: org.b });
      expect(ctx.orgBound).toBe(true);
      expect(ctx.organizationId).toBe(org.b);
      expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).toBe("blocked");
    } finally {
      await setMembershipStatus(u.multi.id, org.b, "active");
    }
  });

  it("an ORG-LESS credential keeps its earliest membership even when that one is not active", async () => {
    // Deliberate: a non-active earliest MEMBERSHIP must stop the credential
    // rather than move it to X. (Suspending that org, or deleting the row,
    // does still move it on: F-09, pinned in organization-status.db.test.ts.)
    cookie.activeOrg = null;
    const ctx = await getUserAccessContext(u.pendingThenInvited.ba, { organizationId: null });
    expect(ctx.organizationId).toBe(org.dflt);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
  });

  it("an impersonated session is ranked only among the impersonator's orgs: suspended B, never A", async () => {
    // The admin reaches B alone. The target is active in A and suspended in B:
    // preferring an active membership must not reach outside the confinement.
    await setMembershipStatus(u.multi.id, org.b, "suspended");
    try {
      cookie.activeOrg = org.a;
      const ctx = await getUserAccessContext(u.multi.ba, undefined, {
        betterAuthUserId: u.admin.ba,
      });
      expect(ctx.organizationId).toBe(org.b);
      expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).toBe("blocked");
    } finally {
      await setMembershipStatus(u.multi.id, org.b, "active");
    }
  });
});

function acceptRequest(token: string): NextRequest {
  const url = new URL("http://localhost:3000/api/invitations/accept");
  return {
    method: "POST",
    url: url.toString(),
    nextUrl: url,
    headers: new Headers({
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "user-agent": "vitest",
    }),
    json: async () => ({ token }),
  } as unknown as NextRequest;
}

describe("F-33 invitation accept pins active_org to the org just joined", () => {
  it("an active member of A who accepts an invitation into Y lands in Y", async () => {
    const invitation = await createInvitation({ organizationId: org.y, email: u.invitee.email });
    sessionGetter.current = { user: { id: u.invitee.ba, email: u.invitee.email } };

    // Before: the resolver puts them in A, the only org they are in.
    expect((await resolve(u.invitee, null)).ctx.organizationId).toBe(org.a);

    const res = await acceptRoute.POST(acceptRequest(invitation.plaintextToken));
    expect(res.status).toBe(200);
    const pinned = res.cookies.get("active_org");
    expect(pinned?.value).toBe(org.y);
    expect(pinned?.httpOnly).toBe(true);

    // The browser now sends that cookie: the next request resolves Y. Without
    // it the earliest active membership, A, would still win.
    const after = await resolve(u.invitee, pinned!.value);
    expect(after.ctx.organizationId).toBe(org.y);
    expect(after.decision).toBe("allow");
    expect((await resolve(u.invitee, null)).ctx.organizationId).toBe(org.a);

    // Audited like every other write of the cookie.
    const rows = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "organization_id", "app_user_id", "metadata"])
      .where("actor_better_auth_user_id", "=", u.invitee.ba)
      .where("event_type", "=", "account.active_organization.changed")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: org.y,
      app_user_id: u.invitee.id,
      metadata: { organizationId: org.y, source: "invitation_accepted" },
    });
  });

  it("does not pin an org whose membership an administrator had suspended", async () => {
    const invitation = await createInvitation({
      organizationId: org.y,
      email: u.inviteeSuspended.email,
    });
    sessionGetter.current = {
      user: { id: u.inviteeSuspended.ba, email: u.inviteeSuspended.email },
    };

    const res = await acceptRoute.POST(acceptRequest(invitation.plaintextToken));
    // The invitation is consumed, but the denial stands…
    expect(res.status).toBe(200);
    const membership = await db
      .selectFrom("app_organization_memberships")
      .select("status")
      .where("app_user_id", "=", u.inviteeSuspended.id)
      .where("organization_id", "=", org.y)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe("suspended");
    // …so the cookie is not pointed at it, and the user stays in A.
    expect(res.cookies.get("active_org")).toBeUndefined();
    expect((await resolve(u.inviteeSuspended, null)).ctx.organizationId).toBe(org.a);
  });
});
