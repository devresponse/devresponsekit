import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ResolveCallerModule from "@/lib/api-auth/resolve-caller.server";

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
 * F-480: that enrolment is a membership add, and an `active` one an approval,
 * so a confined creator also needs `admin.users.update` or `admin.orgs.update`,
 * and `admin.users.manage` for `active`, each as permission AND scope. A key
 * scoped to `admin.users.create` alone used to mint an active member of its org
 * with a password it chose. An address on a domain bound to another org is
 * refused as well. Every refusal is a 403 before anything is written.
 *
 * The routes, `canAccessUser` and the admin permission guard are real. Only the
 * caller, Better Auth and the audit writer are stubbed, and the database is a
 * small in-memory fake that keeps rows, the membership unique key and
 * transaction rollback. That is what makes the follow-up GET mean something: it
 * answers 200 only because the create wrote a membership row, and the control
 * cases show the same GET answering 404 for a user with none. A write through
 * the pool while a transaction is open throws, so a statement moved off the
 * transaction fails here too; tests/db/user-create-enrolment.db.test.ts proves
 * the rollback against real Postgres.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const createBetterAuthUser = vi.fn();
const requireApiPermission = vi.fn();
/** A bearer caller for the admin guard; `null` resolves the cookie session. */
const bearer = vi.hoisted(() => ({ caller: null as Record<string, unknown> | null }));

