import "dotenv/config";
import type { Pool } from "pg";
import { assertDevSeedTarget } from "@/db/guards";
import { createAppPool, ensureSchema } from "@/db/schema-config";
import { setSignupProvisioningSuppressed } from "@/lib/auth-signup-provisioning";
import { ADMIN_PERMISSION_CATALOG, ANY_ADMIN_PERMISSION } from "@/lib/admin/permissions";

/**
 * `dev_init` — OPTIONAL development / testing seed.
 *
 * Where `seed-local.ts` provisions the single canonical local admin, this
 * script loads a richer fixture for exercising multi-organization,
 * multi-role scenarios:
 *   - three organizations, each with a superuser, an organization
 *     administrator, and five regular users (21 single-org accounts);
 *   - three CROSS-ORGANIZATION members that belong to all three orgs at once
 *     (exercises the org switcher + multi-tenant role resolution);
 *   - two GROUPS in ORG A, each with two members and a conferred role
 *     (exercises the group-roles screens);
 *   - registration timestamps SPREAD across the dashboard's 7-day window so
 *     the "daily registrations" bar chart shows a real trend; and
 *   - a back-dated AUDIT HISTORY (logins + a spread of past admin / account /
 *     SSO actions) so the "daily logins" chart and the recent-activity feed
 *     are populated.
 *
 * It is **idempotent** — every write is `on conflict do nothing`/`do update`,
 * Better Auth users are created check-then-create, and the audit history is
 * guarded by a `metadata.seed` sentinel (audit rows are append-only — the
 * audit trigger blocks UPDATE/DELETE — so they can't be deleted and
 * re-inserted). Safe to run
 * repeatedly. It assumes the schema already exists (`pnpm db:auth:migrate` +
 * `pnpm db:app:migrate`); it does not create tables.
 *
 * Every account is created **pre-approved** (`active`) and pinned to its
 * assigned organization(s), so the accounts never sit in `pending_approval` —
 * see `pruneForeignMemberships`, which removes the stray `default`-org
 * membership that sign-up auto-provisioning would otherwise leave behind.
 *
 * Run with:  `pnpm db:seed:dev`
 *
 * Every account shares one password (`DEV_SEED_PASSWORD`, default
 * `DevPassword123!`). These are deliberately weak, known credentials for a
 * disposable database, so the script has two independent refusals (both
 * checked BEFORE any connection is opened — `assertDevSeedTarget` in
 * `src/db/guards.ts`):
 *   - `NODE_ENV=production` refuses unless `DEV_SEED_ALLOW_PROD=1`;
 *   - a `DATABASE_URL` whose host is not local (`localhost`, `127.0.0.1`,
 *     `::1`, `0.0.0.0`, or no host) refuses — whatever `NODE_ENV` says —
 *     unless `--force` or `DEV_SEED_ALLOW_REMOTE=1` is given. `NODE_ENV` is
 *     routinely unset in a shell whose `.env` carries a production URL; the
 *     host is what actually says where the accounts would land.
 *
 * Role mapping (per organization):
 *   - `superuser@<org>`  → `superuser` role — holds the `superuser`
 *     permission, i.e. a cross-organization superadmin (ADR-0001).
 *   - `orgadmin@<org>`   → `admin.platform` role — the full `admin.*`
 *     catalog but NO `superuser`, so it is scoped to its own organization.
 *   - `user1..5@<org>`   → `member` role — `shell.view` only (a plain user).
 *   - `multi1..3@shared` → `member` role in EACH of the three orgs.
 */

const DEFAULT_DEV_PASSWORD = "DevPassword123!";
const devPassword = process.env.DEV_SEED_PASSWORD?.trim() || DEFAULT_DEV_PASSWORD;

interface DevOrg {
  slug: string;
  name: string;
  /** Email domain for this org's users, e.g. `orga.local`. */
  domain: string;
}

/** App role assigned to a dev user. */
type RoleKey = "member" | "admin.platform" | "superuser";

interface DevUser {
  email: string;
  displayName: string;
  role: RoleKey;
  /** Grant the Better Auth admin role (enables ban / impersonation testing). */
  betterAuthAdmin: boolean;
}

