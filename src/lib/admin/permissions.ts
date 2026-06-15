/**
 * Administrator permission catalog (docs/admin-manager.md §6.1).
 *
 * Extracted to a non-`server-only` module so it can be imported by both
 * the runtime authorization helper (`permissions.server.ts`) AND by
 * tooling like the database seed script (`src/db/seeds/seed-local.ts`)
 * which runs under plain Node and cannot resolve the `server-only`
 * import sentinel.
 *
 * This module MUST stay free of side effects and runtime imports — it
 * only exports static data.
 */
export interface AdminPermissionDescriptor {
  key: string;
  description: string;
}

/**
 * The complete set of administrator permission keys. Adding a new
 * permission requires updating just this list — the seed and the
 * runtime helper both source from here, so they cannot drift.
 */
export const ADMIN_PERMISSION_CATALOG: ReadonlyArray<AdminPermissionDescriptor> = [
  { key: "admin.users.read", description: "Read administrator user lists and details" },
  { key: "admin.users.create", description: "Create new users" },
  { key: "admin.users.update", description: "Edit user attributes" },
  { key: "admin.users.delete", description: "Soft-delete and restore users" },
  { key: "admin.users.manage", description: "Approve, block, suspend, reactivate users" },
  { key: "admin.users.ban", description: "Ban or unban users via Better Auth" },
  { key: "admin.users.setRole", description: "Set Better Auth role on a user" },
  { key: "admin.users.setPassword", description: "Set or reset a user's password" },
  { key: "admin.users.sessions", description: "List or revoke user sessions" },
  { key: "admin.users.impersonate", description: "Impersonate another user" },
  { key: "admin.roles.read", description: "Read application roles and permissions" },
  { key: "admin.roles.create", description: "Create application roles" },
  { key: "admin.roles.update", description: "Edit application roles" },
  { key: "admin.roles.delete", description: "Delete application roles" },
  { key: "admin.roles.assign", description: "Assign or unassign roles to users" },
  { key: "admin.permissions.manage", description: "Manage the permission catalog" },
  { key: "admin.orgs.read", description: "Read organizations and memberships" },
  { key: "admin.orgs.create", description: "Create organizations" },
  { key: "admin.orgs.update", description: "Edit organizations" },
  { key: "admin.orgs.delete", description: "Delete organizations" },
  { key: "admin.orgs.manage", description: "Manage organization members and bindings" },
  { key: "admin.apps.read", description: "Read enterprise application catalog" },
  { key: "admin.apps.manage", description: "Create and edit enterprise applications" },
  { key: "admin.audit.read", description: "Read the audit event log" },
  { key: "admin.email.read", description: "Read the email outbox and templates" },
  { key: "admin.email.manage", description: "Edit email templates and send test emails" },
  { key: "admin.apikeys.read", description: "Read API keys across users and organizations" },
  { key: "admin.apikeys.manage", description: "Revoke and manage any user's API keys" },
  { key: "admin.clients.read", description: "Read OAuth client registrations" },
  { key: "admin.clients.manage", description: "Create, rotate, and revoke OAuth clients" },
] as const;

/**
 * Convenience: just the keys, used by code that only cares about the
 * set of allowed strings (e.g. layout-level "any admin permission" gate).
 */
export const ANY_ADMIN_PERMISSION: ReadonlyArray<string> = ADMIN_PERMISSION_CATALOG.map(
  (p) => p.key,
);

/**
 * The marker permission that elevates a principal to SUPERADMIN — manages
 * EVERY organization; org scoping is bypassed (ADR-0001). `isSuperadmin`
 * checks for exactly this key. Defined in this neutral, non-`server-only`
 * module so the access helpers, the runtime, and the seed share one source.
 */
export const SUPERADMIN_PERMISSION = "superuser";

/**
 * The complete permission set a SUPERADMIN effectively holds, independent of
 * which organization is active. `getUserAccessContext` grants this to any
 * GLOBAL superuser so every permission gate — admin routes, the server-
 * filtered navigation menu, etc. — recognizes them uniformly. This is why the
 * seeded `superuser` ROLE no longer needs to enumerate the whole `admin.*`
 * catalog: a superuser's authority derives from the marker, not from grants.
 */
export const SUPERUSER_PERMISSIONS: ReadonlyArray<string> = [
  "shell.view",
  "audit.view",
  SUPERADMIN_PERMISSION,
  ...ANY_ADMIN_PERMISSION,
];
