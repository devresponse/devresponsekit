import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED proof of F-39: the organization, role and group PATCH routes
 * refuse a stale write.
 *
 * Their GET answers an `ETag` (a hash of the fields the PATCH can change) and
 * the Settings forms send it back as `If-Match`. Before, the routes had no
 * concurrency control: two admins, or two tabs, each saved over the other,
 * and nobody saw the conflict. Here the REAL handlers run against Postgres:
 *
 *   1. The tag a GET answers is accepted, and the 200 carries the new tag,
 *      which is what the next GET answers.
 *   2. A tag from before someone else's save is refused with 412
 *      `precondition_failed`, carrying the current tag, and nothing is
 *      written. Without `If-Match` the write still goes through.
 *   3. The comparison is a compare-and-swap, not a check-then-act: a rename
 *      held OPEN on a second connection when the PATCH starts makes the PATCH
 *      wait for the row, and once it commits the PATCH answers 412 instead of
 *      writing over it. Read without the row lock, the tag would still match
 *      (the rename is not committed yet) and the UPDATE would then overwrite
 *      the committed rename.
 *
 * Only auth, the rate limiter and the audit sink are stubbed. Driven by
 * `pnpm test:db` (vitest.db.config.ts); fixtures use `__dbtest_etag_<run>_`
 * and self-clean.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/http/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 1000, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditRoleAction: async () => undefined,
  auditOrgAction: async () => undefined,
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: async () => undefined }));

const { db, pgPool } = await import("@/db/database");
const roleRoute = await import("@/app/api/administrator/roles/[id]/route");
const groupRoute = await import("@/app/api/administrator/groups/[id]/route");
const orgRoute = await import("@/app/api/administrator/organizations/[id]/route");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `__dbtest_etag_${RUN}_`;
const ORG_PREFIX = `dbtest-etag-${RUN}-`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-etag-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [
    "admin.roles.read",
    "admin.roles.update",
    "admin.groups.read",
    "admin.groups.update",
    "admin.orgs.read",
    "admin.orgs.update",
    "superuser",
  ],
};

function req(path: string, method: string, body?: unknown, ifMatch?: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}`);
  const headers = new Headers({ "content-type": "application/json" });
  if (ifMatch !== undefined) headers.set("if-match", ifMatch);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const held: PoolClient[] = [];

async function cleanup(): Promise<void> {
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${ORG_PREFIX}%`).execute();
}

let seq = 0;
async function newOrg(): Promise<string> {
  seq += 1;
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${ORG_PREFIX}${seq}`, name: `DBTest ETag ${seq}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Each record kind as the tests drive it: create one, read it through the
 * route's GET, PATCH its name, and read the stored name back.
 */
interface Kind {
  name: string;
  table: "app_roles" | "app_groups" | "app_organizations";
  create(): Promise<string>;
  get(id: string): Promise<Response>;
  patch(id: string, name: string, ifMatch?: string): Promise<Response>;
  storedName(id: string): Promise<string>;
}

const kinds: Kind[] = [
  {
    name: "role",
    table: "app_roles",
    async create() {
      const orgId = await newOrg();
      const row = await db
        .insertInto("app_roles")
        .values({ organization_id: orgId, key: `${PREFIX}r${seq}`, name: "Original" })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    },
    get: (id) => roleRoute.GET(req(`roles/${id}`, "GET"), ctx(id)),
    patch: (id, name, ifMatch) =>
      roleRoute.PATCH(req(`roles/${id}`, "PATCH", { name }, ifMatch), ctx(id)),
    async storedName(id) {
      const row = await db
        .selectFrom("app_roles")
        .select("name")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return row.name;
    },
  },
  {
    name: "group",
    table: "app_groups",
    async create() {
      const orgId = await newOrg();
      const row = await db
        .insertInto("app_groups")
        .values({ organization_id: orgId, key: `${PREFIX}g${seq}`, name: "Original" })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    },
    get: (id) => groupRoute.GET(req(`groups/${id}`, "GET"), ctx(id)),
    patch: (id, name, ifMatch) =>
      groupRoute.PATCH(req(`groups/${id}`, "PATCH", { name }, ifMatch), ctx(id)),
    async storedName(id) {
      const row = await db
        .selectFrom("app_groups")
        .select("name")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return row.name;
    },
  },
  {
    name: "organization",
    table: "app_organizations",
    async create() {
      const id = await newOrg();
      await db
        .updateTable("app_organizations")
        .set({ name: "Original" })
        .where("id", "=", id)
        .execute();
      return id;
    },
    get: (id) => orgRoute.GET(req(`organizations/${id}`, "GET"), ctx(id)),
    patch: (id, name, ifMatch) =>
      orgRoute.PATCH(req(`organizations/${id}`, "PATCH", { name }, ifMatch), ctx(id)),
    async storedName(id) {
      const row = await db
        .selectFrom("app_organizations")
        .select("name")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return row.name;
    },
  },
];

/** Resolves once another backend waits on a lock, or once `request` settled. */
async function blockedOrSettled(request: Promise<unknown>): Promise<void> {
  let settled = false;
  void request.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 100 && !settled; i++) {
    const { rows } = await pgPool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!settled) throw new Error("the request neither blocked on a lock nor answered within 5s");
}

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockReset().mockResolvedValue({ user: { id: `${PREFIX}admin` } });
  accessGetter.mockReset().mockResolvedValue(SUPERADMIN);
});

afterEach(async () => {
  for (const client of held.splice(0)) {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe.each(kinds)("$name PATCH If-Match (DB-backed, F-39)", (kind) => {
  it("accepts the tag its GET answered, and answers the tag the next GET answers", async () => {
    const id = await kind.create();
    const tag = (await kind.get(id)).headers.get("etag");
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);

    const res = await kind.patch(id, "Renamed", tag!);

    expect(res.status).toBe(200);
    expect(await kind.storedName(id)).toBe("Renamed");
    const next = res.headers.get("etag");
    expect(next).not.toBe(tag);
    expect((await kind.get(id)).headers.get("etag")).toBe(next);
  });

  it("refuses a tag from before another save with 412, carrying the current tag, and writes nothing", async () => {
    const id = await kind.create();
    const stale = (await kind.get(id)).headers.get("etag")!;
    // Another admin (or tab) saves first.
    expect((await kind.patch(id, "Theirs")).status).toBe(200);
    const current = (await kind.get(id)).headers.get("etag");

    const res = await kind.patch(id, "Mine", stale);

    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({
      error: "precondition_failed",
      message: "errors.precondition_failed",
    });
    expect(res.headers.get("etag")).toBe(current);
    expect(await kind.storedName(id)).toBe("Theirs");
  });

  it("compares under the row lock: a rename committed while the PATCH waits is not overwritten", async () => {
    const id = await kind.create();
    const tag = (await kind.get(id)).headers.get("etag")!;
    const client = await pgPool.connect();
    held.push(client);
    await client.query("begin");
    await client.query(`update ${kind.table} set name = 'Theirs' where id = $1`, [id]);

    const pending = kind.patch(id, "Mine", tag);
    await blockedOrSettled(pending);
    await client.query("commit");
    const res = await pending;

    expect(res.status).toBe(412);
    expect(await kind.storedName(id)).toBe("Theirs");
  });
});