/** A user after creation — carries the ids needed for audit attribution. */
interface SeededUser {
  email: string;
  displayName: string;
  appUserId: string;
  betterAuthUserId: string;
  /** Primary (earliest-membership) org — used to attribute org-scoped audit rows. */
  organizationId: string;
  orgSlug: string;
}

const ORGS: ReadonlyArray<DevOrg> = [
  { slug: "org-a", name: "ORG A", domain: "orga.local" },
  { slug: "org-b", name: "ORG B", domain: "orgb.local" },
  { slug: "org-c", name: "ORG C", domain: "orgc.local" },
];

/** Per-org account count: superuser + orgadmin + user1..5. */
const USERS_PER_ORG = 7;

/**
 * Cross-organization members — each belongs to ALL of {@link ORGS}. They make
 * the org switcher and multi-tenant role resolution exercisable (a single
 * account whose active org can change) and balance `signupsPerOrg` across A/B/C.
 */
const MULTI_ORG_USERS: ReadonlyArray<DevUser> = [
  {
    email: "multi1@shared.local",
    displayName: "Shared Member One",
    role: "member",
    betterAuthAdmin: false,
  },
  {
    email: "multi2@shared.local",
    displayName: "Shared Member Two",
    role: "member",
    betterAuthAdmin: false,
  },
  {
    email: "multi3@shared.local",
    displayName: "Shared Member Three",
    role: "member",
    betterAuthAdmin: false,
  },
];

interface GroupDef {
  orgSlug: string;
  key: string;
  name: string;
  description: string;
  /** Role this group confers on its members (must be a role in the same org). */
  roleKey: string;
  /** Exactly the members of this group (emails of already-seeded users). */
  memberEmails: readonly string[];
}

/**
 * Demo groups (ADR-0002: a group is a named cohort within ONE org that bundles
 * roles and collects users). Two groups in ORG A with two distinct members
 * each, so the group-management + group-roles screens have real data.
 */
const GROUP_DEFS: ReadonlyArray<GroupDef> = [
  {
    orgSlug: "org-a",
    key: "engineering",
    name: "Engineering",
    description: "Engineering team (demo group).",
    roleKey: "admin",
    memberEmails: ["user1@orga.local", "user2@orga.local"],
  },
  {
    orgSlug: "org-a",
    key: "support",
    name: "Customer Support",
    description: "Customer support team (demo group).",
    roleKey: "member",
    memberEmails: ["user3@orga.local", "user4@orga.local"],
  },
];

function usersForOrg(org: DevOrg): DevUser[] {
  const users: DevUser[] = [
    {
      email: `superuser@${org.domain}`,
      displayName: `${org.name} Superuser`,
      role: "superuser",
      betterAuthAdmin: true,
    },
    {
      email: `orgadmin@${org.domain}`,
      displayName: `${org.name} Admin`,
      role: "admin.platform",
      betterAuthAdmin: true,
    },
  ];
  for (let n = 1; n <= 5; n++) {
    users.push({
      email: `user${n}@${org.domain}`,
      displayName: `${org.name} User ${n}`,
      role: "member",
      betterAuthAdmin: false,
    });
  }
  return users;
}

/* ----------------------------- date spreading ---------------------------- */

// Mirrors DEFAULT_WINDOW_DAYS in src/lib/admin/metrics.server.ts — the dashboard
// charts bucket by UTC day and only look back this many days, so every seeded
// date is placed inside one of these UTC day buckets to stay in-window.
const REGISTRATION_WINDOW_DAYS = 7;

/** Midnight UTC of the day `daysAgo` days before `now`'s UTC date. */
function utcDayStart(now: Date, daysAgo: number): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysAgo);
  return start;
}

/**
 * A timestamp inside the UTC day bucket `daysAgo` days ago, `minutesIntoDay`
 * minutes past midnight. Anchoring to midnight (not the wall-clock `now`) keeps
 * each row firmly in its intended day's bucket — and the matching dashboard bar
 * — no matter what time the seed runs. For today's bucket the offset is clamped
 * to stay before `now`, so a row is never created in the future.
 */
