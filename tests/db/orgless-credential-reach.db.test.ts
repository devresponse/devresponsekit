import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as EnvModule from "@/lib/env";

/**
 * DB-BACKED test for F-124: an ORG-LESS bearer credential owned by a GLOBAL
 * SUPERUSER stays in one tenant, end to end (MACHINE-2).
 *
 * For a key or token minted with no organization the resolver passes
 * `{ organizationId: null }` to `getUserAccessContext`, never `undefined`
 * (src/lib/api-auth/resolve-caller.server.ts). That argument alone marks the
 * context `orgBound`. A tidy-up that turns it into
 * `organizationId ? { organizationId } : undefined` ("no org, so no binding")
 * sends the credential down the COOKIE path instead: unbound, a superuser
 * everywhere, `resolveOrgScope` answers `{ kind: "all" }`, and the key reads
 * and mutates every tenant. The unit suite pins the call argument against a
 * mocked `getUserAccessContext`, and every route suite injects a canned
 * context, so no test ran the resolver's real output through the real scope
 * rule.
 *
 * Here that whole path is real, against live Postgres: the key is minted by
 * `createApiKey` and checked by `verifyApiKey`, the token is signed and
 * verified with an ephemeral Ed25519 key and its source key re-checked, and
 * `resolveCaller`, `getUserAccessContext`, the v1 guard, the scope helpers and
 * `GET /api/v1/users/[id]` all run as they do in production. Stubbed: the
 * Better Auth ban probe (nobody here is banned, and it keeps the Better Auth
 * instance out of this suite), the session lookup for the cookie control, and
 * the `active_org` cookie store.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use the
 * `__dbtest_f124_` prefix and self-clean. The shared `superuser` permission row
 * is global and deliberately left in place.
 */
const PREFIX = "__dbtest_f124_";

// Both bearer paths are off by default. The token needs a signing key, which
// is generated here per run and never committed.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  const { exportJWK, generateKeyPair } = await import("jose");
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const API_JWT_PRIVATE_KEY = JSON.stringify(await exportJWK(privateKey));
  return {
    ...actual,
    getServerEnv: () => ({
      ...actual.getServerEnv(),
      API_KEYS_ENABLED: true,
      API_JWT_ENABLED: true,
      API_JWT_PRIVATE_KEY,
    }),
  };
});
// The cookie path reads `active_org` through `next/headers`. The bearer path
// must never get that far; the cookie control does.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: async () => session.current }));
vi.mock("@/lib/api-auth/ban-status.server", () => ({ isBetterAuthUserBanned: async () => false }));

const { db, pgPool } = await import("@/db/database");
const { createApiKey } = await import("@/lib/api-auth/api-keys.server");
const { mintAccessToken } = await import("@/lib/api-auth/jwt.server");
const { resolveCaller } = await import("@/lib/api-auth/resolve-caller.server");
const { hasCrossOrgReach, resolveOrgScope, SUPERADMIN_PERMISSION } =
  await import("@/lib/admin/access-scope.server");
const userRoute = await import("@/app/api/v1/users/[id]/route");

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.deleteFrom("app_api_keys").where("app_user_id", "in", userIds).execute();
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
  }
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name: `DBTest F124 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(key: string): Promise<{ id: string; ba: string }> {
  const ba = `${PREFIX}ba_${key}`;
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${key}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, ba };
}

async function addMembership(appUserId: string, organizationId: string) {
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: appUserId, status: "active" })
    .execute();
}

const org = { a: "", b: "" };
/**
 * The owner is a global superuser (a `superuser` grant in A) and a member of A
 * only, so A is its earliest membership. `peer` is in A, `victim` in B only.
 */
const u = {
  owner: { id: "", ba: "" },
  peer: { id: "", ba: "" },
  victim: { id: "", ba: "" },
};
/** The org-less credentials, as a client presents them. */
const credential = { apiKey: "", jwt: "" };

beforeAll(async () => {
  await cleanup();
  org.a = await newOrg("a");
  org.b = await newOrg("b");
  u.owner = await newUser("owner");
  u.peer = await newUser("peer");
  u.victim = await newUser("victim");
  await addMembership(u.owner.id, org.a);
  await addMembership(u.peer.id, org.a);
  await addMembership(u.victim.id, org.b);

  await db
    .insertInto("app_permissions")
    .values({ key: SUPERADMIN_PERMISSION, description: "superuser marker" })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  const superPerm = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", SUPERADMIN_PERMISSION)
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: org.a, key: `${PREFIX}super`, name: "DBTest F124 Super" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: superPerm.id })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: u.owner.id, organization_id: org.a, role_id: role.id })
    .execute();

  // Minted with NO organization, as only an unbound superadmin can mint one.
  const key = await createApiKey({
    ownerAppUserId: u.owner.id,
    organizationId: null,
    name: `${PREFIX}key`,
    scopes: ["admin.users.read"],
    expiresAt: null,
    createdByAppUserId: u.owner.id,
  });
  credential.apiKey = key.plaintext;
  // What the token endpoint hands out for that key: no `org` claim, and the
  // key as its source credential, which the resolver re-checks (review #43).
  const minted = await mintAccessToken({
    subject: u.owner.ba,
    scopes: ["admin.users.read"],
    organizationId: null,
    jti: randomUUID(),
    credential: { kind: "api_key", id: key.id },
  });
  credential.jwt = minted.token;
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

function request(id: string, bearer: string | null): NextRequest {
  return new NextRequest(`http://test.local/api/v1/users/${id}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

function getUser(id: string, bearer: string | null): Promise<Response> {
  return userRoute.GET(request(id, bearer), { params: Promise.resolve({ id }) });
}

describe.each([
  { kind: "api_key", label: "API key", token: () => credential.apiKey },
  { kind: "jwt", label: "JWT", token: () => credential.jwt },
])("F-124 — an org-less $label of a global superuser is bound to one tenant", (c) => {
  it("resolves org-bound to the owner's earliest membership, never to every org", async () => {
    const caller = await resolveCaller(request(u.victim.id, c.token()));

    expect(caller?.kind).toBe(c.kind);
    // The credential names no org, and its owner really is a platform
    // superuser, so the cap below is the only thing standing between it and
    // every tenant.
    expect(caller?.boundOrganizationId).toBeNull();
    expect(caller?.access.permissions).toContain(SUPERADMIN_PERMISSION);
    expect(caller?.access.orgBound).toBe(true);
    expect(caller?.access.organizationId).toBe(org.a);
    expect(hasCrossOrgReach(caller!.access)).toBe(false);
    expect(resolveOrgScope(caller!.access)).toEqual({ kind: "org", organizationId: org.a });
  });

  it("GET /api/v1/users/[id] answers 404 for a user who is only in another org", async () => {
    const res = await getUser(u.victim.id, c.token());
    expect(res.status).toBe(404);
  });

  it("CONTROL: the same credential reads a user in its own org (200)", async () => {
    const res = await getUser(u.peer.id, c.token());
    expect(res.status).toBe(200);
  });
});

describe("F-124 control — the principal's own reach", () => {
  it("the same superuser at a browser reads the org-B user (200), so the 404 is the binding", async () => {
    session.current = { user: { id: u.owner.ba }, session: { id: `${PREFIX}session` } };
    try {
      const res = await getUser(u.victim.id, null);
      expect(res.status).toBe(200);
    } finally {
      session.current = null;
    }
  });
});
