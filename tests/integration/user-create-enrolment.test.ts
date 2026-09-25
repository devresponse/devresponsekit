import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Tenant-aware user creation, on both create routes.
 *
 * `POST /api/administrator/users` and `POST /api/v1/users` (which the MCP
 * `createUser` tool calls) used to add no membership. Every follow-up on
 * `/users/{id}` goes through `canAccessUser`, which lets a caller without
 * cross-org reach act only on a member of its own org, and that caller is an
 * org admin's session or ANY API key or JWT (org-bound, MACHINE-2). So such a
 * caller created a user and then got 404 on reading, approving, banning or
 * enrolling it, until a superadmin attached it. A confined creator now enrols
 * the user in the org it acts in, in the same transaction, with the user's
 * initial status; a superadmin's cookie session still creates the user in no
 * org.
 *
 * The routes, `canAccessUser` and the admin permission guard are real. Only the
 * caller, Better Auth and the audit writer are stubbed, and the database is a
 * small in-memory fake that keeps rows, the membership unique key and
 * transaction rollback. That is what makes the follow-up GET mean something: it
 * answers 200 only because the create wrote a membership row, and the control
 * cases show the same GET answering 404 for a user with none.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const createBetterAuthUser = vi.fn();
const requireApiPermission = vi.fn();

const store = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  const failing = new Set<string>();

  function rows(table: string): Row[] {
    const found = tables.get(table);
    if (!found) throw new Error(`fake db: no table "${table}"`);
    return found;
  }

  /**
   * The statement shapes the create, read and enrol paths issue. Anything else
   * is not a method here and fails the test loudly instead of passing it by
   * accident.
   */
  class Query {
    private readonly predicates: Array<(row: Row) => boolean> = [];
    private insertValues: Row | null = null;
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    returning() {
      return this;
    }
    where(column: unknown, op: string, value: unknown) {
      if (op !== "=") throw new Error(`fake db: unsupported operator "${op}"`);
      // The one non-column operand on these paths is the create routes'
      // up-front check, `sql\`lower(primary_email)\``.
      const read =
        typeof column === "string"
          ? (row: Row) => row[column]
          : (row: Row) => String(row.primary_email).toLowerCase();
      this.predicates.push((row) => read(row) === value);
      return this;
    }
    values(values: Row) {
      this.insertValues = values;
      return this;
    }
    async executeTakeFirst(): Promise<Row | undefined> {
      if (this.insertValues) return this.insert(this.insertValues);
      return rows(this.table).find((row) => this.predicates.every((matches) => matches(row)));
    }
    async executeTakeFirstOrThrow(): Promise<Row> {
      const row = await this.executeTakeFirst();
      if (!row) throw new Error(`fake db: no row in "${this.table}"`);
      return row;
    }
    private insert(values: Row): Row {
      if (failing.delete(this.table)) {
        throw new Error(`fake db: insert into "${this.table}" failed`);
      }
      const table = rows(this.table);
      const now = new Date();
      const row: Row = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...values };
      if (
        this.table === "app_organization_memberships" &&
        table.some(
          (r) => r.organization_id === row.organization_id && r.app_user_id === row.app_user_id,
        )
      ) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      }
      table.push(row);
      return row;
    }
  }

  const executor = {
    selectFrom: (table: string) => new Query(table),
    insertInto: (table: string) => new Query(table),
  };
  const db = {
    ...executor,
    transaction: () => ({
      async execute<T>(callback: (trx: typeof executor) => Promise<T>): Promise<T> {
        const snapshot = new Map([...tables].map(([name, list]) => [name, [...list]]));
        try {
          return await callback(executor);
        } catch (err) {
          tables.clear();
          for (const [name, list] of snapshot) tables.set(name, list);
          throw err;
        }
      },
    }),
  };

  return {
    db,
    rows,
    reset(organizations: Row[]) {
      tables.clear();
      tables.set("app_users", []);
      tables.set("app_organization_memberships", []);
      tables.set(
        "app_organizations",
        organizations.map((org) => ({ ...org })),
      );
      failing.clear();
    },
    /** The next insert into `table` throws, as a failed statement would. */
    failNextInsertInto(table: string) {
      failing.add(table);
    },
  };
});

vi.mock("@/db/database", () => ({ db: store.db }));
vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  createBetterAuthUser: (...a: unknown[]) => createBetterAuthUser(...a),
  banBetterAuthUser: vi.fn(),
  unbanBetterAuthUser: vi.fn(),
  updateBetterAuthUser: vi.fn(),
}));
vi.mock("@/lib/api-auth/v1-guard.server", () => ({
  requireApiPermission: (...a: unknown[]) => requireApiPermission(...a),
  enforceApiRateLimit: () => null,
}));