function inDayBucket(now: Date, daysAgo: number, minutesIntoDay: number): Date {
  const start = utcDayStart(now, daysAgo);
  const ceilingMs =
    daysAgo === 0
      ? Math.max(60_000, now.getTime() - start.getTime() - 60_000) // before `now` today
      : 20 * 60 * 60_000; // up to 20h into a past day
  return new Date(start.getTime() + ((minutesIntoDay * 60_000) % ceilingMs));
}

/**
 * Registration timestamp for a single-org user. The 7 users in each org map to
 * `daysAgo = 0..6` by their position — one registration per org per day — so
 * every org spans the whole window and the system-wide chart shows ≈3/day. The
 * org index only perturbs the within-day minute (distinct timestamps for a
 * stable "recent" order). Pure function of the inputs ⇒ stable across re-runs.
 */
function registrationDate(orgPos: number, userPos: number, now: Date): Date {
  const daysAgo = Math.min(REGISTRATION_WINDOW_DAYS - 1, userPos);
  const minutesIntoDay = ((userPos * ORGS.length + orgPos) * 53) % 600; // 00:00–10:00 UTC
  return inDayBucket(now, daysAgo, minutesIntoDay);
}

// Base permissions NOT covered by ADMIN_PERMISSION_CATALOG. Mirrors the set
// seeded by `seed-local.ts`; `shell.view` in particular gates the secure
// shell, so a `member` user without it could not sign in usefully.
const BASE_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["shell.view", "View the secure shell"],
  ["audit.view", "Read the audit log"],
  [
    "superuser",
    "Superuser access level — full unrestricted access to every part of the application",
  ],
];

// Standard per-organization roles (identical to `seed-local.ts`). The full
// set is created for every org so role-management scenarios have something to
// work with; `dev_init` assigns `member` / `admin.platform` / `superuser` to
// users, and bundles the `admin` role into the Engineering group.
const ROLE_DEFS: ReadonlyArray<{ key: string; name: string; permissions: readonly string[] }> = [
  { key: "member", name: "Member", permissions: ["shell.view"] },
  {
    key: "admin",
    name: "Administrator",
    // Canonical catalog keys: `admin.users.read` to VIEW the users area (the
    // page + sidebar require it) and `admin.users.manage` to act on users;
    // `admin.audit.read` to view the audit log. The old grant
    // (`admin.users.manage` + the phantom `audit.view`) let the role link to
    // those pages but never open them.
    permissions: ["shell.view", "admin.users.read", "admin.users.manage", "admin.audit.read"],
  },
  {
    key: "admin.platform",
    name: "Platform Administrator",
    permissions: ["shell.view", ...ANY_ADMIN_PERMISSION],
  },
  {
    key: "superuser",
    name: "Superuser",
    // Authority comes from the `superuser` MARKER post-hardening (PR #97):
    // getUserAccessContext synthesizes the full set for any holder and the
    // admin gate short-circuits on isSuperadmin, so the role needs only the
    // marker (+ shell.view).
    permissions: ["shell.view", "superuser"],
  },
];