const store = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  const failing = new Set<string>();
  let openTransactions = 0;

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
    constructor(
      private readonly table: string,
      private readonly viaPool: boolean,
    ) {}
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
      // A write on the pool commits on its own connection, whatever happens
      // to the transaction open beside it; the snapshot below would erase it
      // anyway. So the fake refuses one, and a moved statement fails loudly.
      if (this.viaPool && openTransactions > 0) {
        throw new Error(`fake db: pool insert into "${this.table}" during an open transaction`);
      }
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

  const executor = (viaPool: boolean) => ({
    selectFrom: (table: string) => new Query(table, viaPool),
    insertInto: (table: string) => new Query(table, viaPool),
  });
  const trx = executor(false);
  const db = {
    ...executor(true),
    transaction: () => ({
      async execute<T>(callback: (handle: typeof trx) => Promise<T>): Promise<T> {
        const snapshot = new Map([...tables].map(([name, list]) => [name, [...list]]));
        openTransactions += 1;
        try {
          return await callback(trx);
        } catch (err) {
          tables.clear();
          for (const [name, list] of snapshot) tables.set(name, list);
          throw err;
        } finally {
          openTransactions -= 1;
        }
      },
    }),
  };

  return {
    db,
    rows,
    reset(organizations: Row[], emailDomainBindings: Row[] = []) {
      tables.clear();
      tables.set("app_users", []);
      tables.set("app_organization_memberships", []);
      tables.set(
        "app_organizations",
        organizations.map((org) => ({ ...org })),
      );
      tables.set(
        "app_provider_organizations",
        emailDomainBindings.map((row) => ({ provider: "email", ...row })),
      );
      failing.clear();
      openTransactions = 0;
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
vi.mock("@/lib/api-auth/resolve-caller.server", async () => {
  const actual = await vi.importActual<typeof ResolveCallerModule>(
    "@/lib/api-auth/resolve-caller.server",
  );
  return {
    ...actual,
    resolveCaller: async (...a: Parameters<typeof actual.resolveCaller>) =>
      bearer.caller ?? actual.resolveCaller(...a),
  };
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
/**
 * What a confined creator needs for every case that succeeds: create, read (the
 * follow-up GET), and the membership and approval permissions its enrolment
 * stands in for (F-480).
 */
const PERMISSIONS = [
  "admin.users.create",
  "admin.users.read",
  "admin.users.update",
  "admin.users.manage",
];
/** Create and read only: the caller F-480 is about. */
const CREATE_ONLY = ["admin.users.create", "admin.users.read"];

type Access = Pick<
  AuthStatusModule.UserAccessContext,
  "permissions" | "organizationId" | "orgBound"
>;

/** An org admin's cookie session in org A. */
const orgAdmin = (permissions = PERMISSIONS): Access => ({
  permissions,
  organizationId: ORG_A.id,
});
/**
 * An API key or JWT bound to org A, here owned by a global superuser: bound, it
 * still has no cross-org reach (MACHINE-2), so it is confined like an org
 * admin. Its owner holds every permission, so only its scopes limit it.
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

/** Nothing was written and no identity was created: the refusal came first. */
function expectNothingWritten() {
  expect(createBetterAuthUser).not.toHaveBeenCalled();
  expect(store.rows("app_users")).toEqual([]);
  expect(store.rows("app_organization_memberships")).toEqual([]);
  expect(auditRows("admin.user.created")).toEqual([]);
}

let seq = 0;
function nextEmail(domain = "example.com"): string {
  seq += 1;
  return `created.${seq}@${domain}`;
}

/** An `app_users` row for a fresh address, as an earlier create leaves one. */
function seedExistingUser(): string {
  const email = nextEmail();
  store.rows("app_users").push({
    id: crypto.randomUUID(),
    better_auth_user_id: `ba-existing-${seq}`,
    primary_email: email,
    status: "active",
  });
  return email;
}

beforeEach(() => {
  store.reset([ORG_A, ORG_B]);
  bearer.caller = null;
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

  /**
   * Every admin call is this API key instead, as `resolveCaller` would resolve
   * it: bound to org A, owned by a superuser, limited by `scopes` alone.
   */
  function actAsKey(scopes: string[]) {
    bearer.caller = {
      kind: "api_key",
      betterAuthUserId: "ba-actor",
      access: {
        appUserId: "u-actor",
        primaryEmail: "actor@example.com",
        status: "active",
        membershipStatus: "active",
        preferredLocale: "en",
        ...boundCredential(),
      },
      grantedScopes: scopes,
      isBearer: true,
      credentialId: "key-1",
      boundOrganizationId: ORG_A.id,
      impersonatorId: null,
    };
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
      // F-480: no sign-up source, so the org's sign-up policy never
      // activates it at sign-in (`reevaluatePendingActivation`).
      expect(memberships[0]!.source_provider).toBeUndefined();
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

  describe("F-480: the enrolment needs the permissions it stands in for", () => {
    it.each([
      ["an org admin's session holding only create", () => actAs(orgAdmin(CREATE_ONLY))],
      ['an API key scoped to ["admin.users.create"]', () => actAsKey(["admin.users.create"])],
    ])("%s is refused with 403 before anything is written", async (_label, arrange) => {
      arrange();
      const email = nextEmail();
      const res = await create({ email, initialAppStatus: "active" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
      expectNothingWritten();
      expect(auditRows("admin.user.create_denied")).toEqual([
        expect.objectContaining({
          outcome: "denied",
          reason: "enrolment_not_permitted",
          appUserId: null,
          organizationId: ORG_A.id,
          email,
          metadata: { required: ["admin.users.update", "admin.orgs.update"] },
        }),
      ]);
    });

    it.each([
      [
        "admin.users.update",
        "org admin",
        () => actAs(orgAdmin(["admin.users.create", "admin.users.update"])),
      ],
      [
        "admin.orgs.update",
        "org admin",
        () => actAs(orgAdmin(["admin.users.create", "admin.orgs.update"])),
      ],
      [
        "admin.users.update",
        "API key",
        () => actAsKey(["admin.users.create", "admin.users.update"]),
      ],
    ])("with %s (%s) it enrols a pending user", async (_permission, _caller, arrange) => {
      arrange();
      const res = await create({ email: nextEmail() });
      expect(res.status).toBe(201);
      expect(store.rows("app_organization_memberships")).toEqual([
        expect.objectContaining({ organization_id: ORG_A.id, status: "pending_approval" }),
      ]);
    });

    it.each([
      [
        "an org admin's session without admin.users.manage",
        () => actAs(orgAdmin(["admin.users.create", "admin.users.update"])),
      ],
      [
        "an API key whose owner holds it but whose scopes do not",
        () => actAsKey(["admin.users.create", "admin.users.update"]),
      ],
    ])("an Active user is an approval: %s is refused, not downgraded", async (_label, arrange) => {
      arrange();
      const res = await create({ email: nextEmail(), initialAppStatus: "active" });
      expect(res.status).toBe(403);
      expectNothingWritten();
      expect(auditRows("admin.user.create_denied")).toEqual([
        expect.objectContaining({
          reason: "activation_not_permitted",
          metadata: { required: ["admin.users.manage"], initialAppStatus: "active" },
        }),
      ]);
    });

    // The refusal comes before the duplicate check, so a caller that may not
    // create learns nothing about which addresses already have an account.
    it.each([
      ["an org admin's session holding only create", () => actAs(orgAdmin(CREATE_ONLY))],
      ['an API key scoped to ["admin.users.create"]', () => actAsKey(["admin.users.create"])],
    ])("%s gets 403, not 409, for an address that already exists", async (_label, arrange) => {
      const existing = seedExistingUser();
      arrange();
      const res = await create({ email: existing });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
      expect(auditRows("admin.user.create_denied")).toEqual([
        expect.objectContaining({ reason: "enrolment_not_permitted", email: existing }),
      ]);
      expect(createBetterAuthUser).not.toHaveBeenCalled();
      expect(store.rows("app_users")).toHaveLength(1);

      // CONTROL: a caller that may create gets the 409, so the seed is a hit.
      bearer.caller = null;
      actAs(orgAdmin());
      const taken = await create({ email: existing });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({ error: "email_taken" });
    });

    it("an API key scoped to admin.users.manage as well creates an active member", async () => {
      actAsKey(["admin.users.create", "admin.users.update", "admin.users.manage"]);
      const res = await create({ email: nextEmail(), initialAppStatus: "active" });
      expect(res.status).toBe(201);
      expect(store.rows("app_organization_memberships")).toEqual([
        expect.objectContaining({ organization_id: ORG_A.id, status: "active" }),
      ]);
    });

    it("an address on a domain bound to ANOTHER org is refused; its own org's domain is not", async () => {
      store.reset(
        [ORG_A, ORG_B],
        [
          { organization_id: ORG_B.id, provider_organization_key: "orgb.example" },
          { organization_id: ORG_A.id, provider_organization_key: "orga.example" },
        ],
      );
      actAs(orgAdmin());
      const claimed = nextEmail("orgb.example");
      const refused = await create({ email: claimed });
      expect(refused.status).toBe(403);
      expectNothingWritten();
      expect(auditRows("admin.user.create_denied")).toEqual([
        expect.objectContaining({
          reason: "email_domain_claimed",
          email: claimed,
          organizationId: ORG_A.id,
          // The domain only; the row must not name the org that claims it.
          metadata: { domain: "orgb.example" },
        }),
      ]);

      expect((await create({ email: nextEmail("orga.example") })).status).toBe(201);
    });

    it("a superadmin's session needs none of it: it enrols nobody", async () => {
      store.reset(
        [ORG_A, ORG_B],
        [{ organization_id: ORG_B.id, provider_organization_key: "orgb.example" }],
      );
      actAs({ permissions: ["superuser"], organizationId: ORG_A.id, orgBound: false });
      const res = await create({ email: nextEmail("orgb.example"), initialAppStatus: "active" });
      expect(res.status).toBe(201);
      expect(store.rows("app_organization_memberships")).toEqual([]);
    });
  });

  // Defence in depth, past the guard: the real guard admits only an active
  // member, whose context always names an org, so this state comes only from
  // a hand-built context. The route must still refuse it before writing.
  it("a context with no org (which the guard never admits) is refused before anything is written", async () => {
    actAs({ permissions: PERMISSIONS, organizationId: null });
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expectNothingWritten();
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
  /**
   * Every v1 call is this caller, as the v1 guard would resolve it: the guard
   * admits any caller holding `admin.users.create` as permission and scope,
   * so a create-only key gets here. `null` scopes is a cookie session.
   */
  function actAs(access: Access, grantedScopes: string[] | null = null) {
    requireApiPermission.mockResolvedValue({
      ok: true,
      grant: {
        caller: { betterAuthUserId: "ba-actor", access, grantedScopes },
        requestId: "req-1",
      },
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
      actAs(caller(), caller === boundCredential ? PERMISSIONS : null);
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
    actAs(boundCredential(), PERMISSIONS);
    expect((await readBack(created.id)).status).toBe(404);
  });

  describe("F-480: a key's scopes bound the enrolment, whatever its owner holds", () => {
    it.each(["pending_approval", "active"])(
      'a key scoped to ["admin.users.create"] creating a %s user: 403 with a detail, nothing written',
      async (initialAppStatus) => {
        actAs(boundCredential(), ["admin.users.create"]);
        const email = nextEmail();
        const res = await create({ email, initialAppStatus });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          detail: expect.stringContaining("admin.users.update or admin.orgs.update"),
        });
        expectNothingWritten();
        expect(auditRows("admin.user.create_denied")).toEqual([
          expect.objectContaining({
            outcome: "denied",
            reason: "enrolment_not_permitted",
            appUserId: null,
            organizationId: ORG_A.id,
            email,
            requestId: "req-1",
            metadata: {
              required: ["admin.users.update", "admin.orgs.update"],
              via: "api.v1",
            },
          }),
        ]);
      },
    );

    // Refused before the duplicate check, as on the admin twin: no 409 tells
    // such a caller that the address has an account.
    it.each([
      [
        'a key scoped to ["admin.users.create"]',
        () => actAs(boundCredential(), ["admin.users.create"]),
      ],
      ["an org admin's session holding only create", () => actAs(orgAdmin(CREATE_ONLY))],
    ])("%s gets 403, not 409, for an address that already exists", async (_label, arrange) => {
      const existing = seedExistingUser();
      arrange();
      const res = await create({ email: existing });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        detail: expect.stringContaining("admin.users.update or admin.orgs.update"),
      });
      expect(auditRows("admin.user.create_denied")).toEqual([
        expect.objectContaining({ reason: "enrolment_not_permitted", email: existing }),
      ]);
      expect(createBetterAuthUser).not.toHaveBeenCalled();
      expect(store.rows("app_users")).toHaveLength(1);

      // CONTROL: a caller that may create gets the 409, so the seed is a hit.
      actAs(boundCredential(), PERMISSIONS);
      const taken = await create({ email: existing });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({
        detail: "A user with this email already exists.",
      });
    });

    it("a key scoped to create and update may enrol a pending user but not an active one", async () => {
      actAs(boundCredential(), ["admin.users.create", "admin.users.update"]);
      const refused = await create({ email: nextEmail(), initialAppStatus: "active" });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        detail: expect.stringContaining("admin.users.manage"),
      });
      expectNothingWritten();

      const res = await create({ email: nextEmail() });
      expect(res.status).toBe(201);
      expect(store.rows("app_organization_memberships")).toEqual([
        expect.objectContaining({ organization_id: ORG_A.id, status: "pending_approval" }),
      ]);
    });

    it("an address on a domain bound to another org is refused", async () => {
      store.reset(
        [ORG_A, ORG_B],
        [{ organization_id: ORG_B.id, provider_organization_key: "orgb.example" }],
      );
      actAs(boundCredential(), PERMISSIONS);
      const res = await create({ email: nextEmail("orgb.example") });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        detail: expect.stringContaining("bound to another organization"),
      });
      expectNothingWritten();
    });
  });

  // Defence in depth past the guard, as on the admin twin.
  it("a context with no org (which the guard never admits) is refused before anything is written", async () => {
    actAs({ permissions: PERMISSIONS, organizationId: null, orgBound: true }, PERMISSIONS);
    const res = await create({ email: nextEmail() });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("a failed membership insert rolls the user row back: 502, audited as db_insert_failed", async () => {
    actAs(boundCredential(), PERMISSIONS);
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
