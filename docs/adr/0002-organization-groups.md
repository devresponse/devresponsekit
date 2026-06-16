# ADR-0002: Organization Groups (cohorts that bundle custom roles)

- **Status:** Proposed
- **Date:** 2026-06-15
- **Deciders:** Platform engineering
- **Relates to:** [ADR-0001 — Three-Tier Access Control](0001-three-tier-access-control.md)
  (groups inherit its org boundary and privilege-escalation rules verbatim).

---

## Context

An organization asked: _how do we manage **custom groups with custom roles**_
— e.g. a "Marketing" team that should all receive the same bundle of
capabilities, managed as a unit.

Two halves of that already exist; one does not.

**Custom roles — supported today.** `app_roles` is org-scoped
(`organization_id` nullable; `NULL` = a global/platform role, SUPERADMIN-only).
An org admin creates roles that live only in their org
(`unique (organization_id, key)`), attaches permissions to them from the
**`app_permissions`** catalog via `app_role_permissions` (the dual-list editor
at `/api/administrator/roles/[id]/permissions`), and assigns roles to users
with `app_user_roles`. Because `app_user_roles` has PK
`(app_user_id, organization_id, role_id)`, a user can hold **many roles per
org**. The one bound: the permission **catalog** is platform-global and
**SUPERADMIN-only to extend** (P0-10), so org admins compose roles from the
existing granular permission keys rather than inventing new ones.

**Groups — not modeled.** There is no entity representing a named **collection
of people** that confers a bundle of roles. Today you can only approximate it
by assigning a role to each user individually. That conflates two distinct
ideas — _a bundle of permissions_ (a role) and _a collection of users_ (a
group) — and it cannot answer "who is in Marketing?", cannot be re-pointed at a
different role set in one action, and is not a natural target for IdP/SCIM
group sync.

## Decision

Introduce a **first-class, org-scoped `app_groups` entity** that **bundles
roles** and **collects users**. A user's **effective roles within an org** =
roles assigned directly (`app_user_roles`) **∪** roles conferred by the groups
they belong to (`app_group_memberships → app_group_roles`). Permissions then
resolve from those roles exactly as today.

Groups deliberately reuse, not reinvent, ADR-0001:

- **Org boundary.** Groups are **always** tenant-scoped (`organization_id NOT
  NULL` — there are no global groups). Every group route derives its boundary
  from `resolveOrgScope` / `canAccessOrg`, so an org admin manages only their
  org's groups and a foreign group returns **404**.
- **No new permission surface.** Groups grant **roles**, and roles grant
  **catalog permissions**. Groups never reference `app_permissions` directly,
  so they add zero new authority primitives — the blast radius of the feature
  is "a different way to assign existing roles."
- **Privilege-escalation guard.** A group may only bundle roles **its own org
  owns**; putting a role that carries the `superuser` marker into a group is
  **SUPERADMIN-only**, identical to direct role assignment (P0-2 / P0-7). A
  group can never become a backdoor to broader authority than its manager
  holds.

### Schema

Three tables, appended to the single `0001-initial-schema.sql` (per the
project's single-file convention; a fresh `pnpm db:reset:reload` provisions
them). Conventions match the existing `app_*` tables.

```sql
-- A named cohort within ONE organization (no global groups).
create table if not exists app_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

-- Roles a group confers. The route layer enforces that role_id belongs to
-- the SAME organization as the group (an org admin cannot bundle a global or
-- foreign-org role); the FK only guarantees referential integrity.
create table if not exists app_group_roles (
  group_id uuid not null references app_groups(id) on delete cascade,
  role_id  uuid not null references app_roles(id)  on delete cascade,
  primary key (group_id, role_id)
);

-- Users that belong to a group. Membership is binary (no status column in v1
-- — see Open questions); the org boundary already comes from the user being
-- an ACTIVE member of the group's org.
create table if not exists app_group_memberships (
  group_id    uuid not null references app_groups(id)  on delete cascade,
  app_user_id uuid not null references app_users(id)   on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, app_user_id)
);

create index if not exists idx_app_groups_organization_id    on app_groups (organization_id);
create index if not exists idx_app_group_roles_role_id       on app_group_roles (role_id);
create index if not exists idx_app_group_memberships_user    on app_group_memberships (app_user_id);
```

