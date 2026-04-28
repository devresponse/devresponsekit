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
}

export interface AppOrganizationMembershipsTable {
  id: Generated<string>;
  organization_id: string;
  app_user_id: string;
  status: ColumnType<string, string | undefined, string>;
  source_provider: string | null;
  provider_organization_key: string | null;
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
}

export type AppOrganization = Selectable<AppOrganizationsTable>;
export type NewAppOrganization = Insertable<AppOrganizationsTable>;
export type AppOrganizationUpdate = Updateable<AppOrganizationsTable>;

export type AppUser = Selectable<AppUsersTable>;
export type NewAppUser = Insertable<AppUsersTable>;
export type AppUserUpdate = Updateable<AppUsersTable>;

export type AppEnterpriseApplication = Selectable<AppEnterpriseApplicationsTable>;
