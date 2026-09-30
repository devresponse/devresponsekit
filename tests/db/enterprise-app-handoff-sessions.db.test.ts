import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-82: disabling or deleting an enterprise application
 * ends the SSO handoff sessions it opened, where this deployment's `session`
 * table holds them.
 *
 * A handoff used to open an ordinary rolling session, and nothing tied it to
 * the application: disabling the app refused new launches and ended nothing.
 * On a consumer that shares the primary's database (the reference forks, the
 * demo fleet), those sessions sit in this very table. They are now opened by
 * the real `createSsoSession` with a token naming the application
 * (`sso.<hex id>.`), and the enterprise-app PATCH (to `disabled`) and DELETE
 * delete them through Better Auth's adapter, whose `starts_with` is a `LIKE`.
 *
 * The sibling apps are the point of the Postgres run: one id differs from the
 * target only where the target has `_` (a `LIKE` wildcard), and one extends
 * the target's id with `.crm`, so a plain-text prefix would match both. Only
 * the caller is stubbed; sessions are asked of Better Auth itself
 * (`internalAdapter.findSession`, the lookup behind every cookie).
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f82_`
 * (app ids `dbtest-f82…`, since an app id must start with a letter or digit)
 * and clean up after themselves; audit rows go through the sanctioned
 * retention GUC.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const { auth } = await import("@/lib/auth");
const { consumeSsoHandoffNonce } = await import("@/lib/sso.server");
const { PATCH, DELETE } = await import("@/app/api/administrator/enterprise-apps/[id]/route");

const PREFIX = "__dbtest_f82_";
const RUN = randomUUID().slice(0, 8);
/** The app being disabled or deleted. */
const APP_ID = `dbtest-f82_${RUN}`;
/** Differs from APP_ID only where APP_ID has `_`, which `LIKE` reads as any character. */
const DASH_TWIN = `dbtest-f82-${RUN}`;
/** Starts with APP_ID followed by a dot, as an org-namespaced id does. */
const EXTENSION = `dbtest-f82_${RUN}.crm`;
/** Plain text (no FK): the actor identity, and how cleanup finds its audit rows. */
const ACTOR = `${PREFIX}admin`;
const BA_USER = `${PREFIX}ba_${RUN}`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-f82-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.apps.manage", "superuser"],
};

function req(method: "PATCH" | "DELETE", id: string, body?: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator/enterprise-apps/${id}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(body ? { "content-type": "application/json" } : {}),
    method,
    json: async () => body,
  } as unknown as NextRequest;
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "like", `${PREFIX}%`)
      .execute();
  });
  await db.deleteFrom("app_sso_handoff_nonces").where("jti", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", "dbtest-f82%").execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await pgPool.query(`delete from "session" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
}

async function newApp(id: string): Promise<void> {
  await db
    .insertInto("app_enterprise_applications")
    .values({
      id,
      organization_id: null,
      label: `DBTest ${id}`,
      origin: `https://${id.replace(/[._]/g, "-")}.example.com`,
      subdomain: id.replace(/[._]/g, "-"),
      sso_audience: `devresponse-app:${id}`,
      status: "available",
    })
    .execute();
}

/** A handoff session as the consume route opens it; returns its token. */
async function handoffSession(applicationId: string): Promise<string> {
  const before = new Set(await tokensOf(BA_USER));
  await auth.api.createSsoSession({
    body: { userId: BA_USER, applicationId },
    headers: new Headers(),
  });
  const [token] = (await tokensOf(BA_USER)).filter((t) => !before.has(t));
  if (!token) throw new Error("createSsoSession opened no session");
  return token;
}

/** A session from any other sign-in: Better Auth's own random token. */
async function ordinarySession(): Promise<string> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(BA_USER);
  return session.token;
}

async function tokensOf(userId: string): Promise<string[]> {
  const { rows } = await pgPool.query<{ token: string }>(
    `select token from "session" where "userId" = $1`,
    [userId],
  );
  return rows.map((r) => r.token);
}

