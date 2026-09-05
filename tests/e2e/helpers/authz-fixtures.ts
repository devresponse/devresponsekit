import { expect, type APIRequestContext, type TestInfo } from "@playwright/test";
import { ADMIN_API_HEADERS } from "./admin-auth";

/**
 * Tenant / identity fixtures for the authorization-contract e2e suites
 * (review #29). Everything is created through the REAL administrator API as
 * the seeded platform admin — never by writing to the DB — so the fixtures
 * only exist if the same admin surface a human would use lets them exist.
 *
 * CI seeds ONLY `pnpm db:seed` (`src/db/seeds/seed-local.ts`): one `default`
 * organization with the `member` / `admin` / `admin.platform` / `superuser`
 * roles and the seeded admin. A second tenant, its roles and its members do
 * NOT exist in CI, so every suite that needs a cross-org shape builds it here
 * and tears it down again. Names carry a per-run suffix so a re-run against
 * the same database (the local dev DB) never collides with a previous run
 * whose cleanup did not finish.
 *
 * The `api` argument is the seeded admin's `page.request` (it shares the
 * browser context's cookie jar, so the admin session cookie rides along).
 */

export interface OrgRef {
  id: string;
  slug: string;
}

export interface CreatedUser {
  /** `app_users.id` — what the admin routes and `/api/v1/me.appUserId` use. */
  id: string;
  /** Better Auth `user.id` — what `/api/v1/me.betterAuthUserId` reports. */
  betterAuthUserId: string;
  email: string;
  password: string;
}

/** Per-run, per-project suffix — safe for slugs, role keys and emails. */
export function uniqueSuffix(testInfo: TestInfo): string {
  return `${testInfo.project.name}-${Date.now()}`.toLowerCase();
}

/** The seeded `default` organization (the only tenant CI's seed creates). */
export async function findDefaultOrg(api: APIRequestContext): Promise<OrgRef> {
  const res = await api.get("/api/administrator/organizations?q=default&pageSize=50");
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { items: OrgRef[] };
  const org = body.items.find((o) => o.slug === "default");
  expect(org, "seeded default organization should exist").toBeDefined();
  return org!;
}