### Permission resolution

The only authority-bearing change is in `getUserAccessContext`
(`src/lib/auth-status.ts`). Today it resolves permissions for the active org
from direct role assignments:

```
app_user_roles (org = active) → app_role_permissions → app_permissions
```

Groups add a **second path to the same role set**, still confined to the active
org. Resolve the **effective role ids** for `(user, activeOrg)` as the union of
direct and group-derived roles, then join to permissions once:

```sql
-- effective role ids = direct ∪ via-groups (both scoped to the active org)
with effective_roles as (
  select ur.role_id
    from app_user_roles ur
   where ur.app_user_id = :userId
     and ur.organization_id = :activeOrgId
  union
  select gr.role_id
    from app_group_memberships gm
    join app_groups g       on g.id = gm.group_id
    join app_group_roles gr on gr.group_id = g.id
   where gm.app_user_id = :userId
     and g.organization_id = :activeOrgId
)
select distinct p.key
  from effective_roles er
  join app_role_permissions rp on rp.role_id = er.role_id
  join app_permissions p       on p.id = rp.permission_id;
```

The existing `superuser`-marker expansion runs unchanged on the result. The
org filter on **both** branches is what keeps groups inside ADR-0001:
group-derived roles only count when the group belongs to the active org.

### Admin surface

Mirror the roles surface 1:1 so the UI, scoping, and tests are copy-forward:

| Roles (exists) | Groups (new) | Purpose |
| --- | --- | --- |
| `roles` (GET/POST) | `groups` (GET/POST) | list / create (org-scoped) |
| `roles/[id]` (GET/PATCH/DELETE) | `groups/[id]` | detail / rename / delete |
| `roles/[id]/permissions` | `groups/[id]/roles` | dual-list: roles bundled by the group |
| `roles/[id]/members` | `groups/[id]/members` | users in the group (add/remove) |
| `users/[id]/app-roles` | `users/[id]/groups` | the user-detail "Groups" tab |

A new permission family — `admin.groups.read` / `admin.groups.create` /
`admin.groups.update` / `admin.groups.delete` / `admin.groups.assign` — is
added to the catalog (a one-time SUPERADMIN/seed change) and granted to the
`admin.platform` role alongside the existing `admin.roles.*` keys.

## Alternatives considered

- **Roles-as-groups (no schema change).** Reuse `app_user_roles` and treat a
  role as a cohort. Rejected as the primary model: it cannot represent
  group-as-people (no membership list, no re-pointing, no IdP sync) and
  overloads one concept with two meanings. It remains a perfectly good
  _workaround_ until groups ship.
- **Groups grant permissions directly** (skip roles). Rejected: it duplicates
  the role→permission machinery, creates a second authority primitive to
  secure, and breaks the "groups only re-assign existing roles" blast-radius
  argument.
- **Nested groups (groups containing groups).** Deferred (see Open questions) —
  resolution would need cycle detection and recursive expansion; not required
  for the stated use case.

## Consequences

- **Positive:** orgs manage cohorts as a unit; assignment scales (add a user to
  "Marketing" once); IdP/SCIM group sync gains a natural target; zero new
  authority primitives; reuses every ADR-0001 scope primitive and the
  build-time route-scope invariant test.
- **Negative / cost:** one more join path in the hot `getUserAccessContext`
  read (mitigated by the indexes above and the existing per-request `cache()`);
  a new admin surface to build and test; a catalog migration for the
  `admin.groups.*` keys.
- **Neutral:** effective-permission debugging now has two sources (direct +
  group) — the group/role/member admin views make this inspectable.

## Phased implementation plan

