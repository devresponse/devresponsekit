import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/*
 * Application-managed Kysely schema.
 *
 * Better Auth owns its own tables (user, account, session, verification, ...)
 * and is configured separately. These types describe the *application*
 * tables defined in `migrations/0001-app-core.sql`.
 *
 * Roles, memberships, permissions, and account status MUST live here so
 * that authorization decisions are made against application data and not
 * against Better Auth core tables.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | unknown, string | unknown>;

export interface AppOrganizationsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: ColumnType<string, string | undefined, string>;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AppProviderOrganizationsTable {
  id: Generated<string>;
  organization_id: string;
  provider: string;
  provider_organization_key: string;
  display_name: string | null;
  created_at: Generated<Timestamp>;
}

export interface AppUsersTable {
  id: Generated<string>;
  better_auth_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: ColumnType<string, string | undefined, string>;
  status_reason: string | null;
  preferred_locale: ColumnType<string, string | undefined, string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deactivated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  deactivated_by: ColumnType<string | null, string | null | undefined, string | null>;
  deactivated_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface AppOrganizationMembershipsTable {
  id: Generated<string>;
  organization_id: string;
  app_user_id: string;
  status: ColumnType<string, string | undefined, string>;
  source_provider: string | null;
  provider_organization_key: string | null;
  /**
   * Snapshot of the membership status taken when an admin soft-deleted
   * the owning user (plan §4.1). Set by the cascade in DELETE
   * `/api/administrator/users/[id]` and cleared by `/restore`. NULL
   * outside that lifecycle.
   */
  pre_deactivation_status: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AppRolesTable {
  id: Generated<string>;
  organization_id: string | null;
  key: string;
  name: string;
  description: string | null;
  created_at: Generated<Timestamp>;
}

export interface AppPermissionsTable {
  id: Generated<string>;
  key: string;
  description: string | null;
}

export interface AppRolePermissionsTable {
  role_id: string;
  permission_id: string;
}

export interface AppUserRolesTable {
  app_user_id: string;
  organization_id: string;
  role_id: string;
  created_at: Generated<Timestamp>;
}

export interface AppEnterpriseApplicationsTable {
  id: string;
  organization_id: string | null;
  label: string;
  description: string | null;
  origin: string;
  subdomain: string;
  sso_audience: string;
  status: ColumnType<string, string | undefined, string>;
  sort_order: ColumnType<number, number | undefined, number>;
  created_at: Generated<Timestamp>;
}

export interface AppSsoHandoffNoncesTable {
  jti: string;
  app_user_id: string;
  target_application_id: string;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface AppAuditEventsTable {
  id: Generated<string>;
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
  /**
   * Correlation id (UUID) shared with the originating request's
   * `x-request-id` response header. NULL on legacy rows written before
   * migration `0003-audit-request-id-and-membership-snapshot.sql`.
   */
  request_id: ColumnType<string | null, string | null | undefined, string | null>;
  metadata: Json;
  created_at: Generated<Timestamp>;
}

export interface AppUserLocalePreferencesTable {
  app_user_id: string;
  locale: ColumnType<string, string | undefined, string>;
  time_zone: string | null;
  date_format: string | null;
  number_format_locale: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AppDatabase {
  app_organizations: AppOrganizationsTable;
  app_provider_organizations: AppProviderOrganizationsTable;
  app_users: AppUsersTable;
  app_organization_memberships: AppOrganizationMembershipsTable;
  app_roles: AppRolesTable;
  app_permissions: AppPermissionsTable;
  app_role_permissions: AppRolePermissionsTable;
  app_user_roles: AppUserRolesTable;
  app_enterprise_applications: AppEnterpriseApplicationsTable;
  app_sso_handoff_nonces: AppSsoHandoffNoncesTable;
  app_audit_events: AppAuditEventsTable;
  app_user_locale_preferences: AppUserLocalePreferencesTable;
  session: BetterAuthSessionTable;
  user: BetterAuthUserTable;
}

/*
 * Better Auth-owned tables, typed READ-ONLY (inserts/updates are
 * `never`) for reporting queries such as the Administrator overview's
 * recent-logins list. All writes to these tables go through the Better
 * Auth API — never through Kysely. Column names are camelCase because
 * Better Auth creates them quoted.
 */
export interface BetterAuthSessionTable {
  id: ColumnType<string, never, never>;
  token: ColumnType<string, never, never>;
  userId: ColumnType<string, never, never>;
  createdAt: ColumnType<Date, never, never>;
  updatedAt: ColumnType<Date, never, never>;
  expiresAt: ColumnType<Date, never, never>;
  ipAddress: ColumnType<string | null, never, never>;
  userAgent: ColumnType<string | null, never, never>;
  impersonatedBy: ColumnType<string | null, never, never>;
}

export interface BetterAuthUserTable {
  id: ColumnType<string, never, never>;
  name: ColumnType<string, never, never>;
  email: ColumnType<string, never, never>;
  createdAt: ColumnType<Date, never, never>;
}

export type AppOrganization = Selectable<AppOrganizationsTable>;
export type NewAppOrganization = Insertable<AppOrganizationsTable>;
export type AppOrganizationUpdate = Updateable<AppOrganizationsTable>;

export type AppUser = Selectable<AppUsersTable>;
export type NewAppUser = Insertable<AppUsersTable>;
export type AppUserUpdate = Updateable<AppUsersTable>;

export type AppEnterpriseApplication = Selectable<AppEnterpriseApplicationsTable>;