async function assertSchema(pool: Pool): Promise<void> {
  const hasUserTable = (
    await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = current_schema() and table_name = 'user'
       ) as exists`,
    )
  ).rows[0]?.exists;
  if (!hasUserTable) {
    throw new Error(
      "Schema missing. Run `pnpm db:auth:migrate` and `pnpm db:app:migrate` before `pnpm db:seed:dev`.",
    );
  }
}

async function ensurePermissions(pool: Pool): Promise<void> {
  const all = [
    ...BASE_PERMISSIONS.map(([key, description]) => ({ key, description })),
    ...ADMIN_PERMISSION_CATALOG,
  ];
  for (const { key, description } of all) {
    await pool.query(
      `insert into app_permissions (key, description) values ($1, $2)
       on conflict (key) do nothing`,
      [key, description],
    );
  }
}

async function ensureOrg(pool: Pool, org: DevOrg): Promise<string> {
  await pool.query(
    `insert into app_organizations (slug, name, status, is_default)
     values ($1, $2, 'active', false)
     on conflict (slug) do nothing`,
    [org.slug, org.name],
  );
  const id = (
    await pool.query<{ id: string }>(`select id from app_organizations where slug = $1`, [org.slug])
  ).rows[0]?.id;
  if (!id) throw new Error(`organization ${org.slug} missing after insert`);
  return id;
}

async function ensureRoles(pool: Pool, organizationId: string): Promise<void> {
  for (const def of ROLE_DEFS) {
    await pool.query(
      `insert into app_roles (organization_id, key, name) values ($1, $2, $3)
       on conflict (organization_id, key) do nothing`,
      [organizationId, def.key, def.name],
    );
    const roleId = await roleIdFor(pool, organizationId, def.key);
    for (const permKey of def.permissions) {
      const permId = (
        await pool.query<{ id: string }>(`select id from app_permissions where key = $1`, [permKey])
      ).rows[0]?.id;
      if (!permId) continue;
      await pool.query(
        `insert into app_role_permissions (role_id, permission_id) values ($1, $2)
         on conflict do nothing`,
        [roleId, permId],
      );
    }
  }
}

async function roleIdFor(pool: Pool, organizationId: string, key: string): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `select id from app_roles where organization_id = $1 and key = $2`,
      [organizationId, key],
    )
  ).rows[0]?.id;
  if (!id) throw new Error(`role ${key} missing for organization ${organizationId}`);
  return id;
}

// Resolved once on first use, then cached.
let authRoleColumn: boolean | null = null;
async function hasAuthRoleColumn(pool: Pool): Promise<boolean> {
  if (authRoleColumn !== null) return authRoleColumn;
  authRoleColumn =
    (
      await pool.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.columns
           where table_schema = current_schema()
             and table_name = 'user' and column_name = 'role'
         ) as exists`,
      )
    ).rows[0]?.exists ?? false;
  return authRoleColumn;
}

/**
 * Creates (idempotently) the Better Auth identity + the active `app_users`
 * profile for a user and returns their ids. `createdAt` back-dates the profile
 * so it lands on the intended day of the registrations chart.
 */
async function ensureIdentity(
  pool: Pool,
  user: DevUser,
  createdAt: Date,
): Promise<{ betterAuthUserId: string; appUserId: string }> {
  // 1. Better Auth identity — check-then-create so re-runs never duplicate.
  let authUser = (
    await pool.query<{ id: string; email: string; name: string | null }>(
      `select id, email, name from "user" where lower(email) = lower($1)`,
      [user.email],
    )
  ).rows[0];

  if (!authUser) {
    // Import lazily so a fully-seeded re-run never initializes Better Auth.
    const { auth } = await import("@/lib/auth");
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const created = await auth.api.signUpEmail({
      body: { name: user.displayName, email: user.email, password: devPassword, rememberMe: false },
      headers: new Headers({ host: new URL(baseUrl).host, origin: baseUrl }),
    });
    authUser = { id: created.user.id, email: created.user.email, name: created.user.name };
    console.log(`[dev-init]   + ${user.email}`);
  }

  // Seed fixtures are created pre-verified. `requireEmailVerification` gates
  // real sign-ups, but the dev fixture + the Playwright suite sign in directly
  // and cannot complete an email round-trip. Reconcile on every run (idempotent).
  await pool.query(`update "user" set "emailVerified" = true where id = $1`, [authUser.id]);

  // 2. Application profile — always reconcile to active; back-date created_at
  //    so the registrations chart shows a spread (deterministic ⇒ idempotent).
  const appUserId = (
    await pool.query<{ id: string }>(
      `insert into app_users
         (better_auth_user_id, primary_email, display_name, status, status_reason, preferred_locale, created_at)
       values ($1, $2, $3, 'active', null, 'en', $4)
       on conflict (better_auth_user_id) do update set
         primary_email = excluded.primary_email,
         display_name = excluded.display_name,
         status = 'active',
         status_reason = null,
         created_at = excluded.created_at,
         updated_at = now()
       returning id`,
      [authUser.id, authUser.email, authUser.name ?? user.displayName, createdAt],
    )
  ).rows[0]?.id;
  if (!appUserId) throw new Error(`app user missing after upsert for ${user.email}`);

  // 3. Better Auth admin role (optional — enables ban / impersonation testing).
  if (user.betterAuthAdmin && (await hasAuthRoleColumn(pool))) {
    await pool.query(`update "user" set role = 'admin' where id = $1`, [authUser.id]);
  }

  return { betterAuthUserId: authUser.id, appUserId };
}