/** Whether Better Auth would still accept this session token. */
async function valid(token: string): Promise<boolean> {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.findSession(token)) !== null;
}

async function inFlightNonce(jti: string, appId: string, appUserId: string): Promise<string> {
  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti: `${PREFIX}${jti}`,
      app_user_id: appUserId,
      target_application_id: appId,
      expires_at: new Date(Date.now() + 60_000),
    })
    .execute();
  return `${PREFIX}${jti}`;
}

async function appAudit(eventType: string) {
  return db
    .selectFrom("app_audit_events")
    .select(["target_application_id", "metadata"])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .where("event_type", "=", eventType)
    .execute();
}

let appUserId = "";

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);

  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'F82 user', $2, true, now(), now())`,
    [BA_USER, `${PREFIX}${RUN}@dbtest.local`],
  );
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: BA_USER,
      primary_email: `${PREFIX}${RUN}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  appUserId = row.id;
  for (const id of [APP_ID, DASH_TWIN, EXTENSION]) await newApp(id);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("PATCH status=disabled ends the app's handoff sessions (DB-backed, F-82)", () => {
  it("deletes this app's handoff sessions only, and expires its handoffs in flight", async () => {
    const mine = [await handoffSession(APP_ID), await handoffSession(APP_ID)];
    const twin = await handoffSession(DASH_TWIN);
    const extension = await handoffSession(EXTENSION);
    const ordinary = await ordinarySession();
    const myNonce = await inFlightNonce("mine", APP_ID, appUserId);
    const twinNonce = await inFlightNonce("twin", DASH_TWIN, appUserId);
    for (const token of [...mine, twin, extension, ordinary]) expect(await valid(token)).toBe(true);

    const res = await PATCH(req("PATCH", APP_ID, { status: "disabled" }), {
      params: Promise.resolve({ id: APP_ID }),
    });

    // Before F-82: 200, and every one of these sessions still valid.
    expect(res.status, await res.text()).toBe(200);
    for (const token of mine) expect(await valid(token)).toBe(false);
    expect(await valid(twin)).toBe(true);
    expect(await valid(extension)).toBe(true);
    expect(await valid(ordinary)).toBe(true);
    // A handoff launched just before the disable cannot open a session after it.
    expect(await consumeSsoHandoffNonce(myNonce, APP_ID)).toBe("expired");
    expect(await consumeSsoHandoffNonce(twinNonce, DASH_TWIN)).toBe("consumed");

    const [audit] = await appAudit("admin.app.updated");
    expect(audit).toMatchObject({
      target_application_id: APP_ID,
      metadata: { endedSsoSessions: 2 },
    });
  });

  it("ends nothing on a save that does not disable the app", async () => {
    const mine = await handoffSession(APP_ID);

    const res = await PATCH(req("PATCH", APP_ID, { label: "Renamed" }), {
      params: Promise.resolve({ id: APP_ID }),
    });

    expect(res.status, await res.text()).toBe(200);
    expect(await valid(mine)).toBe(true);
  });
});

describe("DELETE ends the app's handoff sessions (DB-backed, F-82)", () => {
  it("deletes this app's handoff sessions with the app, and no one else's", async () => {
    const mine = await handoffSession(EXTENSION);
    const shorter = await handoffSession(APP_ID);
    const ordinary = await ordinarySession();

    const res = await DELETE(req("DELETE", EXTENSION), {
      params: Promise.resolve({ id: EXTENSION }),
    });

    expect(res.status, await res.text()).toBe(200);
    expect(await valid(mine)).toBe(false);
    expect(await valid(shorter)).toBe(true);
    expect(await valid(ordinary)).toBe(true);
    const [audit] = await appAudit("admin.app.deleted");
    expect(audit).toMatchObject({
      target_application_id: EXTENSION,
      metadata: { endedSsoSessions: 1 },
    });
  });
});