Each phase is independently shippable as **its own PR** (per the repo's
one-PR-per-logical-change rule) and gated by the standard suite
(`typecheck · lint · format · test`). The cross-tenant matrix and
schema-validation suites from `docs/security-test-coverage-plan.md` are the
templates for the new tests.

### Phase 1 — schema + permission resolution

- Append the three tables + indexes to `src/db/migrations/0001-initial-schema.sql`.
- Add the Kysely table interfaces to `src/db/schema/app-schema.ts`
  (`AppGroupsTable`, `AppGroupRolesTable`, `AppGroupMembershipsTable`) and the
  `DB` registration.
- Extend `getUserAccessContext` (`src/lib/auth-status.ts`) with the union query
  above. Keep it one round-trip.
- **Tests:** extend `tests/unit/auth-status-db.test.ts` — a user with **no
  direct roles** but a group conferring `admin.users.read` resolves that
  permission; a group in a **different** org confers nothing.
- Verify a fresh `pnpm db:reset:reload` provisions the tables (the script drops
  + recreates from `0001`).

### Phase 2 — group CRUD (org-scoped)

- Routes `groups/route.ts` (GET list + POST create) and `groups/[id]/route.ts`
  (GET / PATCH / DELETE), copied from the roles handlers: `resolveOrgScope` on
  the list, `canAccessOrg(group.organization_id)` → 404 on `[id]`, and the
  org-create restriction (an org admin may only create groups in their own org).
- RSC pages under `app/[locale]/(secure)/app/administrator/groups/**`
  mirroring the roles pages, with `canAccessOrg` → `notFound()`.
- Seed `admin.groups.*` into the catalog + the `admin.platform` role.
- **Tests:** the route-scope invariant test (`admin-route-scope-invariant`)
  auto-requires these to reference a scope primitive; add a `groups` block to
  `org-scoped-admin-routes.test.ts` (own-org 200 / foreign 404 / null-scope
  empty / superadmin all).

### Phase 3 — group → roles editor

- `groups/[id]/roles/route.ts` (POST attach / DELETE detach), modelled on
  `roles/[id]/permissions`. Enforce **two guards**: the role must belong to the
  group's org (`canAccessOrg(role.organization_id)` → 404), and a non-superadmin
  may not bundle a `superuser`-granting role (403) — reuse the exact check from
  `users/[id]/app-roles`.
- Dual-list "Roles in this group" UI in the group detail tabs.
- **Tests:** foreign/global-role 404, superuser-bundle 403, happy-path attach.

### Phase 4 — group membership management

- `groups/[id]/members/route.ts` (GET list + POST add / DELETE remove). A user
  may only be added if they hold an **active membership in the group's org**
  (reuse `userHasMembershipInOrg`).
- `users/[id]/groups/route.ts` — the user-detail "Groups" tab (target user
  already org-scoped by `resolveTargetUser`).
- **Tests:** add a non-member of the org → rejected; cross-org user → 404.

### Phase 5 — docs + coverage close-out

- Update `docs/database-schema.md` (ER diagram + relationships: `app_organizations
  ||--o{ app_groups`, `app_groups }o--o{ app_roles`, `app_groups }o--o{
  app_users`) and `docs/admin-manager.md` (the new admin section).
- Raise the coverage ratchet for the new surface; mark this ADR **Accepted**.

### Phase 6 — (optional) IdP / SCIM group sync

- Map an IdP/SCIM group → an `app_group` (likely keyed off
  `app_provider_organizations`), so directory-driven membership flows into the
  same resolution path. Tracked separately; not required for manual groups.

## Open questions

- **Group membership status.** v1 membership is binary. If groups ever gate
  access (not just grant roles), add a `status` column and fold it into
  `decideSecureAccess`. Until then, the org-membership status already governs
  whether any permission resolves.
- **Nested groups.** Out of scope; would need recursive expansion + cycle
  detection in the resolution query.
- **Global (platform) groups.** Intentionally excluded — groups are a tenant
  concept. Cross-org cohorts, if ever needed, are a SUPERADMIN feature and a
  separate decision.
