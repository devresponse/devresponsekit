# ADR-0001: Three-Tier Access Control (Superadmin / Org Admin / User)

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Platform engineering
- **Supersedes:** the implicit "global admin" model that previously gated
  every `/api/administrator/*` and `/api/v1/admin/*` route on a permission
  key alone, with no organization boundary.

---

## Context

A security review found that every administrator surface authorized on a
permission key (`admin.*`) **without any organization boundary**. Any
holder of, say, `admin.users.read` could enumerate and mutate users, API
keys, OAuth clients, and audit history across **all** tenants by id. The
schema, however, carries `organization_id` on nearly every table and
resolves permissions per-membership — strongly implying tenant isolation
that the code did not enforce. That "looks isolated but isn't" gap is the
dangerous kind: a deployment would be operated under a false assumption.

The product requirement is a standard B2B SaaS tenancy model:

> A **SUPERADMIN** controls everything (all orgs). An **ORG ADMIN**
> controls only their **own** org. A **USER** belongs to an org.

with the explicit constraint:

> **An org admin can manage exactly one organization** (no multi-org
> admins). Cross-org administration is SUPERADMIN-only.

## Decision

Adopt three tiers, distinguished by the **`superuser` marker permission**,
and enforce an organization boundary on every tenant-data query.

| Tier | Identified by | Org boundary | Surface |
| --- | --- | --- | --- |
| **SUPERADMIN** | holds the `superuser` permission | **none** — all orgs | full admin surface, all tenants; global platform config |
| **ORG ADMIN** | holds `admin.*` but **not** `superuser` | **their single org** (`access.organizationId`) | admin surface scoped to their org only |
| **USER** | no `admin.*` permission | n/a (self only) | `/api/account/*`, `/api/v1/me/*` (already self-scoped) |

Because an org admin belongs to exactly one organization, their org is
unambiguous — `getUserAccessContext` already resolves it as
`access.organizationId`. **No per-request org selector, header, or path
segment is introduced.** A future "multi-org admin" capability would add
one, but is explicitly out of scope.

### The core security context

A single module — [`src/lib/admin/access-scope.server.ts`](../../src/lib/admin/access-scope.server.ts)
— is the only place the rule lives:

- `isSuperadmin(access)` — `access.permissions.includes("superuser")`.
- `resolveOrgScope(access)` → `{ kind: "all" }` (superadmin) | `{ kind:
  "org", organizationId }` (org admin) | `null` (org admin with no active
  org → deny / empty).
- `canAccessOrg(access, resourceOrgId)` — single-resource check for `[id]`
  routes; returns false (→ **404**, not 403, to avoid existence leaks)
  when an org admin touches another org's resource.
- `userHasMembershipInOrg(appUserId, orgId)` — for `app_users`, whose
  tenant is its membership (no `organization_id` column).

The `superuser` marker was already seeded but **never checked at runtime**
(its power came only from holding every key). This ADR makes the marker
**load-bearing**: it is now the explicit, sole bypass of org scoping.

### Enforcement matrix

**Org-scoped (org admin sees/acts on their org only; superadmin sees all):**

| Resource | Surface | Boundary |
| --- | --- | --- |
| API keys | `/api/v1/admin/api-keys`, `/api/administrator/api-keys` | `app_api_keys.organization_id` |
| OAuth clients | `/api/v1/admin/oauth-clients` | `app_oauth_clients.organization_id` |
| Users | `/api/v1/users`, `/api/administrator/users` | membership in org |
| Audit events | `/api/v1/audit-events`, `/api/administrator/audit` | `app_audit_events.organization_id` |
| Organizations | `/api/administrator/organizations` | org admin sees only their own org row |
| Memberships | `/api/administrator/memberships` | `app_organization_memberships.organization_id` |

**SUPERADMIN-only (this change):** creating, renaming, and deleting an
**organization** (the tenant entity itself) is restricted to superadmins —
an org admin manages the *contents* of their org, not the org record.

**SUPERADMIN-only (follow-up):** create/update/delete of the global
**roles** and **permissions** catalogs and **enterprise applications**
will be restricted to superadmins; org admins keep *read* access (to
assign roles within their org) but lose catalog mutation. Tracked in
Rollout — not yet enforced in this change, so those routes remain on the
existing `admin.*` permission gate until then.

### Create / mutate semantics

- An org admin **creating** a tenant resource has its `organization_id`
  forced to their org (they cannot create in another org).
- An org admin **issuing an API key on behalf of a user** may only target
  a user in their org (owner membership re-checked).
- `[id]` mutations re-fetch the row, run `canAccessOrg`, and 404 on miss
  **before** mutating.

## Consequences

**Positive**

- Cross-tenant IDOR / enumeration is closed by construction; the boundary
  is one tested module, not scattered `if`s.
- Single-tenant and default-org deployments are unaffected — every user
  is in one org, the org admin == that org.
- The `organization_id` columns now mean what they appear to mean.

**Negative / trade-offs**

- An org admin with no active membership resolves to `null` scope and is
  denied — correct, but means provisioning order matters.
- `getUserAccessContext` resolves a single (oldest) membership; valid
  under the single-org-admin constraint, but a multi-org future requires
  per-request org context (tracked as follow-up).
- A few global-config screens become superadmin-only; org admins lose the
  ability to edit the shared role/permission catalog (intended).

## Rollout

1. **This change (shipped):** core module + ADR; org-scope the
   tenant-data surfaces above across **both** the `/api/v1/admin/*` +
   `/api/v1/users` + `/api/v1/audit-events` machine surface **and** the
   cookie `/api/administrator/*` surface (api keys, oauth clients, users
   list + every `users/[id]/*` mutation via a now-**required** `access`
   arg on `resolveTargetUser`, audit, memberships, organizations list +
   read); superadmin-only org-entity create/update/delete; integration
   tests proving superadmin-sees-all vs org-admin-sees-own / 404-on-other.
2. **Follow-up:** superadmin-gate the global **roles / permissions /
   enterprise-apps / provider-bindings** config writes; org-scope the
   user-detail RSC loaders; org-scoped roles (an org admin manages roles
   *defined for their org*); move the in-memory rate-limit store to Redis;
   optional per-request org context to later allow multi-org admins.

## Role mapping (seed)

| Seed role | Tier | Notes |
| --- | --- | --- |
| `superuser` | SUPERADMIN | carries the `superuser` marker |
| `admin.platform` | ORG ADMIN | full `admin.*` catalog, **no** marker → scoped to its org |
| `admin` | ORG ADMIN (limited) | a subset of `admin.*` |
| `member` | USER | `shell.view` only |

No role keys change; the tier is derived from the presence of the
`superuser` marker, so existing data keeps working.