/** Active membership + role assignment for a user in one org (back-dated created_at). */
async function ensureMembership(
  pool: Pool,
  organizationId: string,
  orgSlug: string,
  appUserId: string,
  roleKey: RoleKey,
  createdAt: Date,
): Promise<void> {
  await pool.query(
    `insert into app_organization_memberships
       (organization_id, app_user_id, status, source_provider, provider_organization_key, created_at)
     values ($1, $2, 'active', 'email', $3, $4)
     on conflict (organization_id, app_user_id) do update set
       status = 'active',
       created_at = excluded.created_at,
       updated_at = now()`,
    [organizationId, appUserId, orgSlug, createdAt],
  );

  const roleId = await roleIdFor(pool, organizationId, roleKey);
  await pool.query(
    `insert into app_user_roles (app_user_id, organization_id, role_id) values ($1, $2, $3)
     on conflict do nothing`,
    [appUserId, organizationId, roleId],
  );
}

/**
 * Drops every membership outside `keepOrganizationIds`. The sign-up flow's
 * `session.create.after` hook (src/lib/auth.ts) auto-provisions a
 * `pending_approval` membership in the fallback (`default`) org during the
 * auto sign-in. getUserAccessContext resolves the EARLIEST membership, so that
 * stray row — were it the earliest — would pin the account to `pending_approval`
 * and strip its assigned-org roles. These synthetic users belong only to their
 * assigned org(s) (one for single-org users, all three for cross-org members),
 * so any membership elsewhere is removed. The kept memberships are back-dated
 * (days ago) while the stray `default` one is `now`, so the earliest is always
 * an assigned org regardless of prune timing.
 */
async function pruneForeignMemberships(
  pool: Pool,
  appUserId: string,
  keepOrganizationIds: readonly string[],
): Promise<void> {
  await pool.query(
    `delete from app_organization_memberships
     where app_user_id = $1 and organization_id <> all($2::uuid[])`,
    [appUserId, keepOrganizationIds],
  );
}

/**
 * Creates the demo groups, each with its conferred role and members. All writes
 * are idempotent; members are looked up by email among already-seeded users.
 * Returns the number of (group, member) edges created/confirmed.
 */
async function ensureGroups(pool: Pool, orgIdBySlug: Map<string, string>): Promise<number> {
  let memberEdges = 0;
  for (const group of GROUP_DEFS) {
    const orgId = orgIdBySlug.get(group.orgSlug);
    if (!orgId) throw new Error(`group ${group.key}: organization ${group.orgSlug} missing`);

    await pool.query(
      `insert into app_groups (organization_id, key, name, description) values ($1, $2, $3, $4)
       on conflict (organization_id, key) do nothing`,
      [orgId, group.key, group.name, group.description],
    );
    const groupId = (
      await pool.query<{ id: string }>(
        `select id from app_groups where organization_id = $1 and key = $2`,
        [orgId, group.key],
      )
    ).rows[0]?.id;
    if (!groupId) throw new Error(`group ${group.key} missing after insert`);

    // Role the group confers (same org as the group — an invariant the
    // composite FKs enforce since migration 0004, review #218).
    const roleId = await roleIdFor(pool, orgId, group.roleKey);
    await pool.query(
      `insert into app_group_roles (group_id, role_id, organization_id) values ($1, $2, $3) on conflict do nothing`,
      [groupId, roleId, orgId],
    );

    for (const email of group.memberEmails) {
      const appUserId = (
        await pool.query<{ id: string }>(
          `select id from app_users where lower(primary_email) = lower($1)`,
          [email],
        )
      ).rows[0]?.id;
      if (!appUserId) {
        console.warn(`[dev-init]   ! group ${group.key}: member ${email} not found, skipping`);
        continue;
      }
      await pool.query(
        `insert into app_group_memberships (group_id, app_user_id) values ($1, $2)
         on conflict do nothing`,
        [groupId, appUserId],
      );
      memberEdges++;
    }
    console.log(
      `[dev-init]   ⧉ group ${group.name} (${group.orgSlug}) ← ${group.memberEmails.join(", ")}`,
    );
  }
  return memberEdges;
}

