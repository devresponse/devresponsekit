import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import {
  AUDIT_EXPORT_MAX_ROWS,
  iso,
  shapeAuditEvent,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_VERSION,
  type ExportSubject,
  type UserDataExport,
} from "@/lib/user-data/export-shape";

/**
 * F-151 — ONE PERSON'S DATA, AS ONE JSON DOCUMENT (GDPR Art. 15, PIPEDA
 * access requests).
 *
 * Shared by the self-service export (`GET /api/account/export`) and the
 * administrator one (`GET /api/administrator/users/[id]/export`); the routes
 * decide who may ask, this decides what the answer holds. Every query is keyed
 * on the subject's own ids or addresses, never on anything the request names
 * beyond the resolved `appUserId`, and selects no secret: no session token, no
 * password hash or provider token (`account` is typed without them), no API
 * key hash, no client secret. The audit rows go through `shapeAuditEvent`,
 * which drops what on a row is someone else's (`export-shape.ts`).
 *
 * The subject's addresses are its `primary_email`, its Better Auth email and
 * the address of every invitation it accepted, lowercased — the same set
 * `app_users_pseudonymise` (migration 0008) erases, so an export and an erasure
 * cover the same rows.
 *
 * `organizationId` confines the organization-attributed sections to one
 * tenant, for an organization administrator's export (the route passes its
 * org scope; the person's own export and a superadmin's pass nothing). The
 * account-level sections (profile, identity, preferences, sessions, sign-in
 * methods) are the same either way: the route only lets an organization
 * administrator export a user confined to their organization (AUTHZ-2), whose
 * sessions they may already list. Audit rows with no organization are
 * superadmin-only, as in the per-user audit tab.
 *
 * Returns `null` when no `app_users` row has that id.
 */
