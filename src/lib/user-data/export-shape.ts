/**
 * F-151 — the data-subject export document, and the rule that keeps it to the
 * subject's OWN data.
 *
 * `buildUserDataExport` (`export.server.ts`) reads the rows; this pure module
 * decides what of each row goes out, so the rule is unit-testable without a
 * database. The one table where that is a real decision is the audit log: a
 * row can name the person as its SUBJECT (`app_user_id`, `email` holding one
 * of their addresses, or `metadata.email` doing so, which is where the
 * `admin.organization.invitation_created` row keeps the invitee's address) or
 * as its ACTOR (`actor_better_auth_user_id`), and the other columns belong to
 * whoever the row is about or whoever made the request:
 *
 *   - `ip_address` / `user_agent` describe the REQUEST. They go out only when
 *     the person made it (they are the actor). An administrator acting on them
 *     leaves the administrator's address on the row, which is not theirs.
 *   - `email`, `reason` and `metadata` describe the SUBJECT. They go out only
 *     on a row about the person. A row where they acted on someone else (an
 *     invitation they sent, an admin action they took) keeps its facts (what,
 *     when, where, from which address) and drops the other person's address and
 *     the details about them.
 *   - the actor's id never goes out; `actedBySelf` says whether it was them.
 *
 * Secrets never reach this module: the queries select no token, password hash,
 * key hash or client secret.
 */

export const USER_DATA_EXPORT_FORMAT = "devresponse.user-data-export";
export const USER_DATA_EXPORT_VERSION = 1;

/**
 * The newest audit rows an export carries. An account's own trail is bounded by
 * retention (`AUDIT_RETENTION_DAYS`), but an administrator's actor rows are
 * not small, and the document is built in memory; past the cap the export says
 * `auditEventsTruncated: true`, and the rest is in the audit log.
 */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

type Timestamp = Date | string | null;

export function iso(value: Timestamp): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Who the export is about: the ids and the lowercased addresses rows may name. */
export interface ExportSubject {
  appUserId: string;
  betterAuthUserId: string;
  emails: ReadonlySet<string>;
}

/** An `app_audit_events` row as the export query selects it. */
export interface AuditRowForExport {
  id: string;
  created_at: Timestamp;
  event_type: string;
  outcome: string;
  actor_better_auth_user_id: string | null;
  app_user_id: string | null;
  organization_id: string | null;
  target_application_id: string | null;
  provider: string | null;
  email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
  request_id: string | null;
  metadata: unknown;
}

export interface ExportedAuditEvent {
  id: string;
  createdAt: string | null;
  eventType: string;
  outcome: string;
  /** `subject`: the row is about the person; `actor`: they acted on someone or something else. */
  role: "subject" | "actor";
  actedBySelf: boolean;
  organizationId: string | null;
  targetApplicationId: string | null;
  provider: string | null;
  requestId: string | null;
  email: string | null;
  reason: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
}

function namesSubjectEmail(email: string | null, subject: ExportSubject): boolean {
  return email !== null && subject.emails.has(email.toLowerCase());
}

/** `metadata.email` when it is a string, else null (the erasure rewrites the same key). */
function metadataEmail(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const email = (metadata as Record<string, unknown>).email;
  return typeof email === "string" ? email : null;
}

/** One audit row as the export carries it (see the module doc for the rule). */
export function shapeAuditEvent(
  row: AuditRowForExport,
  subject: ExportSubject,
): ExportedAuditEvent {
  const actedBySelf = row.actor_better_auth_user_id === subject.betterAuthUserId;
  const aboutSubject =
    row.app_user_id === subject.appUserId ||
    namesSubjectEmail(row.email, subject) ||
    namesSubjectEmail(metadataEmail(row.metadata), subject);
  return {
    id: row.id,
    createdAt: iso(row.created_at),
    eventType: row.event_type,
    outcome: row.outcome,
    role: aboutSubject ? "subject" : "actor",
    actedBySelf,
    organizationId: row.organization_id,
    targetApplicationId: row.target_application_id,
    provider: row.provider,
    requestId: row.request_id,
    email: aboutSubject && namesSubjectEmail(row.email, subject) ? row.email : null,
    reason: aboutSubject ? row.reason : null,
    metadata: aboutSubject ? (row.metadata ?? {}) : null,
    ipAddress: actedBySelf ? row.ip_address : null,
    userAgent: actedBySelf ? row.user_agent : null,
  };
}

