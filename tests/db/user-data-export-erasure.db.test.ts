import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { DB_SCHEMA } from "@/db/schema-config";
import { erasedEmailFor, isErasedAccount } from "@/lib/admin/erased-user";
import { isNotDeactivatedError, pseudonymiseUser } from "@/lib/admin/user-erasure.server";
import { buildUserDataExport } from "@/lib/user-data/export.server";

/**
 * DB-BACKED proof of F-151: the data-subject export
 * (`buildUserDataExport`) and the erasure primitive
 * `app_users_pseudonymise` (migration 0008, `pseudonymiseUser`).
 *
 *   1. The export holds the subject's data and nobody else's: the other
 *      user's rows, sessions and addresses, and an administrator's IP address
 *      on a row about the subject, stay out; no token, hash or secret is in
 *      it; an organization administrator's export holds only that
 *      organization's rows of the organization-attributed sections. A row
 *      that names them only in `metadata.email` (an invitation) is theirs.
 *   2. The erasure refuses an account that is not soft-deleted, then replaces
 *      every PII column it claims to (an invitation row's `metadata.email`
 *      included), deletes the sessions, credentials, reset tokens and locale
 *      preferences, leaves the other user alone, keeps every audit row and
 *      every foreign key, runs as the runtime role through the owner-owned
 *      function, and records the call in a `db.user.pseudonymised` row.
 *   3. The audit trigger still refuses an ordinary UPDATE afterwards, and the
 *      new exemption lets nothing through but the owner's pseudonymisation of
 *      those three columns and of an existing `metadata.email`.
 *   4. A second call changes nothing, and is recorded too.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts) against a database migrated
 * through 0008. Fixtures use `__dbtest_f151_` and clean up after themselves.
 */
const PREFIX = "__dbtest_f151_";
const RUN = randomUUID().slice(0, 8);
const RUNTIME_ROLE = `${DB_SCHEMA}_runtime`;

const X_EMAIL = `${PREFIX}x_${RUN}@dbtest.local`;
const X_OLD_EMAIL = `${PREFIX}x_old_${RUN}@dbtest.local`;
const Y_EMAIL = `${PREFIX}y_${RUN}@dbtest.local`;
const X_BA = `${PREFIX}ba_x_${RUN}`;
const Y_BA = `${PREFIX}ba_y_${RUN}`;
const Z_BA = `${PREFIX}ba_z_${RUN}`;

const w = {
  orgA: "",
  orgB: "",
  x: "",
  y: "",
  z: "",
  role: "",
  group: "",
  apiKey: "",
  client: "",
  pendingInvite: "",
  acceptedInvite: "",
  pendingMail: "",
  relatedMail: "",
  audit: {} as Record<string, string>,
};

type PgError = { code?: string; message: string };