export async function buildUserDataExport(
  appUserId: string,
  options: { organizationId?: string | null; now?: Date } = {},
): Promise<UserDataExport | null> {
  const orgId = options.organizationId ?? null;
  const now = options.now ?? new Date();
  const user = await db
    .selectFrom("app_users")
    .select([
      "id",
      "better_auth_user_id",
      "primary_email",
      "display_name",
      "status",
      "preferred_locale",
      "created_at",
      "updated_at",
      "deactivated_at",
    ])
    .where("id", "=", appUserId)
    .executeTakeFirst();
  if (!user) return null;
  const baId = user.better_auth_user_id;

  const authUser = await db
    .selectFrom("user")
    .select(["name", "email", "emailVerified", "image", "createdAt"])
    .where("id", "=", baId)
    .executeTakeFirst();

  const accepted = await db
    .selectFrom("app_organization_invitations")
    .select("email")
    .where("accepted_app_user_id", "=", user.id)
    .execute();
  const emails = new Set(
    [user.primary_email, authUser?.email, ...accepted.map((row) => row.email)]
      .filter((email): email is string => typeof email === "string" && email.length > 0)
      .map((email) => email.toLowerCase()),
  );
  const subject: ExportSubject = { appUserId: user.id, betterAuthUserId: baId, emails };
  const emailList = [...emails];

  const preferences = await db
    .selectFrom("app_user_locale_preferences")
    .select(["locale", "time_zone", "date_format", "number_format_locale", "updated_at"])
    .where("app_user_id", "=", user.id)
    .executeTakeFirst();

  const memberships = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select([
      "m.organization_id",
      "o.slug",
      "o.name",
      "m.status",
      "m.source_provider",
      "m.created_at",
      "m.updated_at",
    ])
    .where("m.app_user_id", "=", user.id)
    .$if(orgId !== null, (q) => q.where("m.organization_id", "=", orgId!))
    .orderBy("m.created_at")
    .execute();

  const roles = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .select(["ur.organization_id", "ur.role_id", "r.key", "r.name", "ur.created_at"])
    .where("ur.app_user_id", "=", user.id)
    .$if(orgId !== null, (q) => q.where("ur.organization_id", "=", orgId!))
    .orderBy("ur.created_at")
    .execute();

  const groups = await db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .select(["gm.group_id", "g.organization_id", "g.key", "g.name", "gm.created_at"])
    .where("gm.app_user_id", "=", user.id)
    .$if(orgId !== null, (q) => q.where("g.organization_id", "=", orgId!))
    .orderBy("gm.created_at")
    .execute();

  const linkedAccounts = await db
    .selectFrom("account")
    .select(["providerId", "accountId", "createdAt"])
    .where("userId", "=", baId)
    .orderBy("createdAt")
    .execute();

  const sessions = await db
    .selectFrom("session")
    .select(["createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent", "impersonatedBy"])
    .where("userId", "=", baId)
    .orderBy("createdAt", "desc")
    .execute();

  const apiKeys = await db
    .selectFrom("app_api_keys")
    .select([
      "id",
      "name",
      "key_prefix",
      "organization_id",
      "scopes",
      "status",
      "created_at",
      "expires_at",
      "last_used_at",
      "last_used_ip",
      "revoked_at",
      "revoked_reason",
    ])
    .where("app_user_id", "=", user.id)
    .$if(orgId !== null, (q) => q.where("organization_id", "=", orgId!))
    .orderBy("created_at")
    .execute();

  const oauthClients = await db
    .selectFrom("app_oauth_clients")
    .select([
      "id",
      "client_id",
      "name",
      "organization_id",
      "scopes",
      "status",
      "created_at",
      "revoked_at",
    ])
    .where("app_user_id", "=", user.id)
    .$if(orgId !== null, (q) => q.where("organization_id", "=", orgId!))
    .orderBy("created_at")
    .execute();

  const invitations = await db
    .selectFrom("app_organization_invitations")
    .select([
      "id",
      "organization_id",
      "email",
      "status",
      "created_at",
      "expires_at",
      "accepted_at",
      "revoked_at",
    ])
    .where((eb) =>
      eb.or([
        eb("accepted_app_user_id", "=", user.id),
        eb(eb.fn<string>("lower", ["email"]), "in", emailList),
      ]),
    )
    .$if(orgId !== null, (q) => q.where("organization_id", "=", orgId!))
    .orderBy("created_at")
    .execute();

  // Newest first, one row past the cap so a truncation is detected, not guessed.
  const audit = await db
    .selectFrom("app_audit_events")
    .select([
      "id",
      "created_at",
      "event_type",
      "outcome",
      "actor_better_auth_user_id",
      "app_user_id",
      "organization_id",
      "target_application_id",
      "provider",
      "email",
      "ip_address",
      "user_agent",
      "reason",
      "request_id",
      "metadata",
    ])
    .where((eb) =>
      eb.or([
        eb("app_user_id", "=", user.id),
        eb("actor_better_auth_user_id", "=", baId),
        eb(eb.fn<string>("lower", ["email"]), "in", emailList),
        // `admin.organization.invitation_created` names the invitee only here
        // (no email column, no subject id); the erasure rewrites the same key.
        eb(sql<string>`lower(metadata ->> 'email')`, "in", emailList),
      ]),
    )
    .$if(orgId !== null, (q) => q.where("organization_id", "=", orgId!))
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(AUDIT_EXPORT_MAX_ROWS + 1)
    .execute();

  return {
    format: USER_DATA_EXPORT_FORMAT,
    version: USER_DATA_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    organizationScope: orgId,
    profile: {
      appUserId: user.id,
      betterAuthUserId: baId,
      primaryEmail: user.primary_email,
      displayName: user.display_name,
      status: user.status,
      preferredLocale: user.preferred_locale,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
      deactivatedAt: iso(user.deactivated_at),
    },
    authentication: authUser
      ? {
          name: authUser.name,
          email: authUser.email,
          emailVerified: authUser.emailVerified,
          image: authUser.image,
          createdAt: iso(authUser.createdAt),
        }
      : null,
    preferences: preferences
      ? {
          locale: preferences.locale,
          timeZone: preferences.time_zone,
          dateFormat: preferences.date_format,
          numberFormatLocale: preferences.number_format_locale,
          updatedAt: iso(preferences.updated_at),
        }
      : null,
    memberships: memberships.map((m) => ({
      organizationId: m.organization_id,
      organizationSlug: m.slug,
      organizationName: m.name,
      status: m.status,
      sourceProvider: m.source_provider,
      createdAt: iso(m.created_at),
      updatedAt: iso(m.updated_at),
    })),
    roles: roles.map((r) => ({
      organizationId: r.organization_id,
      roleId: r.role_id,
      roleKey: r.key,
      roleName: r.name,
      assignedAt: iso(r.created_at),
    })),
    groups: groups.map((g) => ({
      groupId: g.group_id,
      organizationId: g.organization_id,
      groupKey: g.key,
      groupName: g.name,
      joinedAt: iso(g.created_at),
    })),
    linkedAccounts: linkedAccounts.map((a) => ({
      providerId: a.providerId,
      accountId: a.accountId,
      createdAt: iso(a.createdAt),
    })),
    sessions: sessions.map((s) => ({
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      expiresAt: iso(s.expiresAt),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      impersonated: s.impersonatedBy !== null,
    })),
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key_prefix,
      organizationId: k.organization_id,
      scopes: k.scopes,
      status: k.status,
      createdAt: iso(k.created_at),
      expiresAt: iso(k.expires_at),
      lastUsedAt: iso(k.last_used_at),
      lastUsedIp: k.last_used_ip,
      revokedAt: iso(k.revoked_at),
      revokedReason: k.revoked_reason,
    })),
    oauthClients: oauthClients.map((c) => ({
      id: c.id,
      clientId: c.client_id,
      name: c.name,
      organizationId: c.organization_id,
      scopes: c.scopes,
      status: c.status,
      createdAt: iso(c.created_at),
      revokedAt: iso(c.revoked_at),
    })),
    invitations: invitations.map((i) => ({
      id: i.id,
      organizationId: i.organization_id,
      email: i.email,
      status: i.status,
      createdAt: iso(i.created_at),
      expiresAt: iso(i.expires_at),
      acceptedAt: iso(i.accepted_at),
      revokedAt: iso(i.revoked_at),
    })),
    auditEvents: audit.slice(0, AUDIT_EXPORT_MAX_ROWS).map((row) => shapeAuditEvent(row, subject)),
    auditEventsTruncated: audit.length > AUDIT_EXPORT_MAX_ROWS,
  };
}