export interface UserDataExport {
  format: typeof USER_DATA_EXPORT_FORMAT;
  version: typeof USER_DATA_EXPORT_VERSION;
  generatedAt: string;
  /**
   * `null`: the whole account (the person's own export, or a superadmin's).
   * An organization id: an organization administrator's export, which holds
   * only that organization's rows of the organization-attributed sections
   * (memberships, roles, groups, API keys, OAuth clients, invitations, audit
   * events), the tenant boundary every other console read applies (ADR-0001).
   */
  organizationScope: string | null;
  profile: {
    appUserId: string;
    betterAuthUserId: string;
    primaryEmail: string;
    displayName: string | null;
    status: string;
    preferredLocale: string;
    createdAt: string | null;
    updatedAt: string | null;
    deactivatedAt: string | null;
  };
  /** The Better Auth identity (`null` for an MCP agent's service account, which has none). */
  authentication: {
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string | null;
  } | null;
  preferences: {
    locale: string;
    timeZone: string | null;
    dateFormat: string | null;
    numberFormatLocale: string | null;
    updatedAt: string | null;
  } | null;
  memberships: Array<{
    organizationId: string;
    organizationSlug: string;
    organizationName: string;
    status: string;
    sourceProvider: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  roles: Array<{
    organizationId: string;
    roleId: string;
    roleKey: string;
    roleName: string;
    assignedAt: string | null;
  }>;
  groups: Array<{
    groupId: string;
    organizationId: string;
    groupKey: string;
    groupName: string;
    joinedAt: string | null;
  }>;
  /** Sign-in methods: `credential` (a password, never its hash) and each linked social provider. */
  linkedAccounts: Array<{ providerId: string; accountId: string; createdAt: string | null }>;
  /** Sessions without their tokens. */
  sessions: Array<{
    createdAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    impersonated: boolean;
  }>;
  /** API keys without their hashes. */
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    organizationId: string | null;
    scopes: string[];
    status: string;
    createdAt: string | null;
    expiresAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    revokedAt: string | null;
    revokedReason: string | null;
  }>;
  /** OAuth clients acting as the account, without their secrets. */
  oauthClients: Array<{
    id: string;
    clientId: string;
    name: string;
    organizationId: string | null;
    scopes: string[];
    status: string;
    createdAt: string | null;
    revokedAt: string | null;
  }>;
  /** Invitations addressed to one of the person's addresses, or accepted by them. */
  invitations: Array<{
    id: string;
    organizationId: string;
    email: string;
    status: string;
    createdAt: string | null;
    expiresAt: string | null;
    acceptedAt: string | null;
    revokedAt: string | null;
  }>;
  auditEvents: ExportedAuditEvent[];
  auditEventsTruncated: boolean;
}

/** Section sizes, for the export's audit row (never the data itself). */
export function exportCounts(doc: UserDataExport): Record<string, number> {
  return {
    memberships: doc.memberships.length,
    roles: doc.roles.length,
    groups: doc.groups.length,
    linkedAccounts: doc.linkedAccounts.length,
    sessions: doc.sessions.length,
    apiKeys: doc.apiKeys.length,
    oauthClients: doc.oauthClients.length,
    invitations: doc.invitations.length,
    auditEvents: doc.auditEvents.length,
  };
}

/** `user-data-<appUserId>-<yyyymmdd>.json`, safe in a `Content-Disposition` header. */
export function exportFilename(doc: Pick<UserDataExport, "profile" | "generatedAt">): string {
  const day = doc.generatedAt.slice(0, 10).replace(/-/g, "");
  return `user-data-${doc.profile.appUserId}-${day}.json`;
}
