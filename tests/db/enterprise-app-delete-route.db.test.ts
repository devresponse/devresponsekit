import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-84: an enterprise app that has been launched can still
 * be deleted.
 *
 * Every SSO launch inserts an `app_sso_handoff_nonces` row naming the app,
 * under a foreign key with no ON DELETE action, and the only purge ran on the
 * next launch of some available app. So the usual way to retire an app,
 * disable it and then delete it, answered 409 `application_in_use`, and went on
 * answering it for as long as no other app was launched. The route suite stubs
 * the database and cannot show a foreign key refusing anything, so this file
 * drives the REAL `DELETE` handler against Postgres (only the caller is
 * stubbed) and asserts that the app and its own nonces go, another app's nonce
 * stays, and the deletion is audited.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_appdel_`
 * (the app ids `dbtest-appdel-…`, since an app id must start with a letter or
 * digit) and clean up after themselves; audit rows are append-only and go
 * through the sanctioned retention GUC.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const { DELETE } = await import("@/app/api/administrator/enterprise-apps/[id]/route");

const PREFIX = "__dbtest_appdel_";
const RUN = randomUUID().slice(0, 8);
const APP_ID = `dbtest-appdel-${RUN}`;
const OTHER_APP_ID = `dbtest-appdel-other-${RUN}`;
/** Plain text (no FK): the actor identity, and how cleanup finds its audit rows. */
const ACTOR = `${PREFIX}admin`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-appdel-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.apps.manage", "superuser"],
};

function deleteReq(id: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/enterprise-apps/${id}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "DELETE",
  } as unknown as NextRequest;
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  await db.deleteFrom("app_sso_handoff_nonces").where("jti", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_enterprise_applications")
    .where("id", "like", "dbtest-appdel-%")
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
}

async function newApp(id: string, status: "available" | "disabled"): Promise<void> {
  await db
    .insertInto("app_enterprise_applications")
    .values({
      id,
      organization_id: null,
      label: `DBTest ${id}`,
      origin: `https://${id}.example.com`,
      subdomain: id,
      sso_audience: `devresponse-app:${id}`,
      status,
    })
    .execute();
}

/** A nonce as a launch leaves it: `expiresInMs` from now, burned or not. */
async function newNonce(
  jti: string,
  appId: string,
  userId: string,
  opts: { expiresInMs: number; consumed: boolean },
): Promise<void> {
  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti: `${PREFIX}${jti}`,
      app_user_id: userId,
      target_application_id: appId,
      expires_at: new Date(Date.now() + opts.expiresInMs),
      consumed_at: opts.consumed ? new Date() : null,
    })
    .execute();
}

async function noncesOf(appId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_sso_handoff_nonces")
    .select("jti")
    .where("target_application_id", "=", appId)
    .execute();
  return rows.map((r) => r.jti).sort();
}

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("DELETE /api/administrator/enterprise-apps/:id (DB-backed, F-84)", () => {
  it("deletes a disabled app its launches left nonces for, with those nonces only", async () => {
    const user = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}launcher`,
        primary_email: `${PREFIX}launcher@dbtest.local`,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // Retired the usual way: disabled first, so no launch of it purges these.
    await newApp(APP_ID, "disabled");
    await newApp(OTHER_APP_ID, "available");
    await newNonce("burned", APP_ID, user.id, { expiresInMs: -5_000, consumed: true });
    await newNonce("abandoned", APP_ID, user.id, { expiresInMs: -5_000, consumed: false });
    await newNonce("in_flight", APP_ID, user.id, { expiresInMs: 60_000, consumed: false });
    await newNonce("other_app", OTHER_APP_ID, user.id, { expiresInMs: 60_000, consumed: false });

    const res = await DELETE(deleteReq(APP_ID), { params: Promise.resolve({ id: APP_ID }) });

    // Before F-84: 409 application_in_use, from the nonces' foreign key.
    expect(res.status, await res.text()).toBe(200);
    const app = await db
      .selectFrom("app_enterprise_applications")
      .select("id")
      .where("id", "=", APP_ID)
      .executeTakeFirst();
    expect(app).toBeUndefined();
    expect(await noncesOf(APP_ID)).toEqual([]);
    expect(await noncesOf(OTHER_APP_ID)).toEqual([`${PREFIX}other_app`]);

    const audit = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "outcome", "target_application_id"])
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
    expect(audit).toEqual([
      { event_type: "admin.app.deleted", outcome: "success", target_application_id: APP_ID },
    ]);
  });
});