const ORG_A = { id: "0a0a0a0a-0000-4000-8000-00000000000a", slug: "org-a" };
const ORG_B = { id: "0b0b0b0b-0000-4000-8000-00000000000b", slug: "org-b" };
const PERMISSIONS = ["admin.users.create", "admin.users.read"];

type Access = Pick<
  AuthStatusModule.UserAccessContext,
  "permissions" | "organizationId" | "orgBound"
>;

/** An org admin's cookie session in org A. */
const orgAdmin = (): Access => ({ permissions: PERMISSIONS, organizationId: ORG_A.id });
/**
 * An API key or JWT bound to org A, here owned by a global superuser: bound, it
 * still has no cross-org reach (MACHINE-2), so it is confined like an org
 * admin.
 */
const boundCredential = (): Access => ({
  permissions: [...PERMISSIONS, "superuser"],
  organizationId: ORG_A.id,
  orgBound: true,
});
/** A superadmin's cookie session, whose active org happens to be A. */
const superadmin = (): Access => ({
  permissions: [...PERMISSIONS, "superuser"],
  organizationId: ORG_A.id,
  orgBound: false,
});

function makeRequest(url: string, method = "GET", body?: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const auditRows = (eventType: string) =>
  auditMock.mock.calls
    .map(([row]) => row as Record<string, unknown>)
    .filter((row) => row.eventType === eventType);

let seq = 0;
function nextEmail(): string {
  seq += 1;
  return `created.${seq}@example.com`;
}

beforeEach(() => {
  store.reset([ORG_A, ORG_B]);
  for (const mock of [sessionGetter, accessGetter, auditMock, createBetterAuthUser])
    mock.mockReset();
  requireApiPermission.mockReset();
  createBetterAuthUser.mockImplementation(async () => ({
    user: { id: `ba-${crypto.randomUUID()}` },
  }));
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/users: a confined creator enrols the user in its org", () => {
  /** Every admin call is this caller: a cookie session whose context is `access`. */
  function actAs(access: Access) {
    sessionGetter.mockResolvedValue({ user: { id: "ba-actor" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-actor",
      primaryEmail: "actor@example.com",
      status: "active",
      membershipStatus: "active",
      preferredLocale: "en",
      ...access,
    });
  }

  async function create(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/administrator/users/route");
    return POST(
      makeRequest("http://test.local/api/administrator/users", "POST", {
        password: "Password#123",
        ...body,
      }),
    );
  }

  async function readBack(id: string) {
    const { GET } = await import("@/app/api/administrator/users/[id]/route");
    return GET(makeRequest(`http://test.local/api/administrator/users/${id}`), {
      params: Promise.resolve({ id }),
    });
  }

  it.each([
    ["an org admin's session", "pending_approval", orgAdmin],
    ["an org admin's session", "active", orgAdmin],
    ["an org-bound credential (MACHINE-2)", "pending_approval", boundCredential],
    ["an org-bound credential (MACHINE-2)", "active", boundCredential],
  ] as const)(
    "%s creating a %s user: a membership of that status in its org, and the read-back is 200",
    async (_label, initialAppStatus, caller) => {
      actAs(caller());
      const email = nextEmail();
      const res = await create({ email, initialAppStatus });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; status: string };
      expect(created.status).toBe(initialAppStatus);

      const memberships = store.rows("app_organization_memberships");
      expect(memberships).toEqual([
        expect.objectContaining({
          organization_id: ORG_A.id,
          app_user_id: created.id,
          status: initialAppStatus,
        }),
      ]);
      const membershipId = memberships[0]!.id;

      // Audited as `POST /users/{id}/memberships` audits an added membership,
      // on the member's and on the org's Audit tab.
      const metadata = {
        organizationId: ORG_A.id,
        slug: ORG_A.slug,
        appUserId: created.id,
        membershipId,
        status: initialAppStatus,
      };
      expect(auditRows("admin.user.membership_added")).toEqual([
        expect.objectContaining({
          outcome: "success",
          appUserId: created.id,
          organizationId: ORG_A.id,
          metadata,
        }),
      ]);
      expect(auditRows("admin.organization.member_added")).toEqual([
        expect.objectContaining({ outcome: "success", organizationId: ORG_A.id, metadata }),
      ]);

      // The follow-up that used to be a 404: the creator reads the user back.
      const read = await readBack(created.id);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ user: { id: created.id, primary_email: email } });
    },
  );

  it("a superadmin's session enrols nobody, and a confined caller cannot reach that user", async () => {
    actAs(superadmin());
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect(store.rows("app_users")).toHaveLength(1);
    expect(store.rows("app_organization_memberships")).toEqual([]);
    expect(auditRows("admin.user.membership_added")).toEqual([]);
    expect(auditRows("admin.organization.member_added")).toEqual([]);

    // CONTROL: the same read that answers 200 above is a 404 without the
    // membership, so the enrolment is what makes the user reachable.
    expect((await readBack(created.id)).status).toBe(200);
    actAs(orgAdmin());
    expect((await readBack(created.id)).status).toBe(404);
  });

  it("a confined caller with no org is refused before anything is written", async () => {
    actAs({ permissions: PERMISSIONS, organizationId: null });
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(createBetterAuthUser).not.toHaveBeenCalled();
    expect(store.rows("app_users")).toEqual([]);
  });

  it("a failed membership insert rolls the user row back: 500, audited as db_insert_failed", async () => {
    actAs(orgAdmin());
    store.failNextInsertInto("app_organization_memberships");
    const email = nextEmail();
    const res = await create({ email });
    expect(res.status).toBe(500);
    expect(store.rows("app_users")).toEqual([]);
    expect(store.rows("app_organization_memberships")).toEqual([]);
    const baId = (await createBetterAuthUser.mock.results[0]!.value) as { user: { id: string } };
    expect(auditRows("admin.user.create_failed")).toEqual([
      expect.objectContaining({
        appUserId: null,
        email,
        reason: "db_insert_failed",
        metadata: { betterAuthUserId: baId.user.id },
      }),
    ]);
    expect(auditRows("admin.user.created")).toEqual([]);
    expect(auditRows("admin.user.membership_added")).toEqual([]);
  });
});