export async function createOrganization(api: APIRequestContext, slug: string): Promise<OrgRef> {
  const res = await api.post("/api/administrator/organizations", {
    headers: ADMIN_API_HEADERS,
    data: { slug, name: `E2E ${slug}` },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as OrgRef;
}

/**
 * Deleting a tenant requires it to be empty — remove memberships + roles first.
 *
 * KNOWN BUG (surfaced by the review #29 e2e work, tracked separately): the
 * route deletes the row and THEN inserts the `admin.organization.deleted`
 * audit event with the now-dangling `organization_id`, so the audit insert
 * violates its FK and the response is a 500 even though the tenant is gone.
 * Cleanup therefore verifies the OUTCOME (the org no longer resolves) and
 * tolerates only that specific status; anything else (403, 409
 * `organization_not_empty`, …) still fails the test.
 */
export async function deleteOrganization(api: APIRequestContext, orgId: string): Promise<void> {
  const res = await api.delete(`/api/administrator/organizations/${orgId}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(res.ok() || res.status() === 500, await res.text()).toBe(true);
  const check = await api.get(`/api/administrator/organizations/${orgId}`);
  expect(check.status(), `organization ${orgId} should be gone after delete`).toBe(404);
}

/**
 * An ACTIVE, pre-verified user with no memberships. `role: "user"` is the
 * Better Auth role (NOT an application role) — the account must not become a
 * Better Auth `admin`, which is what would let it impersonate others.
 */
export async function createActiveUser(
  api: APIRequestContext,
  input: { email: string; password: string; name: string },
): Promise<CreatedUser> {
  const res = await api.post("/api/administrator/users", {
    headers: ADMIN_API_HEADERS,
    data: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: "user",
      initialAppStatus: "active",
      preferredLocale: "en",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { id: string; better_auth_user_id: string };
  return {
    id: body.id,
    betterAuthUserId: body.better_auth_user_id,
    email: input.email,
    password: input.password,
  };
}

/** Soft-delete (Better Auth ban + `deactivated`) — the only delete the API exposes. */
export async function softDeleteUser(api: APIRequestContext, userId: string): Promise<void> {
  const res = await api.delete(`/api/administrator/users/${userId}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Returns the membership id (needed to remove it again). */
export async function addActiveMembership(
  api: APIRequestContext,
  userId: string,
  organizationId: string,
): Promise<string> {
  const res = await api.post(`/api/administrator/users/${userId}/memberships`, {
    headers: ADMIN_API_HEADERS,
    data: { organizationId, status: "active" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

export async function deleteMembership(
  api: APIRequestContext,
  userId: string,
  membershipId: string,
): Promise<void> {
  const res = await api.delete(`/api/administrator/users/${userId}/memberships`, {
    headers: ADMIN_API_HEADERS,
    data: { membershipIds: [membershipId] },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A seeded role (e.g. `admin`) inside a given organization. */
export async function findOrgRole(
  api: APIRequestContext,
  organizationId: string,
  key: string,
): Promise<{ id: string; key: string }> {
  const res = await api.get(
    `/api/administrator/roles?organization=${organizationId}&pageSize=200&q=${encodeURIComponent(key)}`,
  );
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { items: { id: string; key: string }[] };
  const role = body.items.find((r) => r.key === key);
  expect(role, `seeded role "${key}" should exist in org ${organizationId}`).toBeDefined();
  return role!;
}

/**
 * A brand-new tenant has NO roles (org creation does not seed them), so an
 * "admin of org B" has to be assembled: create the role, attach permission
 * KEYS, then assign it. Unknown keys are dropped silently by the API, so the
 * role's resulting permission list is checked against what was requested.
 */
export async function createRoleWithPermissions(
  api: APIRequestContext,
  organizationId: string,
  key: string,
  permissionKeys: string[],
): Promise<{ id: string }> {
  const create = await api.post("/api/administrator/roles", {
    headers: ADMIN_API_HEADERS,
    data: { key, name: `E2E ${key}`, organizationId },
  });
  expect(create.status(), await create.text()).toBe(201);
  const role = (await create.json()) as { id: string };

  const attach = await api.post(`/api/administrator/roles/${role.id}/permissions`, {
    headers: ADMIN_API_HEADERS,
    data: { ids: permissionKeys },
  });
  expect(attach.ok(), await attach.text()).toBe(true);
  const attached = (await attach.json()) as { permissions: string[] };
  expect(attached.permissions).toEqual(expect.arrayContaining(permissionKeys));
  return role;
}

export async function deleteRole(api: APIRequestContext, roleId: string): Promise<void> {
  const res = await api.delete(`/api/administrator/roles/${roleId}`, {
    headers: ADMIN_API_HEADERS,
  });
  expect(res.ok(), await res.text()).toBe(true);
}

export async function assignRole(
  api: APIRequestContext,
  userId: string,
  roleId: string,
  organizationId: string,
): Promise<void> {
  const res = await api.post(`/api/administrator/users/${userId}/app-roles`, {
    headers: ADMIN_API_HEADERS,
    data: { roleId, organizationId },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

export async function unassignRole(
  api: APIRequestContext,
  userId: string,
  roleId: string,
  organizationId: string,
): Promise<void> {
  const res = await api.delete(`/api/administrator/users/${userId}/app-roles`, {
    headers: ADMIN_API_HEADERS,
    data: { roleId, organizationId },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Signs a fresh, cookie-sharing request context in via the real Better Auth API. */
export async function signInAs(
  api: APIRequestContext,
  user: Pick<CreatedUser, "email" | "password">,
): Promise<void> {
  const res = await api.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), await res.text()).toBe(true);
}
