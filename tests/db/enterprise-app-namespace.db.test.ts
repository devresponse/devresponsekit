import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for I-01: an org admin registers enterprise apps only under
 * its org's slug.
 *
 * App ids (the primary key) and SSO audiences (a UNIQUE index) are global
 * names, so an org admin that registered its app as `crm` took that name from
 * the superadmin who later registered the real satellite (409). The route
 * suites stub the database, so they cannot show that the namespace is the
 * org row's own slug; this file drives the REAL `POST` and `PATCH` handlers
 * against Postgres (only the caller is stubbed).
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use the org slug
 * `dbtest-appns-<run>` and app ids starting `dbtest-appns-`, and clean up after
 * themselves; audit rows are append-only and go through the sanctioned
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
const { POST } = await import("@/app/api/administrator/enterprise-apps/route");
const { PATCH } = await import("@/app/api/administrator/enterprise-apps/[id]/route");

const RUN = randomUUID().slice(0, 8);
const SLUG = `dbtest-appns-${RUN}`;
const OWN_ID = `${SLUG}.crm`;
const GLOBAL_ID = `dbtest-appns-global-${RUN}`;
/** Plain text (no FK): the actor identity, and how cleanup finds its audit rows. */
const ACTOR = "__dbtest_appns_admin";

let orgId: string;

function orgAdmin(): AuthStatusModule.UserAccessContext {
  return {
    appUserId: "dbtest-appns-admin",
    primaryEmail: "admin@dbtest.local",
    status: "active",
    organizationId: orgId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["admin.apps.read", "admin.apps.manage"],
  };
}

function req(method: string, path: string, body: unknown): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

function createBody(id: string, ssoAudience: string) {
  return {
    id,
    label: `DBTest ${id}`,
    origin: "https://crm.example.com",
    subdomain: "crm",
    sso_audience: ssoAudience,
    organization_id: orgId,
  };
}

async function appIds(): Promise<string[]> {
  const rows = await db
    .selectFrom("app_enterprise_applications")
    .select("id")
    .where("id", "like", "dbtest-appns-%")
    .execute();
  return rows.map((r) => r.id).sort();
}

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  await db
    .deleteFrom("app_enterprise_applications")
    .where("id", "like", "dbtest-appns-%")
    .execute();
}

beforeAll(async () => {
  const org = await db
    .insertInto("app_organizations")
    .values({ slug: SLUG, name: "I-01 namespace" })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;
});

beforeEach(async () => {
  await cleanup();
  // The origin is not under test: allow it whatever the local .env lists.
  vi.stubEnv("SSO_ALLOWED_ORIGIN_SUFFIXES", "example.com");
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR } });
  accessGetter.mockResolvedValue(orgAdmin());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();
  await pgPool.end();
});

describe("enterprise-app names under the org's slug (DB-backed, I-01)", () => {
  it("an org admin registers its app under its org's slug", async () => {
    const res = await POST(
      req("POST", "enterprise-apps", createBody(OWN_ID, `devresponse-app:${OWN_ID}`)),
    );
    expect(res.status).toBe(201);
    expect(await appIds()).toEqual([OWN_ID]);
  });

  it("an org admin cannot claim a global name, and the refusal is audited under its org", async () => {
    const res = await POST(
      req("POST", "enterprise-apps", createBody(GLOBAL_ID, `devresponse-app:${GLOBAL_ID}`)),
    );
    expect(res.status).toBe(403);
    expect(await appIds()).toEqual([]);
    const rows = await db
      .selectFrom("app_audit_events")
      .select(["event_type", "outcome", "reason", "organization_id", "metadata"])
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
    expect(rows).toEqual([
      {
        event_type: "administrator.access.denied",
        outcome: "denied",
        reason: "cross_org_reach_required",
        organization_id: orgId,
        metadata: {
          action: "enterprise_app_global_name",
          applicationId: GLOBAL_ID,
          ssoAudience: `devresponse-app:${GLOBAL_ID}`,
        },
      },
    ]);
  });

  it("an org admin moves its app's audience only within the namespace", async () => {
    expect(
      (await POST(req("POST", "enterprise-apps", createBody(OWN_ID, `devresponse-app:${OWN_ID}`))))
        .status,
    ).toBe(201);
    const path = `enterprise-apps/${OWN_ID}`;
    const ctx = { params: Promise.resolve({ id: OWN_ID }) };

    const refused = await PATCH(
      req("PATCH", path, { sso_audience: `devresponse-app:${GLOBAL_ID}` }),
      ctx,
    );
    expect(refused.status).toBe(403);

    const moved = await PATCH(req("PATCH", path, { sso_audience: `sso:${OWN_ID}` }), ctx);
    expect(moved.status).toBe(200);
    const row = await db
      .selectFrom("app_enterprise_applications")
      .select("sso_audience")
      .where("id", "=", OWN_ID)
      .executeTakeFirstOrThrow();
    expect(row.sso_audience).toBe(`sso:${OWN_ID}`);
  });
});