/* ------------------------------ audit history ---------------------------- */

/** A past action to synthesize, attributed to a seeded user by email. */
interface AuditAction {
  eventType: string;
  outcome: "success" | "denied" | "error" | "failure";
  /** Email of the acting seeded user. */
  actorEmail: string;
  daysAgo: number;
  reason?: string;
}

// Must match LOGIN_EVENT_TYPE in src/lib/auth-login-audit.server.ts — the event
// type the "daily logins" chart counts. Inlined (not imported) so the seed
// doesn't eager-load the server-only audit/db module graph (which opens a pool
// at import time). The value is a persisted audit event type ⇒ effectively frozen.
const LOGIN_EVENT_TYPE = "auth.session.created";

// Logins per day across the window (index = daysAgo, 0 = today). Varied heights
// so the "daily logins" chart reads as a real trend, not a flat line.
const LOGINS_BY_DAYS_AGO: readonly number[] = [7, 9, 5, 8, 5, 6, 4];

// A spread of past, non-login actions for the recent-activity feed — a mix of
// admin, account, and SSO events plus one denied attempt, attributed to real
// seeded users and spread across the window.
const AUDIT_ACTIONS: ReadonlyArray<AuditAction> = [
  {
    eventType: "admin.user.approved",
    outcome: "success",
    actorEmail: "orgadmin@orga.local",
    daysAgo: 5,
  },
  {
    eventType: "admin.user.suspended",
    outcome: "success",
    actorEmail: "orgadmin@orgb.local",
    daysAgo: 4,
  },
  {
    eventType: "admin.user.reactivated",
    outcome: "success",
    actorEmail: "orgadmin@orgb.local",
    daysAgo: 2,
  },
  {
    eventType: "account.profile.updated",
    outcome: "success",
    actorEmail: "user2@orga.local",
    daysAgo: 3,
  },
  {
    eventType: "account.active_organization.changed",
    outcome: "success",
    actorEmail: "multi1@shared.local",
    daysAgo: 1,
  },
  {
    eventType: "i18n.locale.changed",
    outcome: "success",
    actorEmail: "multi2@shared.local",
    daysAgo: 1,
  },
  {
    eventType: "sso.launch.success",
    outcome: "success",
    actorEmail: "superuser@orga.local",
    daysAgo: 0,
  },
  {
    eventType: "oauth_client.created",
    outcome: "success",
    actorEmail: "superuser@orgc.local",
    daysAgo: 6,
  },
  {
    eventType: "administrator.access.denied",
    outcome: "denied",
    actorEmail: "user1@orgc.local",
    daysAgo: 4,
    reason: "insufficient_permissions",
  },
];

interface AuditRow {
  eventType: string;
  outcome: string;
  actorBetterAuthUserId: string;
  appUserId: string | null;
  organizationId: string | null;
  email: string;
  reason: string | null;
  createdAt: Date;
}

/**
 * Inserts a synthetic audit history so the "daily logins" chart and the
 * recent-activity feed have data: per-day login events across the 7-day window
 * (attributed round-robin to seeded users) plus a spread of past actions.
 *
 * Idempotent via a `metadata.seed = 'dev-init'` sentinel: audit rows are
 * append-only (the audit trigger blocks UPDATE/DELETE), so we cannot delete and
 * re-insert — instead we skip entirely when seeded rows already exist.
 * Returns the number of rows inserted (0 if already seeded).
 */