async function pgErrorOf(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (err) {
    return err as PgError;
  }
  throw new Error("expected the statement to be rejected");
}

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const ids = users.map((u) => u.id);
  const orgs = await db
    .selectFrom("app_organizations")
    .select("id")
    .where("slug", "like", `${PREFIX}%`)
    .execute();
  const orgIds = orgs.map((o) => o.id);
  // Audit rows are append-only; the owner path with the retention marker is
  // the sanctioned delete (schema-integrity.db.test.ts documents it).
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("event_type", "like", `${PREFIX}%`),
          ...(ids.length > 0 ? [eb("app_user_id", "in", ids)] : []),
        ]),
      )
      .execute();
  });
  await db.deleteFrom("app_outbox").where("template_key", "like", `${PREFIX}%`).execute();
  if (ids.length > 0) {
    await db.deleteFrom("app_api_keys").where("app_user_id", "in", ids).execute();
    await db.deleteFrom("app_oauth_clients").where("app_user_id", "in", ids).execute();
    await db.deleteFrom("app_group_memberships").where("app_user_id", "in", ids).execute();
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", ids).execute();
    await db.deleteFrom("app_user_locale_preferences").where("app_user_id", "in", ids).execute();
    await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", ids).execute();
  }
  if (orgIds.length > 0) {
    await db
      .deleteFrom("app_organization_invitations")
      .where("organization_id", "in", orgIds)
      .execute();
    await db.deleteFrom("app_groups").where("organization_id", "in", orgIds).execute();
    await db.deleteFrom("app_roles").where("organization_id", "in", orgIds).execute();
  }
  if (ids.length > 0) await db.deleteFrom("app_users").where("id", "in", ids).execute();
  if (orgIds.length > 0) {
    await db.deleteFrom("app_organizations").where("id", "in", orgIds).execute();
  }
  await pgPool.query(`delete from "verification" where id like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "session" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "account" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
}

async function org(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}_${RUN}`, name: `F151 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function person(ba: string, email: string, name: string): Promise<string> {
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
     values ($1, $2, $3, true, $4, now(), now())`,
    [ba, name, email, `https://img.example/${ba}.png`],
  );
  const row = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: ba, primary_email: email, display_name: name, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function auditRow(
  key: string,
  row: {
    actor: string | null;
    appUserId: string | null;
    email?: string | null;
    ip?: string | null;
    ua?: string | null;
    organizationId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const inserted = await db
    .insertInto("app_audit_events")
    .values({
      event_type: `${PREFIX}${key}`,
      outcome: "success",
      actor_better_auth_user_id: row.actor,
      app_user_id: row.appUserId,
      organization_id: row.organizationId ?? null,
      email: row.email ?? null,
      ip_address: row.ip ?? null,
      user_agent: row.ua ?? null,
      reason: row.reason ?? null,
      metadata: JSON.stringify(row.metadata ?? {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.audit[key] = inserted.id;
}

async function auditById(key: string) {
  return db
    .selectFrom("app_audit_events")
    .selectAll()
    .where("id", "=", w.audit[key]!)
    .executeTakeFirstOrThrow();
}

async function countOf(query: string, params: unknown[]): Promise<number> {
  const { rows } = await pgPool.query<{ n: string }>(query, params);
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  await cleanup();
  w.orgA = await org("a");
  w.orgB = await org("b");
  w.x = await person(X_BA, X_EMAIL, "Xavier Subject");
  w.y = await person(Y_BA, Y_EMAIL, "Yolanda Other");
  w.z = await person(Z_BA, `${PREFIX}z_${RUN}@dbtest.local`, "Zed Admin");

  for (const id of [w.x, w.y]) {
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: w.orgA, app_user_id: id, status: "active" })
      .execute();
  }
  await db
    .insertInto("app_user_locale_preferences")
    .values({ app_user_id: w.x, locale: "fr", time_zone: "Europe/Kyiv" })
    .execute();
  w.role = (
    await db
      .insertInto("app_roles")
      .values({ organization_id: w.orgA, key: `${PREFIX}role`, name: "F151 role" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: w.x, organization_id: w.orgA, role_id: w.role })
    .execute();
  w.group = (
    await db
      .insertInto("app_groups")
      .values({ organization_id: w.orgA, key: `${PREFIX}group`, name: "F151 group" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("app_group_memberships")
    .values({ group_id: w.group, app_user_id: w.x })
    .execute();

  // Better Auth: sessions, sign-in methods and a pending reset token for both.
  for (const [ba, n, ip] of [
    [X_BA, "x", "10.0.0.1"],
    [Y_BA, "y", "10.0.0.3"],
  ] as const) {
    await pgPool.query(
      `insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
       values ($1, now() + interval '1 day', $2, now(), now(), $3, $4, $5)`,
      [`${PREFIX}sess_${n}_${RUN}`, `${PREFIX}session-token-${n}-${RUN}`, ip, `UA-${n}`, ba],
    );
    await pgPool.query(
      `insert into "account" (id, "accountId", "providerId", "userId", password, "accessToken", "createdAt", "updatedAt")
       values ($1, $2, 'credential', $2, $3, null, now(), now()),
              ($4, $5, 'github', $2, null, $6, now(), now())`,
      [
        `${PREFIX}acct_pw_${n}_${RUN}`,
        ba,
        `password-hash-${n}-${RUN}`,
        `${PREFIX}acct_gh_${n}_${RUN}`,
        `gh-${n}-${RUN}`,
        `gho_token_${n}_${RUN}`,
      ],
    );
    await pgPool.query(
      `insert into "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [`${PREFIX}ver_${n}_${RUN}`, `reset-password:${PREFIX}${n}_${RUN}`, ba],
    );
  }

  w.apiKey = (
    await db
      .insertInto("app_api_keys")
      .values({
        app_user_id: w.x,
        organization_id: w.orgA,
        name: `${PREFIX}key`,
        key_prefix: "drk_f151",
        key_hash: `key-hash-${RUN}`,
        scopes: ["account.read"],
        status: "active",
        last_used_ip: "10.0.0.7",
        created_by: w.x,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  w.client = (
    await db
      .insertInto("app_oauth_clients")
      .values({
        client_id: `${PREFIX}client_${RUN}`,
        client_secret_hash: `client-secret-hash-${RUN}`,
        app_user_id: w.x,
        organization_id: null,
        name: `${PREFIX}client`,
        scopes: [],
        status: "active",
        created_by: w.z,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;

  // Invitations: a pending one in org B to X's address, one X accepted in org
  // A under an OLD address (which the erasure must learn from the row).
  w.pendingInvite = (
    await db
      .insertInto("app_organization_invitations")
      .values({
        organization_id: w.orgB,
        email: X_EMAIL,
        token_hash: `invite-hash-p-${RUN}`,
        status: "pending",
        invited_by: w.z,
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  w.acceptedInvite = (
    await db
      .insertInto("app_organization_invitations")
      .values({
        organization_id: w.orgA,
        email: X_OLD_EMAIL,
        token_hash: `invite-hash-a-${RUN}`,
        status: "accepted",
        invited_by: w.z,
        expires_at: new Date(Date.now() + 86_400_000),
        accepted_at: new Date(),
        accepted_app_user_id: w.x,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;

  const mail = (to: string, status: string, related: string | null) =>
    db
      .insertInto("app_outbox")
      .values({
        template_key: `${PREFIX}mail`,
        to_email: to,
        from_email: "no-reply@dbtest.local",
        subject: "Hello Xavier",
        body_html: "<p>Hello Xavier, reset here</p>",
        body_text: "Hello Xavier",
        variables: JSON.stringify({ name: "Xavier Subject" }),
        status,
        delivery_payload:
          status === "pending" ? JSON.stringify({ subject: "s", html: "<p>live</p>" }) : null,
        related_better_auth_user_id: related,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  w.pendingMail = (await mail(X_EMAIL, "pending", null)).id;
  // Addressed to an address X no longer holds, found through the related id.
  w.relatedMail = (await mail(`${PREFIX}elsewhere_${RUN}@dbtest.local`, "sent", X_BA)).id;
  await mail(Y_EMAIL, "sent", Y_BA);

  await auditRow("x_login", { actor: X_BA, appUserId: null, ip: "10.0.0.1", ua: "UA-x" });
  await auditRow("z_on_x", {
    actor: Z_BA,
    appUserId: w.x,
    email: X_EMAIL,
    ip: "10.0.0.9",
    ua: "UA-z",
    organizationId: w.orgA,
    reason: "support ticket",
    metadata: { fields: ["displayName"] },
  });
  await auditRow("x_on_y", {
    actor: X_BA,
    appUserId: w.y,
    email: Y_EMAIL,
    ip: "10.0.0.2",
    ua: "UA-x2",
    organizationId: w.orgA,
    reason: "about yolanda",
    metadata: { note: "yolanda detail" },
  });
  // Named by address only, in the email column (a refusal's shape, e.g.
  // refuseUnconferrable), case-insensitively.
  await auditRow("z_refuses_x", {
    actor: Z_BA,
    appUserId: null,
    email: X_EMAIL.toUpperCase(),
    ip: "10.0.0.9",
    ua: "UA-z",
    organizationId: w.orgB,
  });
  // `admin.organization.invitation_created` as auditOrgAction writes it: no
  // subject id, no email column, the invitee's address only in metadata.
  await auditRow("z_invites_x", {
    actor: Z_BA,
    appUserId: null,
    email: null,
    ip: "10.0.0.9",
    ua: "UA-z",
    organizationId: w.orgB,
    metadata: {
      organizationId: w.orgB,
      invitationId: w.pendingInvite,
      email: X_EMAIL,
      roleId: null,
      emailStatus: "sent",
    },
  });
  await auditRow("y_login", { actor: Y_BA, appUserId: null, ip: "10.0.0.3", ua: "UA-y" });
  await auditRow("anon_about_x", { actor: null, appUserId: w.x, ip: "10.0.0.4", ua: "UA-x4" });
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await pgPool.end();
  }
});

describe("F-151 data-subject export (DB-backed)", () => {
  it("holds the subject's data and none of the other people's", async () => {
    const doc = await buildUserDataExport(w.x);
    expect(doc).not.toBeNull();
    expect(doc!.organizationScope).toBeNull();
    expect(doc!.profile).toMatchObject({ appUserId: w.x, primaryEmail: X_EMAIL });
    expect(doc!.authentication).toMatchObject({ name: "Xavier Subject", email: X_EMAIL });
    expect(doc!.preferences).toMatchObject({ locale: "fr", timeZone: "Europe/Kyiv" });
    expect(doc!.memberships.map((m) => m.organizationId)).toEqual([w.orgA]);
    expect(doc!.roles.map((r) => r.roleId)).toEqual([w.role]);
    expect(doc!.groups.map((g) => g.groupId)).toEqual([w.group]);
    expect(doc!.linkedAccounts.map((a) => a.providerId).sort()).toEqual(["credential", "github"]);
    expect(doc!.sessions).toEqual([expect.objectContaining({ ipAddress: "10.0.0.1" })]);
    expect(doc!.apiKeys).toEqual([
      expect.objectContaining({ id: w.apiKey, keyPrefix: "drk_f151", lastUsedIp: "10.0.0.7" }),
    ]);
    expect(doc!.oauthClients.map((c) => c.id)).toEqual([w.client]);
    expect(doc!.invitations.map((i) => i.id).sort()).toEqual(
      [w.pendingInvite, w.acceptedInvite].sort(),
    );

    const events = new Map(doc!.auditEvents.map((e) => [e.eventType.slice(PREFIX.length), e]));
    expect([...events.keys()].sort()).toEqual(
      ["anon_about_x", "x_login", "x_on_y", "z_invites_x", "z_on_x", "z_refuses_x"].sort(),
    );
    // An administrator's request about the subject: the facts, not the admin's address.
    expect(events.get("z_on_x")).toMatchObject({
      role: "subject",
      actedBySelf: false,
      email: X_EMAIL,
      reason: "support ticket",
      metadata: { fields: ["displayName"] },
      ipAddress: null,
      userAgent: null,
    });
    // The subject acting on someone else: their own address, not the other person's data.
    expect(events.get("x_on_y")).toMatchObject({
      role: "actor",
      actedBySelf: true,
      email: null,
      reason: null,
      metadata: null,
      ipAddress: "10.0.0.2",
      userAgent: "UA-x2",
    });
    // Named by address only, case-insensitively.
    expect(events.get("z_refuses_x")).toMatchObject({ role: "subject", ipAddress: null });
    // Named only in metadata (the invitation an administrator sent them).
    expect(events.get("z_invites_x")).toMatchObject({
      role: "subject",
      actedBySelf: false,
      email: null,
      metadata: { invitationId: w.pendingInvite, email: X_EMAIL },
      ipAddress: null,
      userAgent: null,
    });
    expect(events.get("x_login")).toMatchObject({ actedBySelf: true, ipAddress: "10.0.0.1" });

    const text = JSON.stringify(doc);
    for (const foreign of [
      Y_EMAIL,
      Y_BA,
      Z_BA,
      "10.0.0.3",
      "10.0.0.9",
      "yolanda detail",
      "about yolanda",
      `${PREFIX}session-token-x-${RUN}`,
      `password-hash-x-${RUN}`,
      `gho_token_x_${RUN}`,
      `key-hash-${RUN}`,
      `client-secret-hash-${RUN}`,
    ]) {
      expect(text, `export leaks ${foreign}`).not.toContain(foreign);
    }
  });

  it("an organization administrator's export holds only that organization's rows", async () => {
    const doc = await buildUserDataExport(w.x, { organizationId: w.orgA });
    expect(doc!.organizationScope).toBe(w.orgA);
    expect(doc!.memberships.map((m) => m.organizationId)).toEqual([w.orgA]);
    expect(doc!.invitations.map((i) => i.id)).toEqual([w.acceptedInvite]);
    // The org-less OAuth client and every org-less or org-B audit row stay out.
    expect(doc!.oauthClients).toEqual([]);
    expect(doc!.apiKeys.map((k) => k.id)).toEqual([w.apiKey]);
    expect(doc!.auditEvents.map((e) => e.eventType.slice(PREFIX.length)).sort()).toEqual([
      "x_on_y",
      "z_on_x",
    ]);
    // Account-level sections are the same as the person's own.
    expect(doc!.sessions).toHaveLength(1);
  });

  it("returns null for an id no account has", async () => {
    expect(await buildUserDataExport(randomUUID())).toBeNull();
  });
});

describe("F-151 app_users_pseudonymise (DB-backed)", () => {
  it("refuses an account that is not soft-deleted, and an unknown id", async () => {
    const active = await pgErrorOf(() => pseudonymiseUser(w.x));
    expect(isNotDeactivatedError(active)).toBe(true);
    expect(active.message).toMatch(/not deactivated: soft-delete the account first/);
    const unknown = await pgErrorOf(() => pseudonymiseUser(randomUUID()));
    expect(unknown.code).toBe("P0002");
    // Nothing changed, and a refused call records nothing.
    const row = await db
      .selectFrom("app_users")
      .select(["primary_email"])
      .where("id", "=", w.x)
      .executeTakeFirstOrThrow();
    expect(row.primary_email).toBe(X_EMAIL);
    expect(
      await countOf(
        `select count(*) as n from app_audit_events
          where event_type = 'db.user.pseudonymised' and app_user_id = $1`,
        [w.x],
      ),
    ).toBe(0);
  });

  it("run AS THE RUNTIME ROLE, replaces every PII column it claims to and keeps the trail and the keys", async () => {
    await db
      .updateTable("app_users")
      .set({ status: "deactivated" })
      .where("id", "=", w.x)
      .execute();
    const auditBefore = await countOf(
      `select count(*) as n from app_audit_events where event_type like $1`,
      [`${PREFIX}%`],
    );
    const zOnXBefore = await auditById("z_on_x");
    const pseudonym = erasedEmailFor(w.x);

    // The runtime credential holds no UPDATE on the audit table and no DELETE
    // on it: only the owner-owned function can do this.
    const client: PoolClient = await pgPool.connect();
    let result: Record<string, unknown>;
    try {
      await client.query("begin");
      await client.query(`set local role "${RUNTIME_ROLE}"`);
      const { rows } = await client.query<{ result: Record<string, unknown> }>(
        `select app_users_pseudonymise($1::uuid) as result`,
        [w.x],
      );
      result = rows[0]!.result;
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    expect(result).toEqual({
      pseudonym,
      alreadyErased: false,
      sessions: 1,
      accounts: 2,
      verifications: 1,
      localePreferences: 1,
      apiKeys: 1,
      oauthClients: 1,
      invitations: 2,
      outbox: 2,
      auditEvents: 6,
    });

    // app_users + Better Auth identity.
    const user = await db
      .selectFrom("app_users")
      .select(["primary_email", "display_name", "status"])
      .where("id", "=", w.x)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ primary_email: pseudonym, display_name: null, status: "deactivated" });
    expect(isErasedAccount({ appUserId: w.x, primaryEmail: user.primary_email })).toBe(true);
    const { rows: authRows } = await pgPool.query(
      `select email, name, image, banned from "user" where id = $1`,
      [X_BA],
    );
    expect(authRows[0]).toMatchObject({ email: pseudonym, name: "Erased user", image: null });

    // Sessions, sign-in methods, reset tokens, preferences: gone for X only.
    for (const table of ["session", "account"]) {
      expect(
        await countOf(`select count(*) as n from "${table}" where "userId" = $1`, [X_BA]),
      ).toBe(0);
      expect(
        await countOf(`select count(*) as n from "${table}" where "userId" = $1`, [Y_BA]),
      ).toBeGreaterThan(0);
    }
    expect(await countOf(`select count(*) as n from "verification" where value = $1`, [X_BA])).toBe(
      0,
    );
    expect(await countOf(`select count(*) as n from "verification" where value = $1`, [Y_BA])).toBe(
      1,
    );
    expect(
      await countOf(
        `select count(*) as n from app_user_locale_preferences where app_user_id = $1`,
        [w.x],
      ),
    ).toBe(0);

    // Credentials revoked, the key's last address cleared.
    expect(
      await db
        .selectFrom("app_api_keys")
        .select(["status", "last_used_ip", "revoked_reason"])
        .where("id", "=", w.apiKey)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "revoked", last_used_ip: null, revoked_reason: "owner_deleted" });
    expect(
      (
        await db
          .selectFrom("app_oauth_clients")
          .select("status")
          .where("id", "=", w.client)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("revoked");

    // Invitations: both addresses (the current one and the one learned from the
    // accepted invitation) pseudonymised; the pending one can no longer be used.
    const invites = await db
      .selectFrom("app_organization_invitations")
      .select(["id", "email", "status"])
      .where("id", "in", [w.pendingInvite, w.acceptedInvite])
      .execute();
    expect(new Map(invites.map((i) => [i.id, i]))).toEqual(
      new Map([
        [w.pendingInvite, { id: w.pendingInvite, email: pseudonym, status: "revoked" }],
        [w.acceptedInvite, { id: w.acceptedInvite, email: pseudonym, status: "accepted" }],
      ]),
    );

    // Outbox: blanked, and the pending row will never be sent.
    const mails = await db
      .selectFrom("app_outbox")
      .select([
        "id",
        "to_email",
        "subject",
        "body_html",
        "body_text",
        "variables",
        "delivery_payload",
        "status",
        "error",
      ])
      .where("template_key", "like", `${PREFIX}%`)
      .execute();
    const byId = new Map(mails.map((m) => [m.id, m]));
    expect(byId.get(w.pendingMail)).toMatchObject({
      to_email: pseudonym,
      subject: "[erased]",
      body_html: "",
      body_text: null,
      variables: {},
      delivery_payload: null,
      status: "failed",
      error: "recipient_erased",
    });
    expect(byId.get(w.relatedMail)).toMatchObject({ to_email: pseudonym, status: "sent" });
    expect(mails.find((m) => m.to_email === Y_EMAIL)).toMatchObject({ subject: "Hello Xavier" });

    // The audit trail: every row kept, PII replaced only where it is X's.
    expect(
      await countOf(`select count(*) as n from app_audit_events where event_type like $1`, [
        `${PREFIX}%`,
      ]),
    ).toBe(auditBefore);
    expect(await auditById("x_login")).toMatchObject({ ip_address: null, user_agent: null });
    const zOnX = await auditById("z_on_x");
    expect(zOnX).toMatchObject({ email: pseudonym, ip_address: "10.0.0.9", user_agent: "UA-z" });
    // Nothing else on the row moved (the trigger would have refused it anyway).
    const { email: _e1, ...zOnXRest } = zOnX;
    const { email: _e2, ...zOnXBeforeRest } = zOnXBefore;
    expect(zOnXRest).toEqual(zOnXBeforeRest);
    expect(await auditById("x_on_y")).toMatchObject({
      email: Y_EMAIL,
      ip_address: null,
      user_agent: null,
      metadata: { note: "yolanda detail" },
    });
    expect(await auditById("z_refuses_x")).toMatchObject({
      email: pseudonym,
      ip_address: "10.0.0.9",
    });
    // The invitation row: the address in metadata is replaced, the rest of the
    // metadata and every other column (the administrator's IP included) stay.
    const invited = await auditById("z_invites_x");
    expect(invited).toMatchObject({
      email: null,
      ip_address: "10.0.0.9",
      user_agent: "UA-z",
      metadata: {
        organizationId: w.orgB,
        invitationId: w.pendingInvite,
        email: pseudonym,
        roleId: null,
        emailStatus: "sent",
      },
    });
    expect(JSON.stringify(invited).toLowerCase()).not.toContain(X_EMAIL.toLowerCase());
    expect(await auditById("anon_about_x")).toMatchObject({ ip_address: null, user_agent: null });
    expect(await auditById("y_login")).toMatchObject({
      ip_address: "10.0.0.3",
      user_agent: "UA-y",
    });

    // The function records itself, whoever calls it: a direct call with the
    // runtime credential leaves this row as surely as the admin route does.
    const { rows: sessionRows } = await pgPool.query<{ s: string }>(
      `select session_user::text as s`,
    );
    const own = await db
      .selectFrom("app_audit_events")
      .selectAll()
      .where("event_type", "=", "db.user.pseudonymised")
      .where("app_user_id", "=", w.x)
      .execute();
    expect(own).toHaveLength(1);
    const { pseudonym: _p, alreadyErased: _a, ...counts } = result;
    expect(own[0]).toMatchObject({
      outcome: "success",
      actor_better_auth_user_id: null,
      organization_id: null,
      email: pseudonym,
      ip_address: null,
      user_agent: null,
      metadata: {
        alreadyErased: false,
        counts,
        sessionUser: sessionRows[0]!.s,
        role: RUNTIME_ROLE,
      },
    });

    // Referential integrity: every row that referenced X still does, and
    // resolves (the two fixtures about X, and the function's own row).
    expect(
      await countOf(
        `select count(*) as n from app_audit_events e join app_users u on u.id = e.app_user_id
          where e.app_user_id = $1`,
        [w.x],
      ),
    ).toBe(3);
    expect(
      await countOf(
        `select count(*) as n from app_organization_memberships where app_user_id = $1`,
        [w.x],
      ),
    ).toBe(1);
    expect(
      await countOf(`select count(*) as n from app_user_roles where app_user_id = $1`, [w.x]),
    ).toBe(1);

    // The other user is untouched.
    expect(
      await db
        .selectFrom("app_users")
        .select(["primary_email", "display_name"])
        .where("id", "=", w.y)
        .executeTakeFirstOrThrow(),
    ).toEqual({ primary_email: Y_EMAIL, display_name: "Yolanda Other" });
  });

  it("leaves the append-only trigger refusing every ordinary UPDATE, and the exemption as narrow as claimed", async () => {
    const id = w.audit.z_on_x!;
    // An ordinary UPDATE from the owner, without the marker.
    const plain = await pgErrorOf(() =>
      db
        .updateTable("app_audit_events")
        .set({ email: "tampered@x.test" })
        .where("id", "=", id)
        .execute(),
    );
    expect(plain.code).toBe("23514");
    expect(plain.message).toMatch(/append-only: UPDATE is not permitted/);

    // The owner WITH the marker still cannot touch any other column, put an
    // arbitrary address in, or add an IP address; in metadata it may only
    // replace an existing `email` key with a pseudonym (the invitation row).
    const invited = w.audit.z_invites_x!;
    const otherPseudonym = erasedEmailFor(randomUUID());
    const client = await pgPool.connect();
    try {
      for (const [statement, args] of [
        [`update app_audit_events set reason = 'tampered' where id = $1`, [id]],
        [`update app_audit_events set metadata = '{}'::jsonb where id = $1`, [id]],
        [`update app_audit_events set email = 'someone@else.test' where id = $1`, [id]],
        [`update app_audit_events set email = null where id = $1`, [id]],
        [`update app_audit_events set ip_address = '192.0.2.1' where id = $1`, [id]],
        // No `email` key to replace: adding one, even a pseudonym, is refused.
        [
          `update app_audit_events set metadata = metadata || jsonb_build_object('email', $2::text) where id = $1`,
          [id, otherPseudonym],
        ],
        [
          `update app_audit_events set metadata = jsonb_set(metadata, '{email}', '"someone@else.test"') where id = $1`,
          [invited],
        ],
        [`update app_audit_events set metadata = metadata - 'email' where id = $1`, [invited]],
        [
          `update app_audit_events set metadata = jsonb_set(metadata, '{roleId}', '"r-1"') where id = $1`,
          [invited],
        ],
        [
          `update app_audit_events set metadata = jsonb_set(jsonb_set(metadata, '{email}', to_jsonb($2::text)), '{emailStatus}', '"failed"') where id = $1`,
          [invited, otherPseudonym],
        ],
      ] as const) {
        await client.query("begin");
        await client.query(`set local app.audit_pseudonymise = 'on'`);
        const err = await pgErrorOf(() => client.query(statement, [...args]));
        await client.query("rollback");
        expect(err.code, statement).toBe("23514");
      }

      // A role that is NOT the owner, holds UPDATE and sets the marker: refused
      // (the owner half), exactly as for the retention DELETE. Needs a
      // superuser test connection for SET ROLE, as schema-integrity does.
      const role = "__dbtest_f151_audit_updater";
      await client.query("begin");
      try {
        await client.query(`create role "${role}" nologin`);
        await client.query(`grant usage on schema "${DB_SCHEMA}" to "${role}"`);
        await client.query(`grant select, update on app_audit_events to "${role}"`);
        await client.query(`set local role "${role}"`);
        await client.query(`set local app.audit_pseudonymise = 'on'`);
        const err = await pgErrorOf(() =>
          client.query(`update app_audit_events set ip_address = null where id = $1`, [id]),
        );
        expect(err.code).toBe("23514");
        expect(err.message).toMatch(new RegExp(`current_user=${role}\\)`));
      } finally {
        await client.query("rollback");
      }

      // And the runtime role has no UPDATE privilege on the table at all.
      await client.query("begin");
      try {
        await client.query(`set local role "${RUNTIME_ROLE}"`);
        const err = await pgErrorOf(() =>
          client.query(`update app_audit_events set ip_address = null where id = $1`, [id]),
        );
        expect(err.code).toBe("42501");
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
    }

    // DELETE is still refused without the retention path.
    const del = await pgErrorOf(() =>
      db.deleteFrom("app_audit_events").where("id", "=", id).execute(),
    );
    expect(del.code).toBe("23514");
  });

  it("is idempotent: a second call finds nothing to change", async () => {
    const snapshot = async () => ({
      user: await db.selectFrom("app_users").selectAll().where("id", "=", w.x).executeTakeFirst(),
      audit: await db
        .selectFrom("app_audit_events")
        .selectAll()
        .where("event_type", "like", `${PREFIX}%`)
        .orderBy("id")
        .execute(),
      invites: await db
        .selectFrom("app_organization_invitations")
        .selectAll()
        .where("id", "in", [w.pendingInvite, w.acceptedInvite])
        .orderBy("id")
        .execute(),
      mail: await db
        .selectFrom("app_outbox")
        .selectAll()
        .where("template_key", "like", `${PREFIX}%`)
        .orderBy("id")
        .execute(),
    });
    const before = await snapshot();
    const again = await pseudonymiseUser(w.x);
    expect(again).toEqual({
      pseudonym: erasedEmailFor(w.x),
      alreadyErased: true,
      sessions: 0,
      accounts: 0,
      verifications: 0,
      localePreferences: 0,
      apiKeys: 0,
      oauthClients: 0,
      invitations: 0,
      outbox: 0,
      auditEvents: 0,
    });
    expect(await snapshot()).toEqual(before);
    // Nothing changed, but the call is still on record.
    const own = await db
      .selectFrom("app_audit_events")
      .select(["metadata"])
      .where("event_type", "=", "db.user.pseudonymised")
      .where("app_user_id", "=", w.x)
      .orderBy("created_at", "desc")
      .execute();
    expect(own).toHaveLength(2);
    expect(own.map((r) => (r.metadata as { alreadyErased: boolean }).alreadyErased).sort()).toEqual(
      [false, true],
    );
  });

  it("the function is SECURITY DEFINER with a pinned search_path, not PUBLIC-executable, and runtime-executable", async () => {
    const { rows } = await sql<{ prosecdef: boolean; proconfig: string[] | null }>`
      select p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'app_users_pseudonymise' and n.nspname = current_schema()
    `.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.proconfig?.some((c) => c.startsWith("search_path="))).toBe(true);
    const priv = await sql<{ pub: boolean; rt: boolean }>`
      select has_function_privilege('public', 'app_users_pseudonymise(uuid)', 'execute') as pub,
             has_function_privilege(${RUNTIME_ROLE}::name, 'app_users_pseudonymise(uuid)', 'execute') as rt
    `.execute(db);
    expect(priv.rows[0]).toEqual({ pub: false, rt: true });
  });
});