describe("POST /api/v1/users (the MCP `createUser` tool calls it): the same rule", () => {
  /** Every v1 call is this caller, as the v1 guard would resolve it. */
  function actAs(access: Access) {
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: { caller: { betterAuthUserId: "ba-actor", access }, requestId: "req-1" },
    });
  }

  async function create(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/users/route");
    return POST(
      makeRequest("http://test.local/api/v1/users", "POST", {
        password: "password123",
        ...body,
      }),
    );
  }

  async function readBack(id: string) {
    const { GET } = await import("@/app/api/v1/users/[id]/route");
    return GET(makeRequest(`http://test.local/api/v1/users/${id}`), {
      params: Promise.resolve({ id }),
    });
  }

  it.each([
    ["an API key or JWT (org-bound, MACHINE-2)", "pending_approval", boundCredential],
    ["an API key or JWT (org-bound, MACHINE-2)", "active", boundCredential],
    ["an org admin's session", "pending_approval", orgAdmin],
  ] as const)(
    "%s creating a %s user: a membership of that status in its org, and GET /users/{id} is 200",
    async (_label, initialAppStatus, caller) => {
      actAs(caller());
      const email = nextEmail();
      const res = await create({ email, initialAppStatus });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; email: string; status: string };
      expect(created).toMatchObject({ email, status: initialAppStatus });

      expect(store.rows("app_organization_memberships")).toEqual([
        expect.objectContaining({
          organization_id: ORG_A.id,
          app_user_id: created.id,
          status: initialAppStatus,
        }),
      ]);
      const metadata = expect.objectContaining({
        organizationId: ORG_A.id,
        slug: ORG_A.slug,
        appUserId: created.id,
        status: initialAppStatus,
        via: "api.v1",
      });
      expect(auditRows("admin.user.membership_added")).toEqual([
        expect.objectContaining({ organizationId: ORG_A.id, requestId: "req-1", metadata }),
      ]);
      expect(auditRows("admin.organization.member_added")).toEqual([
        expect.objectContaining({ organizationId: ORG_A.id, requestId: "req-1", metadata }),
      ]);

      const read = await readBack(created.id);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        user: { id: created.id, primary_email: email, status: initialAppStatus },
      });
    },
  );

  it("a superadmin's cookie session enrols nobody; a bound credential gets 404 for that user", async () => {
    actAs(superadmin());
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect(store.rows("app_organization_memberships")).toEqual([]);
    expect(auditRows("admin.user.membership_added")).toEqual([]);

    expect((await readBack(created.id)).status).toBe(200);
    actAs(boundCredential());
    expect((await readBack(created.id)).status).toBe(404);
  });

  it("a confined caller with no org is refused before anything is written", async () => {
    actAs({ permissions: PERMISSIONS, organizationId: null, orgBound: true });
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(403);
    expect(createBetterAuthUser).not.toHaveBeenCalled();
    expect(store.rows("app_users")).toEqual([]);
  });

  it("a failed membership insert rolls the user row back: 502, audited as db_insert_failed", async () => {
    actAs(boundCredential());
    store.failNextInsertInto("app_organization_memberships");
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(502);
    expect(store.rows("app_users")).toEqual([]);
    expect(auditRows("admin.user.create_failed")).toEqual([
      expect.objectContaining({ appUserId: null, reason: "db_insert_failed" }),
    ]);
    expect(auditRows("admin.user.created")).toEqual([]);
  });
});