async function seedAuditHistory(pool: Pool, roster: SeededUser[], now: Date): Promise<number> {
  if (roster.length === 0) return 0;
  const already = (
    await pool.query<{ seeded: boolean }>(
      `select exists (select 1 from app_audit_events where metadata->>'seed' = 'dev-init') as seeded`,
    )
  ).rows[0]?.seeded;
  if (already) {
    console.log("[dev-init] audit history already present — skipping (append-only).");
    return 0;
  }

  const byEmail = new Map(roster.map((u) => [u.email.toLowerCase(), u]));
  const rows: AuditRow[] = [];

  // (a) Daily logins. Login rows match production shape: actor set, no
  //     app_user_id / organization_id (logins are tenant-less system events;
  //     the org-scoped logins chart joins through the actor's memberships).
  let k = 0;
  for (let daysAgo = REGISTRATION_WINDOW_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const count = LOGINS_BY_DAYS_AGO[daysAgo] ?? 5;
    for (let n = 0; n < count; n++) {
      const actor = roster[k % roster.length];
      k++;
      if (!actor) continue;
      rows.push({
        eventType: LOGIN_EVENT_TYPE,
        outcome: "success",
        actorBetterAuthUserId: actor.betterAuthUserId,
        appUserId: null,
        organizationId: null,
        email: actor.email,
        reason: null,
        createdAt: inDayBucket(now, daysAgo, n * 41), // spread across the day
      });
    }
  }

  // (b) Past actions — carry the actor's app_user_id + org so org admins see
  //     them in their scoped recent-activity feed.
  for (const [i, action] of AUDIT_ACTIONS.entries()) {
    const actor = byEmail.get(action.actorEmail.toLowerCase());
    if (!actor) continue;
    rows.push({
      eventType: action.eventType,
      outcome: action.outcome,
      actorBetterAuthUserId: actor.betterAuthUserId,
      appUserId: actor.appUserId,
      organizationId: actor.organizationId,
      email: actor.email,
      reason: action.reason ?? null,
      createdAt: inDayBucket(now, action.daysAgo, 120 + i * 7),
    });
  }

  for (const row of rows) {
    await pool.query(
      `insert into app_audit_events
         (event_type, outcome, actor_better_auth_user_id, app_user_id, organization_id,
          email, reason, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        row.eventType,
        row.outcome,
        row.actorBetterAuthUserId,
        row.appUserId,
        row.organizationId,
        row.email,
        row.reason,
        JSON.stringify({ seed: "dev-init" }),
        row.createdAt,
      ],
    );
  }
  return rows.length;
}

interface SummaryCounts {
  multiOrgUsers: number;
  groups: number;
  groupMemberEdges: number;
  auditRows: number;
}

function printSummary(counts: SummaryCounts): void {
  const usingDefault = devPassword === DEFAULT_DEV_PASSWORD;
  const singleOrgUsers = ORGS.length * USERS_PER_ORG;
  console.log("\n[dev-init] complete.");
  console.log(`  Organizations: ${ORGS.map((o) => `${o.name} (${o.slug})`).join(", ")}`);
  console.log(`  Per organization: superuser@, orgadmin@, user1..5@ (${USERS_PER_ORG} accounts)`);
  console.log(
    `  Cross-org members: ${MULTI_ORG_USERS.map((u) => u.email).join(", ")} (each in all ${ORGS.length} orgs)`,
  );
  console.log(
    `  Groups: ${counts.groups} in ORG A (${counts.groupMemberEdges} memberships) — Engineering, Customer Support`,
  );
  console.log(`  Audit history: ${counts.auditRows} back-dated rows (logins + past actions)`);
  console.log(
    `  Total users: ${singleOrgUsers} single-org + ${counts.multiOrgUsers} cross-org = ${singleOrgUsers + counts.multiOrgUsers}`,
  );
  console.log(
    `  Registrations + logins are spread across the last ${REGISTRATION_WINDOW_DAYS} days for the dashboard charts.`,
  );
  console.log(
    `  Password: ${usingDefault ? `${DEFAULT_DEV_PASSWORD} (override with DEV_SEED_PASSWORD)` : "(from DEV_SEED_PASSWORD)"}`,
  );
  console.log("  Sign in, e.g.: http://localhost:3000/en/sign-in  →  superuser@orga.local");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database");
  }
  // Pre-flight (review #19): NODE_ENV=production refuses unless
  // DEV_SEED_ALLOW_PROD=1, then any NON-LOCAL host refuses unless --force /
  // DEV_SEED_ALLOW_REMOTE=1 — both evaluated before a pool exists, so a
  // refusal never touches the database. See src/db/guards.ts.
  const { host, database } = assertDevSeedTarget({ databaseUrl });
  console.log(`[dev-init] target  host=${host}  database=${database}`);

  // The fixture provisions app_users + memberships itself, in specific orgs;
  // stand the sign-up auto-provisioning hook down so signUpEmail doesn't also
  // give each user a spurious default-org membership.
  setSignupProvisioningSuppressed(true);

  const pool = createAppPool();
  try {
    // Ensure the schema namespace exists so `current_schema()` resolves to
    // DB_SCHEMA; `assertSchema` still verifies the migrations actually ran.
    await ensureSchema(pool);
    await assertSchema(pool);
    await ensurePermissions(pool);

    const now = new Date();
    const roster: SeededUser[] = [];
    const orgIdBySlug = new Map<string, string>();

    // 1. Single-org accounts.
    for (const [orgPos, org] of ORGS.entries()) {
      const organizationId = await ensureOrg(pool, org);
      orgIdBySlug.set(org.slug, organizationId);
      await ensureRoles(pool, organizationId);
      console.log(`[dev-init] ${org.name} (${org.slug})`);
      for (const [userPos, user] of usersForOrg(org).entries()) {
        const createdAt = registrationDate(orgPos, userPos, now);
        const { betterAuthUserId, appUserId } = await ensureIdentity(pool, user, createdAt);
        await ensureMembership(pool, organizationId, org.slug, appUserId, user.role, createdAt);
        await pruneForeignMemberships(pool, appUserId, [organizationId]);
        roster.push({
          email: user.email,
          displayName: user.displayName,
          appUserId,
          betterAuthUserId,
          organizationId,
          orgSlug: org.slug,
        });
      }
    }

    // 2. Cross-organization members (belong to ALL orgs).
    const allOrgIds = ORGS.map((org) => {
      const id = orgIdBySlug.get(org.slug);
      if (!id) throw new Error(`organization id missing for ${org.slug}`);
      return id;
    });
    const primaryOrg = ORGS[0];
    const primaryOrgId = allOrgIds[0];
    if (primaryOrg && primaryOrgId) {
      console.log("[dev-init] Cross-organization members");
      for (const [i, user] of MULTI_ORG_USERS.entries()) {
        // Established members (registered 6/5/4 days ago) so their staggered
        // per-org memberships stay safely before `now`.
        const createdAt = inDayBucket(now, REGISTRATION_WINDOW_DAYS - 1 - i, 30 + i * 11);
        const { betterAuthUserId, appUserId } = await ensureIdentity(pool, user, createdAt);
        // Membership in every org; stagger so ORG A is the deterministic
        // earliest (⇒ default active org). All within the chart window.
        for (const [orgPos, org] of ORGS.entries()) {
          const orgId = allOrgIds[orgPos];
          if (!orgId) continue;
          const membershipDate = new Date(createdAt.getTime() + orgPos * 60_000);
          await ensureMembership(pool, orgId, org.slug, appUserId, user.role, membershipDate);
        }
        await pruneForeignMemberships(pool, appUserId, allOrgIds);
        roster.push({
          email: user.email,
          displayName: user.displayName,
          appUserId,
          betterAuthUserId,
          organizationId: primaryOrgId,
          orgSlug: primaryOrg.slug,
        });
        console.log(`[dev-init]   ↔ ${user.email} → ${ORGS.map((o) => o.name).join(" · ")}`);
      }
    }

    // 3. Groups with members.
    const groupMemberEdges = await ensureGroups(pool, orgIdBySlug);

    // 4. Back-dated audit history (logins + past actions) for the charts/feed.
    const auditRows = await seedAuditHistory(pool, roster, now);

    printSummary({
      multiOrgUsers: MULTI_ORG_USERS.length,
      groups: GROUP_DEFS.length,
      groupMemberEdges,
      auditRows,
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[dev-init] FAILED", error);
  process.exit(1);
});
