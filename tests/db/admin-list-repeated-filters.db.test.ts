import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { sql } from "kysely";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/http/rate-limit.server";

/**
 * DB-BACKED test for F-74: a repeated `filter[…]` on an administrator list or
 * export matches ANY of its values.
 *
 * The admin OpenAPI document declares every exact-match filter repeatable
 * ("repeat for multiple values"), and the generated SDK sends an array as one
 * parameter per value. `parseListQuery` turns a repeated filter into an array,
 * but most routes read only the string a single value parses to, so they
 * applied no filter at all: `filter[event_type]=a&filter[event_type]=b` read
 * the whole audit log, and the CSV export behind "Export current view" wrote
 * it. Each case below repeats a filter and expects the rows of its values and
 * NOT the row of a value it did not name, which the unfiltered answer carried.
 * A filter with a two-value vocabulary repeats one value.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f74_`
 * and self-clean. Only auth, audit writes and the export rate limit are
 * mocked; `@/db/database` is the real pool.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
// The export budget is 3 per actor per minute; this file exports far more.
vi.mock("@/lib/http/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/http/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

const { db, pgPool } = await import("@/db/database");

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<{ id: string; resource: string }> },
) => Promise<Response>;

const LISTS: Record<string, Handler> = {
  audit: (await import("@/app/api/administrator/audit/route")).GET as Handler,
  "api-keys": (await import("@/app/api/administrator/api-keys/route")).GET as Handler,
  "email/outbox": (await import("@/app/api/administrator/email/outbox/route")).GET as Handler,
  "enterprise-apps": (await import("@/app/api/administrator/enterprise-apps/route")).GET as Handler,
  memberships: (await import("@/app/api/administrator/memberships/route")).GET as Handler,
  organizations: (await import("@/app/api/administrator/organizations/route")).GET as Handler,
  "organizations/[id]/invitations": (
    await import("@/app/api/administrator/organizations/[id]/invitations/route")
  ).GET as Handler,
  "organizations/[id]/members": (
    await import("@/app/api/administrator/organizations/[id]/members/route")
  ).GET as Handler,
  "organizations/[id]/provider-bindings": (
    await import("@/app/api/administrator/organizations/[id]/provider-bindings/route")
  ).GET as Handler,
  roles: (await import("@/app/api/administrator/roles/route")).GET as Handler,
  "users/[id]/audit": (await import("@/app/api/administrator/users/[id]/audit/route"))
    .GET as Handler,
  "users/[id]/memberships": (await import("@/app/api/administrator/users/[id]/memberships/route"))
    .GET as Handler,
  "users/[id]/roles": (await import("@/app/api/administrator/users/[id]/roles/route"))
    .GET as Handler,
};
const EXPORT = (await import("@/app/api/administrator/export/[resource]/route")).GET as Handler;

const PREFIX = "__dbtest_f74_";
const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["superuser"],
};

function request(path: string, qs: string): NextRequest {
  const url = new URL(`http://test.local/api/administrator/${path}?${qs}`);
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
    method: "GET",
  } as unknown as NextRequest;
}

/** `filter[name]=v` once per value (the SDK's `explode` form). */
function repeated(name: string, values: string[]): string {
  return values.map((v) => `filter[${name}]=${encodeURIComponent(v)}`).join("&");
}

/** The ids a list answers for `qs`, from its first (and only) page. */
async function listIds(path: string, qs: string, id = ""): Promise<string[]> {
  const route = LISTS[path];
  if (!route) throw new Error(`no handler for ${path}`);
  const res = await route(request(path.replace("[id]", id), `${qs}&pageSize=200`), {
    params: Promise.resolve({ id, resource: "" }),
  });
  const body = (await res.json()) as { items?: Array<{ id: string }> };
  expect({ path, qs, status: res.status }).toEqual({ path, qs, status: 200 });
  return (body.items ?? []).map((row) => row.id);
}

/** The export's CSV body for `qs`. */
async function exportText(resource: string, qs: string): Promise<string> {
  const res = await EXPORT(request(`export/${resource}`, qs), {
    params: Promise.resolve({ id: "", resource }),
  });
  const text = await res.text();
  expect({ resource, qs, status: res.status }).toEqual({ resource, qs, status: 200 });
  return text;
}

interface Fixture {
  org: Record<"a" | "b" | "c", string>;
  user: Record<"a" | "b" | "c", string>;
  event: Record<"a" | "b" | "c" | "a2" | "a3", string>;
  key: Record<"a" | "b" | "c", string>;
  mail: Record<"a" | "b" | "c", string>;
  app: Record<"a" | "b" | "c" | "global", string>;
  /** User a's memberships in orgs a, b, c; then users b and c in org a. */
  member: Record<"aa" | "ba" | "ca" | "ab" | "ac", string>;
  invite: Record<"pending" | "expired" | "accepted" | "revoked", string>;
  binding: Record<"a" | "b" | "c", string>;
  role: Record<"global" | "a" | "b" | "c", string>;
}

async function cleanup(): Promise<void> {
  const orgIds = db
    .selectFrom("app_organizations")
    .select("id")
    .where("slug", "like", `${PREFIX}%`);
  const userIds = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  const roleIds = db.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`);
  // Audit rows are append-only: the sanctioned retention path removes them,
  // and first, since they reference the fixture users and orgs.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("reason", "like", `${PREFIX}%`).execute();
  });
  await db.deleteFrom("app_role_permissions").where("role_id", "in", roleIds).execute();
  await db.deleteFrom("app_user_roles").where("role_id", "in", roleIds).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_outbox").where("template_key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_api_keys").where("app_user_id", "in", userIds).execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_provider_organizations")
    .where("organization_id", "in", orgIds)
    .execute();
  await db
    .deleteFrom("app_organization_invitations")
    .where("organization_id", "in", orgIds)
    .execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("organization_id", "in", orgIds)
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function seed(): Promise<Fixture> {
  const orgRow = (slot: string, status: string) => ({
    slug: `${PREFIX}org-${slot}`,
    name: `F-74 org ${slot}`,
    status,
  });
  const orgs = await db
    .insertInto("app_organizations")
    .values([orgRow("a", "active"), orgRow("b", "pending"), orgRow("c", "suspended")])
    .returning(["id", "slug"])
    .execute();
  const orgId = (slot: string) => orgs.find((o) => o.slug === `${PREFIX}org-${slot}`)!.id;
  const org = { a: orgId("a"), b: orgId("b"), c: orgId("c") };

  const users = await db
    .insertInto("app_users")
    .values(
      ["a", "b", "c"].map((slot) => ({
        better_auth_user_id: `${PREFIX}user-${slot}`,
        primary_email: `${PREFIX}user-${slot}@dbtest.local`,
        status: "active",
      })),
    )
    .returning(["id", "better_auth_user_id"])
    .execute();
  const userId = (slot: string) =>
    users.find((u) => u.better_auth_user_id === `${PREFIX}user-${slot}`)!.id;
  const user = { a: userId("a"), b: userId("b"), c: userId("c") };

  const eventRow = (type: string, outcome: string, slot: "a" | "b" | "c", appUser: string) => ({
    event_type: `${PREFIX}type-${type}`,
    outcome,
    actor_better_auth_user_id: `${PREFIX}actor-${slot}`,
    app_user_id: appUser,
    organization_id: org[slot],
    target_application_id: `${PREFIX}target-${slot}`,
    reason: `${PREFIX}reason`,
  });
  const insertEvent = async (row: ReturnType<typeof eventRow>) =>
    (await db.insertInto("app_audit_events").values(row).returning("id").executeTakeFirstOrThrow())
      .id;
  const event = {
    a: await insertEvent(eventRow("a", "success", "a", user.a)),
    b: await insertEvent(eventRow("b", "denied", "b", user.b)),
    c: await insertEvent(eventRow("c", "error", "c", user.c)),
    // User a's own trail, one event per type and outcome.
    a2: await insertEvent(eventRow("b", "denied", "a", user.a)),
    a3: await insertEvent(eventRow("c", "error", "a", user.a)),
  };

  const keyRow = (slot: "a" | "b" | "c", status: string) => ({
    app_user_id: user[slot],
    organization_id: org[slot],
    name: `${PREFIX}key-${slot}`,
    key_prefix: `drk_f74_${slot}`,
    key_hash: `${PREFIX}hash-${slot}`,
    status,
  });
  const keys = await db
    .insertInto("app_api_keys")
    .values([keyRow("a", "active"), keyRow("b", "active"), keyRow("c", "revoked")])
    .returning(["id", "name"])
    .execute();
  const keyId = (slot: string) => keys.find((k) => k.name === `${PREFIX}key-${slot}`)!.id;
  const key = { a: keyId("a"), b: keyId("b"), c: keyId("c") };

  const mailRow = (slot: string, status: string) => ({
    template_key: `${PREFIX}tpl-${slot}`,
    to_email: `${PREFIX}to-${slot}@dbtest.local`,
    from_email: "noreply@dbtest.local",
    subject: `F-74 ${slot}`,
    body_html: "<p>x</p>",
    status,
  });
  const mails = await db
    .insertInto("app_outbox")
    .values([mailRow("a", "pending"), mailRow("b", "sent"), mailRow("c", "failed")])
    .returning(["id", "template_key"])
    .execute();
  const mailId = (slot: string) => mails.find((m) => m.template_key === `${PREFIX}tpl-${slot}`)!.id;
  const mail = { a: mailId("a"), b: mailId("b"), c: mailId("c") };

  const appRow = (slot: string, organizationId: string | null, status: string) => ({
    id: `${PREFIX}app-${slot}`,
    organization_id: organizationId,
    label: `F-74 ${slot}`,
    origin: `https://f74-${slot}.dbtest.local`,
    subdomain: `f74-${slot}`,
    sso_audience: `${PREFIX}aud-${slot}`,
    status,
  });
  await db
    .insertInto("app_enterprise_applications")
    .values([
      appRow("a", org.a, "available"),
      appRow("b", org.b, "available"),
      appRow("c", org.c, "disabled"),
      appRow("global", null, "available"),
    ])
    .execute();
  const app = {
    a: `${PREFIX}app-a`,
    b: `${PREFIX}app-b`,
    c: `${PREFIX}app-c`,
    global: `${PREFIX}app-global`,
  };

  const memberRow = (o: string, u: string, status: string, provider: string | null) => ({
    organization_id: o,
    app_user_id: u,
    status,
    source_provider: provider,
  });
  const insertMember = async (row: ReturnType<typeof memberRow>) =>
    (
      await db
        .insertInto("app_organization_memberships")
        .values(row)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const member = {
    aa: await insertMember(memberRow(org.a, user.a, "active", `${PREFIX}src-a`)),
    ba: await insertMember(memberRow(org.b, user.a, "pending_approval", `${PREFIX}src-b`)),
    ca: await insertMember(memberRow(org.c, user.a, "suspended", `${PREFIX}src-c`)),
    ab: await insertMember(memberRow(org.a, user.b, "pending_approval", null)),
    ac: await insertMember(memberRow(org.a, user.c, "suspended", null)),
  };

  const day = 24 * 60 * 60 * 1000;
  const inviteRow = (slot: string, status: string, expiresInMs: number) => ({
    organization_id: org.a,
    email: `${PREFIX}invite-${slot}@dbtest.local`,
    token_hash: `${PREFIX}token-${slot}`,
    status,
    expires_at: new Date(Date.now() + expiresInMs),
  });
  const invites = await db
    .insertInto("app_organization_invitations")
    .values([
      inviteRow("pending", "pending", day),
      inviteRow("expired", "pending", -day),
      inviteRow("accepted", "accepted", day),
      inviteRow("revoked", "revoked", day),
    ])
    .returning(["id", "token_hash"])
    .execute();
  const inviteId = (slot: string) =>
    invites.find((i) => i.token_hash === `${PREFIX}token-${slot}`)!.id;
  const invite = {
    pending: inviteId("pending"),
    expired: inviteId("expired"),
    accepted: inviteId("accepted"),
    revoked: inviteId("revoked"),
  };

  const bindings = await db
    .insertInto("app_provider_organizations")
    .values(
      ["a", "b", "c"].map((slot) => ({
        organization_id: org.a,
        provider: `${PREFIX}idp-${slot}`,
        provider_organization_key: `${PREFIX}tenant-${slot}`,
      })),
    )
    .returning(["id", "provider"])
    .execute();
  const bindingId = (slot: string) =>
    bindings.find((b) => b.provider === `${PREFIX}idp-${slot}`)!.id;
  const binding = { a: bindingId("a"), b: bindingId("b"), c: bindingId("c") };

  const roleRow = (slot: string, organizationId: string | null) => ({
    organization_id: organizationId,
    key: `${PREFIX}role-${slot}`,
    name: `F-74 role ${slot}`,
  });
  const roles = await db
    .insertInto("app_roles")
    .values([
      roleRow("global", null),
      roleRow("a", org.a),
      roleRow("b", org.b),
      roleRow("c", org.c),
    ])
    .returning(["id", "key"])
    .execute();
  const roleId = (slot: string) => roles.find((r) => r.key === `${PREFIX}role-${slot}`)!.id;
  const role = { global: roleId("global"), a: roleId("a"), b: roleId("b"), c: roleId("c") };
  const perms = await db
    .insertInto("app_permissions")
    .values(["a", "b", "c"].map((slot) => ({ key: `${PREFIX}perm-${slot}` })))
    .returning(["id", "key"])
    .execute();
  const permId = (slot: string) => perms.find((p) => p.key === `${PREFIX}perm-${slot}`)!.id;
  await db
    .insertInto("app_role_permissions")
    .values([
      { role_id: role.global, permission_id: permId("a") },
      { role_id: role.a, permission_id: permId("b") },
      { role_id: role.b, permission_id: permId("c") },
    ])
    .execute();
  await db
    .insertInto("app_user_roles")
    .values([
      { app_user_id: user.a, organization_id: org.a, role_id: role.a },
      { app_user_id: user.a, organization_id: org.b, role_id: role.b },
      { app_user_id: user.a, organization_id: org.c, role_id: role.c },
    ])
    .execute();

  return { org, user, event, key, mail, app, member, invite, binding, role };
}

let f: Fixture;

beforeAll(async () => {
  await cleanup();
  sessionGetter.mockResolvedValue({ user: { id: "dbtest-ba" } });
  accessGetter.mockResolvedValue(SUPERADMIN);
  f = await seed();
});
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

/**
 * One repeated filter: `filter[<filter>]` once per value, and the ids the
 * answer must and must not hold. Unless `search` is false the query also
 * sends `q=<prefix>`, which narrows the list to this suite's fixtures, so the
 * first page holds them all.
 */
interface FilterCase {
  filter: string;
  values: () => string[];
  search?: boolean;
  present: () => string[];
  absent: () => string[];
}
interface ListCase extends FilterCase {
  path: string;
  id?: () => string;
}
interface ExportCase extends FilterCase {
  resource: string;
}

function queryOf(c: FilterCase): string {
  const filters = repeated(c.filter, c.values());
  return c.search === false ? filters : `q=${PREFIX}&${filters}`;
}

const LIST_CASES: ListCase[] = [
  {
    path: "audit",
    filter: "event_type",
    values: () => [`${PREFIX}type-a`, `${PREFIX}type-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "audit",
    filter: "outcome",
    values: () => ["success", "denied"],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "audit",
    filter: "actor",
    values: () => [`${PREFIX}actor-a`, `${PREFIX}actor-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "audit",
    filter: "app_user_id",
    values: () => [f.user.a, f.user.b],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "audit",
    filter: "organization_id",
    values: () => [f.org.a, f.org.b],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "audit",
    filter: "target_application_id",
    values: () => [`${PREFIX}target-a`, `${PREFIX}target-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    path: "api-keys",
    filter: "status",
    values: () => ["active", "active"],
    present: () => [f.key.a, f.key.b],
    absent: () => [f.key.c],
  },
  {
    path: "api-keys",
    filter: "app_user_id",
    values: () => [f.user.a, f.user.b],
    present: () => [f.key.a, f.key.b],
    absent: () => [f.key.c],
  },
  {
    path: "api-keys",
    filter: "organization_id",
    values: () => [f.org.a, f.org.b],
    present: () => [f.key.a, f.key.b],
    absent: () => [f.key.c],
  },
  {
    path: "email/outbox",
    filter: "status",
    values: () => ["pending", "sent"],
    present: () => [f.mail.a, f.mail.b],
    absent: () => [f.mail.c],
  },
  {
    path: "email/outbox",
    filter: "template_key",
    values: () => [`${PREFIX}tpl-a`, `${PREFIX}tpl-b`],
    present: () => [f.mail.a, f.mail.b],
    absent: () => [f.mail.c],
  },
  {
    path: "enterprise-apps",
    filter: "status",
    values: () => ["available", "available"],
    present: () => [f.app.a, f.app.b, f.app.global],
    absent: () => [f.app.c],
  },
  {
    path: "enterprise-apps",
    filter: "organization_id",
    values: () => [f.org.a, "null"],
    present: () => [f.app.a, f.app.global],
    absent: () => [f.app.b, f.app.c],
  },
  {
    path: "memberships",
    filter: "status",
    values: () => ["active", "pending_approval"],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    path: "memberships",
    filter: "organization_id",
    values: () => [f.org.a, f.org.b],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    path: "memberships",
    filter: "source_provider",
    values: () => [`${PREFIX}src-a`, `${PREFIX}src-b`],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    path: "organizations",
    filter: "status",
    values: () => ["active", "pending"],
    present: () => [f.org.a, f.org.b],
    absent: () => [f.org.c],
  },
  {
    // No fixture org is the default one.
    path: "organizations",
    filter: "is_default",
    values: () => ["true", "true"],
    present: () => [],
    absent: () => [f.org.a, f.org.b, f.org.c],
  },
  {
    path: "organizations",
    filter: "is_default",
    values: () => ["true", "false"],
    present: () => [f.org.a, f.org.b, f.org.c],
    absent: () => [],
  },
  {
    path: "organizations/[id]/invitations",
    id: () => f.org.a,
    filter: "status",
    search: false,
    values: () => ["expired", "accepted"],
    present: () => [f.invite.expired, f.invite.accepted],
    absent: () => [f.invite.pending, f.invite.revoked],
  },
  {
    path: "organizations/[id]/invitations",
    id: () => f.org.a,
    filter: "status",
    search: false,
    values: () => ["pending", "revoked"],
    present: () => [f.invite.pending, f.invite.revoked],
    absent: () => [f.invite.expired, f.invite.accepted],
  },
  {
    path: "organizations/[id]/members",
    id: () => f.org.a,
    filter: "status",
    search: false,
    values: () => ["active", "pending_approval"],
    present: () => [f.member.aa, f.member.ab],
    absent: () => [f.member.ac],
  },
  {
    path: "organizations/[id]/provider-bindings",
    id: () => f.org.a,
    filter: "provider",
    search: false,
    values: () => [`${PREFIX}idp-a`, `${PREFIX}idp-b`],
    present: () => [f.binding.a, f.binding.b],
    absent: () => [f.binding.c],
  },
  {
    path: "roles",
    filter: "scope",
    values: () => ["global", "global"],
    present: () => [f.role.global],
    absent: () => [f.role.a, f.role.b],
  },
  {
    path: "roles",
    filter: "scope",
    values: () => ["global", "org"],
    present: () => [f.role.global, f.role.a, f.role.b],
    absent: () => [],
  },
  {
    path: "roles",
    filter: "permission",
    values: () => [`${PREFIX}perm-a`, `${PREFIX}perm-b`],
    present: () => [f.role.global, f.role.a],
    absent: () => [f.role.b],
  },
  {
    path: "users/[id]/audit",
    id: () => f.user.a,
    filter: "event_type",
    search: false,
    values: () => [`${PREFIX}type-a`, `${PREFIX}type-b`],
    present: () => [f.event.a, f.event.a2],
    absent: () => [f.event.a3],
  },
  {
    path: "users/[id]/audit",
    id: () => f.user.a,
    filter: "outcome",
    search: false,
    values: () => ["success", "denied"],
    present: () => [f.event.a, f.event.a2],
    absent: () => [f.event.a3],
  },
  {
    path: "users/[id]/memberships",
    id: () => f.user.a,
    filter: "status",
    search: false,
    values: () => ["active", "pending_approval"],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    path: "users/[id]/memberships",
    id: () => f.user.a,
    filter: "organization_id",
    search: false,
    values: () => [f.org.a, f.org.b],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    path: "users/[id]/roles",
    id: () => f.user.a,
    filter: "organization_id",
    search: false,
    values: () => [f.org.a, f.org.b],
    // The assignment rows' synthesized id is `<organization_id>:<role_id>`.
    present: () => [`${f.org.a}:${f.role.a}`, `${f.org.b}:${f.role.b}`],
    absent: () => [`${f.org.c}:${f.role.c}`],
  },
];

describe("a repeated filter matches any of its values on every admin list (DB-backed, F-74)", () => {
  it.each(LIST_CASES.map((c) => [`${c.path} filter[${c.filter}]`, c] as const))(
    "%s",
    async (_label, c) => {
      const qs = queryOf(c);
      const ids = await listIds(c.path, qs, c.id?.() ?? "");
      for (const id of c.present()) expect(ids, `${c.path} ${qs} lists ${id}`).toContain(id);
      for (const id of c.absent()) expect(ids, `${c.path} ${qs} omits ${id}`).not.toContain(id);
    },
  );
});

const EXPORT_CASES: ExportCase[] = [
  {
    resource: "audit",
    filter: "event_type",
    values: () => [`${PREFIX}type-a`, `${PREFIX}type-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "audit",
    filter: "outcome",
    values: () => ["success", "denied"],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "audit",
    filter: "actor",
    values: () => [`${PREFIX}actor-a`, `${PREFIX}actor-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "audit",
    filter: "app_user_id",
    values: () => [f.user.a, f.user.b],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "audit",
    filter: "organization_id",
    values: () => [f.org.a, f.org.b],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "audit",
    filter: "target_application_id",
    values: () => [`${PREFIX}target-a`, `${PREFIX}target-b`],
    present: () => [f.event.a, f.event.b],
    absent: () => [f.event.c],
  },
  {
    resource: "organizations",
    filter: "status",
    values: () => ["active", "pending"],
    present: () => [f.org.a, f.org.b],
    absent: () => [f.org.c],
  },
  {
    resource: "organizations",
    filter: "is_default",
    values: () => ["true", "true"],
    present: () => [],
    absent: () => [f.org.a, f.org.b, f.org.c],
  },
  {
    resource: "roles",
    filter: "scope",
    values: () => ["global", "global"],
    present: () => [f.role.global],
    absent: () => [f.role.a, f.role.b],
  },
  {
    // The memberships export does not search, so each case names one user.
    resource: "memberships",
    filter: "status",
    search: false,
    values: () => ["active", "pending_approval"],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    resource: "memberships",
    filter: "organization_id",
    search: false,
    values: () => [f.org.a, f.org.b],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    resource: "memberships",
    filter: "source_provider",
    search: false,
    values: () => [`${PREFIX}src-a`, `${PREFIX}src-b`],
    present: () => [f.member.aa, f.member.ba],
    absent: () => [f.member.ca],
  },
  {
    resource: "enterprise-apps",
    filter: "status",
    values: () => ["available", "available"],
    present: () => [f.app.a, f.app.b, f.app.global],
    absent: () => [f.app.c],
  },
  {
    resource: "enterprise-apps",
    filter: "organization_id",
    values: () => [f.org.a, "null"],
    present: () => [f.app.a, f.app.global],
    absent: () => [f.app.b, f.app.c],
  },
];

describe("the CSV export reads a repeated filter as its list does (DB-backed, F-74)", () => {
  it.each(EXPORT_CASES.map((c) => [`${c.resource} filter[${c.filter}]`, c] as const))(
    "%s",
    async (_label, c) => {
      const qs = queryOf(c);
      const text = await exportText(c.resource, qs);
      for (const id of c.present()) expect(text, `${c.resource} ${qs} has ${id}`).toContain(id);
      for (const id of c.absent())
        expect(text, `${c.resource} ${qs} lacks ${id}`).not.toContain(id);
    },
  );
});
