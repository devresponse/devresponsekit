# Comment-Accuracy Audit — devresponsekit

Date: 2026-07-06 · Method: 17 parallel audit agents (one per directory slice) + one adversarial verifier per candidate finding (112 agents total). Read-only; no files modified.

## Resolution status (as of 2026-07-06, post-audit)

Several findings were fixed the same day, before this report was committed. The finding sections below are preserved as written at audit time; check this table first.

| Finding | Status |
|---|---|
| P0 — `src/lib/auth.ts:155` trustedProviders comment inverts better-auth linking semantics | **Fixed** in #305 — `trustedProviders: []`, comment rewritten, behavioral pin test added (`tests/security/account-linking-behavior.test.ts`) |
| P1 — `_roles-using-sheet.tsx` sends `filter.permission` (dot syntax, silently dropped) | **Fixed** in #301 |
| P1 — `_group-roles-editor.tsx` sends bare `organization=` (silently dropped) | **Fixed** in #303 |
| P1 — `0001-initial-schema.sql` baseline seed missing all five `admin.groups.*` keys | **Fixed** in #304 — backfilled by core migration 0002 + a seed ↔ `ADMIN_PERMISSION_CATALOG` drift test |
| P2 — ~42 stale `docs/admin-manager.md §N` citations across admin UI and tests | **Fixed** in #302 |

Everything else in the report (the remaining P1 comment corrections and non-citation P2s) was still open when this report was committed.

## Coverage

- In-scope TypeScript files: **700** · reviewed: **698** · skipped: 2
  - `src/db/migrations/better-auth-schema.sql` — header marks it GENERATED, DO NOT EDIT BY HAND (written by run-better-auth-generate.ts)
  - `next-env.d.ts` — Next.js auto-generated file; header says it should not be edited
- Excluded up front: `sdk/` (128 files, generated OpenAPI client), `node_modules`, `.next`, `coverage`, `test-results`.
- Batches completed: 17/17 (none failed).

## Results at a glance

| Severity | Count | Meaning |
|---|---|---|
| P0 | 1 | Wrong security/auth claim — dangerous if trusted |
| P1 | 15 | Comment contradicts actual behavior |
| P2 | 73 | Stale references, done TODOs, drifted doc pointers |

Additionally: 6 candidate findings were **refuted** during adversarial verification, and 305 suspicious-looking comments were investigated and **confirmed correct** (listed at the end so a future audit does not re-litigate them).

## Machine-readable summary

| Sev | Location | One-line |
|---|---|---|
| P0 | `src/lib/auth.ts:155` | // Only link accounts when the verified email matches; never link by // unverified email, since the alternate … |
| P1 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:76` | Extra classes for the root. The grid passes `ml-auto` so the toolbar (selection summary + actions) shares one … |
| P1 | `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor.tsx:127` | // Only the group's own org is assignable. The fetch is already scoped to // it; this is a belt-and-suspenders… |
| P1 | `src/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet.tsx:13` | Reads the existing `/api/administrator/roles` endpoint with the `permission` filter — there's no need for a de… |
| P1 | `src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:129` | // Mirror the server cap so the UI doesn't optimistically allow a // batch that the server will reject.… |
| P1 | `src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:13` | The form `POST`s to `/api/administrator/users` which performs the Better Auth + app insert in a single transac… |
| P1 | `src/app/[locale]/(secure)/error.tsx:10` | The (secure)/layout.tsx fetches the session + the user's organizations ABOVE that boundary, so a failure there… |
| P1 | `src/app/api/administrator/groups/[id]/roles/route.ts:76` | Guards (ADR-0002): every role must belong to the GROUP'S org — a group may not bundle a global or foreign-org … |
| P1 | `src/app/api/administrator/users/[id]/route.ts:162` | Soft-delete only (plan §4.1). Performs in a single Kysely tx: 1. Indefinite Better Auth ban (so the user canno… |
| P1 | `src/app/api/administrator/users/route.ts:151` | Creates a new Better Auth user (via the admin plugin) and persists the corresponding `app_users` row in a sing… |
| P1 | `src/components/admin/impersonation-banner-client.tsx:16` | "`targetAppUserId` is `null` when the banner failed to resolve the target's `app_users` row … we fall back to … |
| P1 | `src/components/auth/sign-up-form.tsx:39` | "Email verification is required (AUTH-4): after sign-up the user is sent to `/verify-email` to confirm their a… |
| P1 | `src/db/migrations/0001-initial-schema.sql:434` | the canonical `admin.*` catalog MUST stay in sync with `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permission… |
| P1 | `src/lib/admin/list-query.server.ts:13` | Centralizing the parser ensures we always reject unknown sort fields and filters rather than silently ignoring… |
| P1 | `src/lib/email/providers.server.ts:39` | `AbortSignal.timeout` rejects the fetch, which the caller records as a failed outbox row (and a future retry w… |
| P1 | `tests/unit/auth-status.extra.test.ts:11` | // Active user with deactivated membership: no explicit branch matches. // Treat as pending_approval (deny by … |
| P2 | `src/app/[locale]/(secure)/app/account/_sections.ts:5` | Both the {@link AccountSidebar} and the account landing page render from this list, so adding a future persona… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:33` | Expose an "Export CSV" button that downloads the current view via `/api/administrator/export/<resource>`. We P… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:41` | Stable key — used as the React key and forwarded to `onAction`.… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:55` | TanStack column definitions. `header` may be a translation key.… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:58` | Optional initial server-rendered page (saves first round-trip).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:50` | Stable name used for local-storage / a11y (`administrator.users`, etc.).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-selection.ts:7` | (docs/admin-manager.md §7.1, §7.2 — "select all matching")… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/metric-card.tsx:10` | Presentational KPI card for the Administrator overview (docs/admin-manager.md §8.1).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/_components/overview-list-card.tsx:17` | Presentational "recent activity" table for the Administrator overview's second tier (docs/admin-manager.md §8.… |
| P2 | `src/app/[locale]/(secure)/app/administrator/api-keys/_api-keys-grid.tsx:26` | Client-side API-key governance grid (docs/admin-manager.md §8.12).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/api-keys/new/_new-api-key-form.tsx:24` | Issue-an-API-key-on-behalf-of-a-user form (docs/admin-manager.md §8.12; docs/form-validation.md).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/api-keys/new/page.tsx:13` | Server entry for the issue-on-behalf form (docs/admin-manager.md §8.12).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx:14` | Server entry point for the API-key governance console (docs/admin-manager.md §8.12).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:61` | Stable grid name for URL/a11y bookkeeping.… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/_enterprise-apps-grid.tsx:17` | Client-side enterprise applications grid (docs/admin-manager.md §8.10, Phase 6).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/_enterprise-app-settings-form.tsx:27` | Enterprise application settings form (docs/admin-manager.md §8.10; docs/form-validation.md).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page.tsx:15` | Server entry for the enterprise application detail (docs/admin-manager.md §8.10, Phase 6).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form.tsx:24` | Client-side new enterprise application form (docs/admin-manager.md §8.10; docs/form-validation.md).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page.tsx:12` | Server entry for the create-application form (docs/admin-manager.md §8.10, Phase 6).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/enterprise-apps/page.tsx:14` | Server entry point for the enterprise applications list (docs/admin-manager.md §8.10, Phase 6).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid.tsx:99` | // The endpoint silently drops a user who isn't an ACTIVE member of the // group's org (returns `added: 0`); s… |
| P2 | `src/app/[locale]/(secure)/app/administrator/layout.tsx:23` | Per-page guards (Phase 2+) call the more specific `requireAdminPermission(<exact perm>)` to enforce the read n… |
| P2 | `src/app/[locale]/(secure)/app/administrator/memberships/_memberships-grid.tsx:15` | Client-side memberships grid (docs/admin-manager.md §19).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/memberships/page.tsx:11` | Server entry point for the cross-org memberships search (docs/admin-manager.md §19).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page.tsx:46` | Tabs (rendered client-side): - Members — paginated grid of memberships - Providers — paginated grid of provide… |
| P2 | `src/app/[locale]/(secure)/app/administrator/organizations/page.tsx:21` | Server entry point for the organizations list (docs/admin-manager.md §19).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/page.tsx:23` | Administrator overview dashboard (docs/admin-manager.md §8.1).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/permissions/_permissions-grid.tsx:15` | Permissions catalog grid (docs/admin-manager.md §8.7).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet.tsx:11` | "Roles using this permission" panel rendered inside the catalog Sheet (docs/admin-manager.md §8.7).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/permissions/new/page.tsx:9` | Administrator → New permission page (docs/admin-manager.md §8.7).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/permissions/page.tsx:13` | Permission-catalog management view (docs/admin-manager.md §8.7).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/roles/[roleId]/page.tsx:15` | Server entry for the role detail (docs/admin-manager.md §8.6).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/roles/page.tsx:13` | Server entry point for the roles list (docs/admin-manager.md §8.5).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:26` | Client-side users grid for the Administrator workspace (docs/admin-manager.md §8.2).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-memberships-panel.tsx:13` | Memberships tab for the user detail (docs/admin-manager.md §19).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:24` | 3. Renders the static metadata header + a client `UserDetailTabs` component that owns the interactive tabs (Ov… |
| P2 | `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:14` | Administrator → User detail page (docs/admin-manager.md §8.4).… |
| P2 | `src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:9` | Administrator → New user page (docs/admin-manager.md §8.3).… |
| P2 | `src/app/[locale]/(secure)/app/error.tsx:11` | This is the concrete realization of the "AdministratorErrorBoundary" referenced in docs/admin-manager.md §12 (… |
| P2 | `src/app/api/administrator/users/[id]/ban/route.ts:25` | The new password / token is never logged.… |
| P2 | `src/app/api/administrator/users/bulk/route.ts:290` | Touch the parsed action once so the audit row records the original batch surface. Per-row events written by th… |
| P2 | `src/components/admin/impersonation-banner.tsx:10` | "Server component: reads the active session and the original actor's email (best effort) so the banner shows '… |
| P2 | `src/components/ui/card.tsx:5` | Card primitive (shadcn-style). Public/auth pages use this for sign-in, sign-up, pending-approval, blocked, and… |
| P2 | `src/components/ui/dialog-manager.tsx:42` | `confirm(...)` ... Resolves with `true` if confirmed, `false` otherwise (including ESC/overlay click).… |
| P2 | `src/components/ui/select.tsx:9` | Select primitive (Radix-backed). Used by the locale switcher and any compact-mode toggle.… |
| P2 | `src/config/i18n-config.ts:7` | 3. Updating the `NEXT_PUBLIC_SUPPORTED_LOCALES` env value used by the client locale switcher.… |
| P2 | `src/config/route-regions.ts:25` | Path segments (the second segment after `/[locale]`) that belong to the auth route group. Kept in sync with `s… |
| P2 | `src/db/migrations/0001-initial-schema.sql:850` | unlike roles/keys, which mean the org is genuinely "in use" and correctly RESTRICT - see 0005… |
| P2 | `src/db/provision.ts:10` | 2. pnpm db:app:migrate — extensions (pgcrypto, pg_trgm) + app schema (0001 … 0010), ledgered in `app_schema_mi… |
| P2 | `src/db/seeds/seed-local.ts:63` | Sourced from the single canonical list in `src/lib/admin/permissions.server.ts` so the seed cannot drift from … |
| P2 | `src/lib/active-org.server.ts:16` | Security: the cookie only SELECTS among the caller's own memberships. ... a forged or stale cookie naming an o… |
| P2 | `src/lib/api-auth/scopes.ts:5` | Scopes ARE the existing permission vocabulary — the 26-key admin catalog plus a small set of user-level `accou… |
| P2 | `src/lib/docs/render/pipeline.server.ts:22` | No author JavaScript is ever executed (`allowDangerousHtml: false` keeps raw HTML out; MDX expressions are dro… |
| P2 | `src/lib/jwt-handoff.server.ts:60` | * - Tokens are short-lived (max 60s, enforced by SSO_HANDOFF_TTL_SECONDS).… |
| P2 | `src/lib/observability/metrics.server.ts:20` | Next increments (tracked in docs/observability.md §5): request latency/status by route, DB latency, auth failu… |
| P2 | `tests/db/organization-auth-settings.db.test.ts:6` | DB-BACKED integration tests for migration 0007 (`app_organization_auth_settings` — per-org signup policy) ... … |
| P2 | `tests/db/organization-invitations.db.test.ts:11` | DB-BACKED integration tests for migration 0008 (`app_organization_invitations` + the `invite_only` approval mo… |
| P2 | `tests/db/organizations-delete.db.test.ts:8` | DB-BACKED integration tests for DB-1 (org DELETE foreign-key handling). These run the real ON DELETE behavior … |
| P2 | `tests/e2e/admin-overview.spec.ts:5` | E2E — the Administrator overview dashboard (docs/admin-manager.md §8.1) renders both tiers...… |
| P2 | `tests/integration/administrator-api-keys-list.test.ts:8` | Integration tests for `GET /api/administrator/api-keys` (docs/admin-manager.md §8.12).… |
| P2 | `tests/integration/administrator-audit.test.ts:8` | Integration tests for the audit endpoint (docs/admin-manager.md Phase 6 test plan, §8.11).… |
| P2 | `tests/integration/administrator-enterprise-apps.test.ts:8` | Integration tests for the enterprise-apps endpoints (docs/admin-manager.md Phase 6 test plan, §8.10).… |
| P2 | `tests/integration/administrator-organization-members.test.ts:8` | Integration tests for the organization members endpoints (docs/admin-manager.md Phase 5 test plan).… |
| P2 | `tests/integration/administrator-organizations.test.ts:9` | Integration tests for the organizations endpoints (docs/admin-manager.md Phase 5 test plan).… |
| P2 | `tests/integration/administrator-roles.test.ts:9` | Integration tests for the roles endpoints (docs/admin-manager.md §5.1, §19, Phase 4 test plan).… |
| P2 | `tests/integration/administrator-user-actions.test.ts:8` | Integration tests for the Phase 3 user-mutation endpoints under `/api/administrator/users/[id]/*` (docs/admin-… |
| P2 | `tests/integration/administrator-users-list.test.ts:8` | Integration tests for `GET /api/administrator/users` per docs/admin-manager.md §5.1, §5.3 and §17 (test plan).… |
| P2 | `tests/integration/locale-preference.test.ts:53` | The route only calls .json(), so a minimal Request shape is enough.… |
| P2 | `tests/integration/org-scoped-admin-routes.test.ts:17` | ADR-0001 cross-tenant isolation suite (docs/adr/0001-three-tier-access-control.md).… |
| P2 | `tests/security/administrator-organizations.test.ts:10` | Security tests for the Phase-5 organization endpoints (docs/admin-manager.md §14 + §17).… |
| P2 | `tests/security/administrator-roles.test.ts:10` | Security tests for the Phase-4 endpoints (docs/admin-manager.md §14 + §17).… |
| P2 | `tests/security/administrator-users-list.test.ts:7` | Security tests for `/api/administrator/users` (docs/admin-manager.md §14 + §17 test plan / "security" layer).… |
| P2 | `tests/unit/navigation-server.test.ts:7` | The DB-backed `loadApplicationsMenu` / `loadShellMenu` / `loadNestedAppsMenu` functions are exercised by the n… |


## P0 findings

### `src/lib/auth.ts:155`

**Comment:** // Only link accounts when the verified email matches; never link by // unverified email, since the alternate provider could lie about it. (annotating trustedProviders: ["google", "microsoft", "github"])

**Actually:** In better-auth (v1.6.23), listing a provider in accountLinking.trustedProviders does the OPPOSITE of what the comment claims: it EXEMPTS that provider from the provider-side emailVerified requirement. node_modules/better-auth/dist/oauth2/link-account.mjs (implicit linking, lines 21-23) denies linking only when `!isTrustedProvider && !userInfo.emailVerified` — so a trusted provider (google/microsoft/github here) links even when the incoming OAuth profile reports emailVerified: false. The explicit link flow (dist/api/routes/callback.mjs line 94) has the same waiver. What IS still required is that the LOCAL account's email be verified (requireLocalEmailVerified defaults true) and that emails match — but the comment's specific claim, "never link by unverified email, since the alternate provider could lie about it", is exactly the check this config waives for these three providers.

**Evidence:** node_modules/better-auth/dist/oauth2/link-account.mjs lines 21-23: `const isTrustedProvider = ... c.context.trustedProviders.includes(account.providerId); if (!isTrustedProvider && !userInfo.emailVerified || requireLocalEmailVerified && !dbUser.user.emailVerified || ...) return { error: "account not linked" }` — trusted providers bypass the userInfo.emailVerified check. Also dist/api/routes/callback.mjs line 94 for the explicit-link path.

**Suggested fix:** Replace with: "Restrict implicit linking to these first-party OAuth providers; better-auth trusts them to assert the address even when the profile omits emailVerified. The LOCAL account's email must still be verified (requireLocalEmailVerified defaults true) and the emails must match; allowDifferentEmails: false blocks explicit cross-email links."

<details><summary>Verifier reasoning</summary>

The comment at src/lib/auth.ts:155-157 inverts what trustedProviders does in better-auth 1.6.23 (installed version confirmed). Default trustedProviders is [] (dist/context/helpers.mjs:151-153), under which implicit linking requires the incoming OAuth profile to report emailVerified: true for every provider. Listing ["google","microsoft","github"] EXEMPTS those providers from that check: dist/oauth2/link-account.mjs:21-23 denies linking only when `!isTrustedProvider && !userInfo.emailVerified` (reviewer's quote is verbatim accurate), and the explicit-link callback (dist/api/routes/callback.mjs:94) plus explicit-link initiation (dist/api/routes/account.mjs:147, which even waives the LOCAL user's emailVerified) carry the same waiver. The waiver is live in practice: google.mjs:120 passes through email_verified, github.mjs:74 computes `verified ?? false`, microsoft-entra-id.mjs:109 computes it and can be false — all three providers can report an unverified email. No project-side code compensates: auth.ts databaseHooks cover only user.create and session.create, and src/proxy.ts does not intercept linking/callback. What remains enforced (email match via allowDifferentEmails:false and the email-keyed lookup; local account emailVerified via requireLocalEmailVerified default true) partially covers the comment's first clause, but the specific claim 'never link by unverified email, since the alternate provider could lie about it' is exactly the check this config disables for these three providers — trusting a provider despite an unverified email IS trusting it not to lie. No reasonable reading rescues the comment. P0 stands: the comment asserts the opposite of actual behavior on a security-critical property, concealing a pre-account-takeover implicit-linking vector (attacker's provider account with an unverified matching email links to a victim's verified local account and receives a session as that user).

</details>

## P1 findings

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:76`

**Comment:** Extra classes for the root. The grid passes `ml-auto` so the toolbar (selection summary + actions) shares one row with the search/filter controls and right-aligns within it.

**Actually:** DataGrid renders <DataGridToolbar> with no className prop at all (data-grid.tsx:178-201); the toolbar now uses `display: contents` so its children flow left-to-right inline in the shared controls row — nothing right-aligns via ml-auto.

**Evidence:** data-grid.tsx lines 178-201 (props passed: totalRows, pageRowCount, selection, bulkActions, exportResource, exportState, headerActions — no className) and data-grid-toolbar.tsx:151-155 (`contents` root, comment saying children flow inline left-aligned).

**Suggested fix:** Replace with: "Extra classes for the root. No caller currently passes one; the grid relies on the `contents` root so toolbar children flow inline in the grid's single controls row."

<details><summary>Verifier reasoning</summary>

The comment on the className prop (data-grid-toolbar.tsx:74-78) claims "The grid passes `ml-auto` ... and right-aligns within it," but the sole call site (data-grid.tsx:179-201) passes no className prop at all — only totalRows, pageRowCount, selection, bulkActions, exportResource, exportState, headerActions. A repo-wide grep for `ml-auto` in the grid directory matches only the stale comment itself, and DataGridToolbar is imported nowhere else, so no indirection makes the claim true. The alignment assertion is also contradicted by the implementation's own comments: the toolbar root uses `display: contents` (data-grid-toolbar.tsx:150-155) with a comment explicitly saying children flow "inline (left-aligned) ... rather than forming a separately-aligned cluster," and data-grid.tsx:159-163 confirms all controls flow left-to-right as direct flex items of one row. Both concrete factual assertions in the comment (ml-auto is passed; toolbar right-aligns) are false; the only true fragment (shares one row) is attributed to a nonexistent mechanism. P1 stands: the comment fabricates a cross-file contract that is the opposite of actual behavior and would actively mislead a developer, though there is no runtime defect (so not P0).

</details>

### `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor.tsx:127`

**Comment:** // Only the group's own org is assignable. The fetch is already scoped to // it; this is a belt-and-suspenders guard so a foreign-org role can never // slip into the list (and then fail on save).

**Actually:** The fetch (line 83) uses `/api/administrator/roles?organization=${groupOrgId}&pageSize=200`, but the roles endpoint only recognises filters in `filter[name]=` form: parseListQuery (src/lib/admin/list-query.server.ts:97) matches keys against /^filter\[([^\]]+)\]/ and the roles GET reads query.filters.organization. A bare `organization=` param is silently dropped, so the catalog is NOT server-side scoped — the client-side `.filter((r) => r.organization_id === orgId)` is the ONLY guard, not a belt-and-suspenders one.

**Evidence:** src/lib/admin/list-query.server.ts:94-102 (only filter[...] keys parsed); src/app/api/administrator/roles/route.ts:53,66-73 (reads query.filters.organization); contrast _organization-invitations-panel.tsx:103 which correctly uses `filter[organization]=`. The adjacent comment at lines 79-84 ('Server-side scoping is required because of the pageSize cap — a client-only filter could miss the group's roles if other orgs' filled the first page') describes exactly the failure mode that is currently live for a superadmin with >200 roles across orgs.

**Suggested fix:** Correct the fetch to `filter[organization]=` (code fix), or rewrite the comment to: 'The `organization` param is not honoured by the endpoint (filters must use filter[organization]); this client-side filter is currently the only scoping guard.'

<details><summary>Verifier reasoning</summary>

The comment claims the roles fetch is server-side scoped to the group's org and the client filter is merely belt-and-suspenders. It is not. The fetch (line 83) passes a bare `organization=` param, but parseListQuery (src/lib/admin/list-query.server.ts:95-98) only parses keys matching /^filter\[([^\]]+)\]/ into query.filters, and the roles GET (src/app/api/administrator/roles/route.ts:66) reads only query.filters.organization — so the param is silently dropped. No indirection saves it: src/proxy.ts does not rewrite /api query params, this is the only bare-form caller in the repo, and both the OpenAPI spec (openapi-admin.ts:1442) and the sibling _organization-invitations-panel.tsx:103 use the correct `filter[organization]=` form. The only server-side scoping that does happen is ADR-0001 guard scoping (route.ts:104-110), which scopes org admins to their own org but leaves a superadmin ({kind:"all"}) fully unscoped — for superadmins the client-side `.filter((r) => r.organization_id === orgId)` at line 130 is the ONLY guard. The adjacent comment (lines 79-84) even states server-side scoping is required because of the pageSize cap, which is exactly the failure mode now live: a superadmin with >200 roles across orgs can silently lose the group's roles from the available list. The comment inverts the actual state of the code and invites deletion of the load-bearing client filter. Severity P1 stands: live functional bug plus regression risk, but no data corruption or tenancy breach (the assignment endpoint independently rejects foreign roles with 404).

</details>

### `src/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet.tsx:13`

**Comment:** Reads the existing `/api/administrator/roles` endpoint with the `permission` filter — there's no need for a dedicated reverse-lookup endpoint, and reusing the list endpoint inherits its pagination, sort, and permission-gating contract for free.

**Actually:** The code (line 38) sends `url.searchParams.set("filter.permission", permissionKey)` — dot syntax. parseListQuery (src/lib/admin/list-query.server.ts:97) only matches the bracket syntax /^filter\[([^\]]+)\]/ and silently drops unknown keys, and /api/administrator/roles (allowedFilters ["organization","scope","permission"]) never receives a `permission` filter. The panel therefore lists ALL roles the caller can see (first 200), not the roles using the permission.

**Evidence:** _roles-using-sheet.tsx:38 vs list-query.server.ts:94-102 (filter[name] regex, unknown keys dropped) and src/app/api/administrator/roles/route.ts:53,82 (permFilter read from query.filters.permission). The canonical client serializer gridStateToSearchParams uses `filter[${name}]`.

**Suggested fix:** The comment describes intended behavior; the code is what's wrong — change the request to `filter[permission]` (a fix task was spawned). If the code is not fixed, the comment must instead say the filter is currently not applied.

<details><summary>Verifier reasoning</summary>

The client (_roles-using-sheet.tsx:38) sends `filter.permission` (dot syntax), but parseListQuery (src/lib/admin/list-query.server.ts:97) only matches bracket syntax `/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/` and silently drops non-matching keys, so query.filters.permission is always undefined at src/app/api/administrator/roles/route.ts:82 and the EXISTS predicate (lines 84-94) never runs. All rewrite paths were ruled out: src/proxy.ts passes /api/ through untouched (and its matcher excludes api entirely), there is no middleware.ts, the literal `filter.permission` appears nowhere else in src, and both the canonical client serializer (use-grid-state.ts:84-86) and the OpenAPI spec for this endpoint (openapi-admin.ts:1442, `filter[permission]`) confirm bracket syntax is the only contract. The panel therefore lists the first 200 roles visible to the caller instead of roles holding the permission, so the comment's claim of reading the endpoint "with the permission filter" misstates actual behavior. Severity corrected to P1: the output is silently wrong and misleading for RBAC decisions, but there is no security breach (rows shown are already in the caller's scope), no mutation, and the blast radius is one informational admin sheet.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:129`

**Comment:** // Mirror the server cap so the UI doesn't optimistically allow a // batch that the server will reject.

**Actually:** No server cap is mirrored. The only guard that follows is `if (selection.mode === "page" && explicitIds.length === 0) return;` (empty selection). The server caps ids at MAX_BULK_IDS = 500 (zod .max(500)); the client never checks the count, so a selection larger than 500 is sent and rejected with 400 invalid_body, surfacing only the generic error toast. Neither the grid nor use-grid-selection.ts contains any 500/MAX constant.

**Evidence:** src/app/api/administrator/users/bulk/route.ts:59,69 (MAX_BULK_IDS=500, idsSchema .min(1).max(500)); grep for 500/cap/MAX across administrator/_components/grid and _users-grid.tsx finds no client-side cap; comment present unchanged since the introducing commit 3c4ff39.

**Suggested fix:** Replace with: 'Nothing to send in page mode with an empty selection (the server rejects an empty ids array).' — or actually mirror the cap by refusing/truncating selections over 500.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:129-130 claims the code mirrors the server cap, but the only code following it is `const explicitIds = Array.from(selection.selectedIds); if (selection.mode === "page" && explicitIds.length === 0) return;` — an empty-selection guard. The server cap is MAX_BULK_IDS = 500 (src/app/api/administrator/users/bulk/route.ts:59, idsSchema `.min(1).max(MAX_BULK_IDS)` at line 69). No 500/MAX constant, slice, or count check exists anywhere in _users-grid.tsx, use-grid-selection.ts, data-grid.tsx, or data-grid-toolbar.tsx; `body.ids = explicitIds` is sent unsliced. The failure is reachable: selection persists across page navigations (nothing clears selectedIds on page change) and page sizes go up to 100, so a page-mode selection >500 is possible and yields a 400 invalid_body surfaced only as the generic error toast (lines 166-168). The codebase's own vocabulary makes "cap" unambiguous — the route docblock says "`ids` is capped at MAX_BULK_IDS (500)" and use-grid-selection.ts says "capped at the bulk endpoint's MAX_BULK_IDS" — so the comment cannot be defended as referring to the .min(1) floor (a floor is not a "cap"). Git history confirms the comment was introduced in 3c4ff39 with this exact code and never had accompanying cap logic. The comment demonstrably misstates what the code does under every reasonable reading. Severity P1 stands: the comment asserts a nonexistent client-side guard for a server contract, misleading maintainers, and the unguarded path produces a real user-visible unexplained failure — though the server still enforces the invariant, so it is not P0.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:13`

**Comment:** The form `POST`s to `/api/administrator/users` which performs the Better Auth + app insert in a single transaction.

**Actually:** The route performs two independent, non-transactional writes: createBetterAuthUser() (Better Auth admin API) followed by a separate db.insertInto("app_users"). There is no db.transaction() wrapper; the route even handles the app-insert unique-violation race (SQLSTATE 23505) by returning 409 email_taken AFTER the Better Auth user was already created, leaving an orphaned auth user — impossible if it were one transaction.

**Evidence:** src/app/api/administrator/users/route.ts:214-285 — createBetterAuthUser at 216, separate insertInto at 260, 23505 catch at 271-284 with no rollback of the auth user.

**Suggested fix:** Replace with: 'The form POSTs to /api/administrator/users which creates the Better Auth user and then inserts the app_users row (two sequential writes; a duplicate-email race maps to 409).'

<details><summary>Verifier reasoning</summary>

The comment claims the POST /api/administrator/users handler performs the Better Auth + app insert "in a single transaction". The code refutes this on every reading: (1) createBetterAuthUser (route.ts:216) is a Better Auth admin-plugin API call (auth.api.createUser in src/lib/admin/auth-admin.server.ts:53-72) sharing no transaction handle with the route; (2) the app_users insert (route.ts:260-270) is a bare db.insertInto with no db.transaction().execute wrapper — sibling routes ([id]/route.ts:244, [id]/restore/route.ts:89, [id]/app-roles/route.ts:154,235) use db.transaction(), this one does not; the only "transaction" string in this file is the equally-wrong docstring at line 152; (3) the SQLSTATE 23505 catch (route.ts:271-284) returns email_taken 409 after the auth user already exists and logs the orphaned betterAuthUserId in audit metadata with no compensating delete — a state impossible under one transaction; the code's own comment at lines 253-257 acknowledges the race. Indirection checks also fail: the Better Auth user.create databaseHook (src/lib/auth.ts:223-262) explicitly excludes admin creation ("Admin / machine-API creation ... provisions app_users itself"), so no hook-level atomic path exists. P1 severity stands: the comment asserts a nonexistent atomicity guarantee that conceals a real orphaned-auth-user consistency hazard.

</details>

### `src/app/[locale]/(secure)/error.tsx:10`

**Comment:** The (secure)/layout.tsx fetches the session + the user's organizations ABOVE that boundary, so a failure there would otherwise skip the app-level boundary and hit the English-only global-error.tsx. This catches those layout-level throws and keeps them localized (P2-13).

**Actually:** A segment's error.tsx cannot catch errors thrown by the layout.tsx of its OWN segment: Next.js nests the error boundary inside that layout (verified in node_modules/next/dist/server/app-render/create-component-tree.js line ~462 — the segment's ErrorComponent is passed to the LayoutRouter that renders the segment's children, which SecureLayout receives as its `children` prop; and node_modules/next/dist/client/components/layout-router.js line ~558). So a throw from requireSecureSession or listUserActiveOrganizations inside src/app/[locale]/(secure)/layout.tsx bypasses (secure)/error.tsx, bubbles past [locale] (which has no error.tsx), and still renders the English-only src/app/global-error.tsx. This boundary only catches errors from the segments BELOW (secure) — which (secure)/app/error.tsx already covers for pages, since (secure)/app has no layout.tsx.

**Evidence:** src/app/[locale]/(secure)/layout.tsx lines 56-64 (awaits requireSecureSession and listUserActiveOrganizations in the layout body); glob shows no src/app/[locale]/error.tsx and no src/app/[locale]/(secure)/app/layout.tsx; Next.js 16.2.10 create-component-tree.js lines 57/78/462-464 show the current segment's error module wraps only its child parallel routes, an element passed INTO the layout as children.

**Suggested fix:** Rewrite to: "Error boundary at the (secure) GROUP level, below (secure)/layout.tsx. NOTE: an error.tsx cannot catch throws from its own segment's layout — failures in (secure)/layout.tsx (session/org fetches) still bypass this boundary and land on the English-only global-error.tsx; catching those would require an error.tsx in the parent [locale] segment. This boundary localizes errors from the (secure) subtree that (secure)/app/error.tsx does not cover (P2-13)."

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/error.tsx claims it catches throws from (secure)/layout.tsx's session/org fetches so they don't hit the English-only global-error.tsx. Verified against Next.js 16.2.10 in node_modules: create-component-tree.js loads the CURRENT segment's error module (lines 57/78) and passes it to the LayoutRouter rendering the segment's CHILD parallel routes (lines 462-464); that LayoutRouter is what SecureLayout receives as its `children` prop, and layout-router.js line 558 places the ErrorBoundary around only that child subtree. Thus (secure)/error.tsx is nested INSIDE SecureLayout and cannot catch throws from requireSecureSession (layout.tsx line 56) or listUserActiveOrganizations (line 64) — those render in the parent [locale] slot. [locale] has no error.tsx (confirmed by glob), and error-boundary.js lines 124-135 show an undefined errorComponent is a pass-through Fragment; src/app has no error.tsx either, so such throws still reach the English-only src/app/global-error.tsx — exactly what the comment claims to prevent. This matches documented Next.js behavior (error.js does not handle errors in the same segment's layout.js). No defensible alternative reading exists: the awaits are directly in the layout body, redirect() throws go to RedirectBoundary regardless, and streaming/soft-nav error surfacing is positional. The comment demonstrably misstates the code's behavior and documents a nonexistent safety net; P1 severity is appropriate.

</details>

### `src/app/api/administrator/groups/[id]/roles/route.ts:76`

**Comment:** Guards (ADR-0002): every role must belong to the GROUP'S org — a group may not bundle a global or foreign-org role (404). Only a SUPERADMIN may bundle a role that carries the `superuser` marker (privilege escalation → 403).

**Actually:** The 403 guard is much broader than the documented superuser-marker-only check: a non-SUPERADMIN is refused when the roles confer ANY permission key the actor does not hold themselves (full subset check via unheldPermissionKeys), not only the `superuser` marker. A reader trusting the doc would expect attaching a non-superuser role carrying unheld permissions to succeed; it returns 403.

**Evidence:** Same file, lines 120-129: `permissionKeysForRoles(...)` + `unheldPermissionKeys(guard.access.permissions, conferred)` → 403 on any unheld key; the inline comment at line 124 states 'Subsumes the old `superuser`-marker-only check', confirming the JSDoc describes the removed guard.

**Suggested fix:** Guards (ADR-0002): every role must belong to the GROUP'S org — a group may not bundle a global or foreign-org role (404). A non-SUPERADMIN may bundle only roles whose conferred permissions are a subset of their own (403 otherwise, AUTHZ-3) — this subsumes the old superuser-marker-only check.

<details><summary>Verifier reasoning</summary>

The JSDoc (lines 75-77) enumerates the endpoint's guards and describes the 403 as superuser-marker-only, but the code at lines 125-128 rejects any non-SUPERADMIN whose requested roles confer ANY permission key not in their own held set (permissionKeysForRoles + unheldPermissionKeys, a full exact subset test over concrete catalog keys per src/lib/admin/grantable-permissions.server.ts:54-66). The inline comment at line 124 explicitly states this "Subsumes the old `superuser`-marker-only check," confirming the JSDoc describes the removed guard. The only defense — that the marker sentence is literally still true (the `superuser` marker is a permission key, SUPERADMIN_PERMISSION in src/lib/admin/permissions.ts:87, so marker roles do 403 for non-superadmins) — fails because the JSDoc frames itself as the complete guard list ("Guards (ADR-0002): ..."), and a reader would wrongly predict that attaching a non-marker same-org role carrying an unheld permission succeeds; it returns 403 forbidden. No other layer (proxy, middleware, hooks) alters this; the guard is entirely in the handler. Severity P1 stands: the doc misstates an admin route's authorization contract (misleading consumers and inviting a regression to the marker-only check), but is not P0 since the actual code is stricter than documented, so trusting the doc cannot itself open a vulnerability.

</details>

### `src/app/api/administrator/users/[id]/route.ts:162`

**Comment:** Soft-delete only (plan §4.1). Performs in a single Kysely tx: 1. Indefinite Better Auth ban (so the user cannot sign in). 2. `app_users.status = 'deactivated'` + `deactivated_*` columns.

**Actually:** The Better Auth ban is NOT inside the Kysely transaction — it is an external auth-API call executed BEFORE the transaction (line 215). Only the app-side bookkeeping (app_users update + membership cascade) runs in a tx (line 244), with a compensating unban saga if the tx fails (lines 239-297). The two steps are explicitly non-atomic.

**Evidence:** Same file: `banBetterAuthUser(...)` at lines 214-222 runs outside any transaction; `db.transaction().execute(...)` at line 244 covers only the DB updates; the inline comment at lines 239-242 admits 'Wrapped in a saga: if the DB transaction fails after we already banned the user in Better Auth, we issue a compensating unban'.

**Suggested fix:** Soft-delete only (plan §4.1). Two steps: 1. Indefinite Better Auth ban (an auth-API call, outside the DB transaction). 2. `app_users.status = 'deactivated'` + `deactivated_*` columns and the membership cascade in one Kysely tx, with a compensating unban if the tx fails (saga, #B6).

<details><summary>Verifier reasoning</summary>

The header comment (lines 162-164 of src/app/api/administrator/users/[id]/route.ts) claims the Better Auth ban and the app_users deactivation both occur "in a single Kysely tx". The code contradicts this: banBetterAuthUser is called at lines 214-222 as an external auth-API call before any transaction exists, with its own failure path returning a 502; the Kysely transaction at line 244 covers only the app_users update and the membership cascade; and the inline comment at lines 239-242 explicitly describes a compensating-unban saga (unbanBetterAuthUser at line 284) precisely because the two steps are non-atomic. No reasonable reading makes the header comment defensible — the file's own inline comments refute it. Severity P1 stands: the doc block misstates atomicity/failure semantics (a crash between ban and tx leaves the stores drifted with no compensation, which the header implies cannot happen), which could mislead maintainers reasoning about consistency.

</details>

### `src/app/api/administrator/users/route.ts:151`

**Comment:** Creates a new Better Auth user (via the admin plugin) and persists the corresponding `app_users` row in a single transaction.

**Actually:** There is no transaction spanning the two writes, and no explicit transaction at all: `createBetterAuthUser` is an external auth-API call (line 216), and the `app_users` insert is a standalone `db.insertInto` (line 260). If the insert fails, the Better Auth user is NOT rolled back — only the unique-violation race is caught and mapped to a 409; any other insert failure leaves an orphaned auth user.

**Evidence:** Lines 214-235 (auth create, separate try/catch) and lines 258-285 (plain insert with 23505 handling, no db.transaction()); the inline comment at lines 252-257 itself describes the read-then-write race handling rather than atomicity.

**Suggested fix:** Creates a new Better Auth user (via the admin plugin), then persists the corresponding `app_users` row as a second, non-transactional step (a duplicate-email race on the insert is translated to the same `email_taken` 409; other insert failures leave the auth user to be reconciled).

<details><summary>Verifier reasoning</summary>

The comment at src/app/api/administrator/users/route.ts:151-152 claims the Better Auth user creation and the app_users insert happen "in a single transaction", but the code performs two independent, non-atomic operations: (1) createBetterAuthUser at lines 216-224 — a wrapper (src/lib/admin/auth-admin.server.ts:53-72) around auth.api.createUser, which commits its own writes through Better Auth's adapter and accepts no transaction handle; (2) a standalone db.insertInto("app_users") at lines 260-270 on the global db instance. There is no db.transaction() anywhere in the file — the only occurrence of "transaction" is the inaccurate comment itself. Indirection was ruled out: the better-auth databaseHooks.user.create.after hook (src/lib/auth.ts:223-262) explicitly excludes admin creation ("Admin / machine-API creation ... provisions app_users itself"), so no hook makes the pair atomic. The code's own inline comment at lines 252-257 confirms non-atomicity by describing the 23505 race handling; any non-unique-violation insert failure rethrows (line 284), leaving an orphaned Better Auth user with no rollback. No reasonable reading of "single transaction" is satisfied by two uncoordinated commits across two write paths. P1 severity is correct: the comment misstates a consistency guarantee on an admin mutation endpoint (misleading for maintenance and incident diagnosis) but is a documentation defect rather than a P0 data-loss code bug.

</details>

### `src/components/admin/impersonation-banner-client.tsx:16`

**Comment:** "`targetAppUserId` is `null` when the banner failed to resolve the target's `app_users` row … we fall back to a known-bad sentinel UUID so the endpoint's UUID validator still passes; the server then returns 404 and the cookie clear still fires from the server-side stop call" (and, line 9-10: the DELETE endpoint "requires the [id] for symmetry / audit")

**Actually:** The DELETE handler in src/app/api/administrator/users/[id]/impersonate/route.ts (lines 140-218) never reads the [id] segment at all (its signature takes only `request`, no ctx), has no UUID validator, and has no 404 path — its own doc says "The `[id]` segment is ignored — the impersonated identity (and the audit target) come from the live session, not the URL." With the sentinel UUID the stop simply succeeds with 200; there is no 404-but-cookie-cleared case. The [id] is required only by the URL shape, not for audit.

**Evidence:** src/app/api/administrator/users/[id]/impersonate/route.ts:140 `export async function DELETE(request: NextRequest)` (no RouteContext param), lines 136-138 doc stating [id] is ignored, and the handler's only responses: 403 untrusted_origin, 401, 400 not_impersonating, 429, 502, 200 — never 404. This also contradicts the P2-1 comment in the same client file (only 2xx treated as success), which is the accurate one.

**Suggested fix:** Replace with: "`targetAppUserId` is `null` when the banner failed to resolve the target's `app_users` row; we fall back to a sentinel UUID purely to satisfy the URL shape — the DELETE handler ignores the [id] segment entirely (the impersonated identity and audit target come from the live session), so the stop succeeds normally."

<details><summary>Verifier reasoning</summary>

The comment demonstrably misstates the code. (1) The DELETE handler at src/app/api/administrator/users/[id]/impersonate/route.ts:140 has signature `DELETE(request: NextRequest)` — no ctx param — and its own doc (lines 136-138) says the [id] segment is ignored; audit attribution comes from the live session (lines 170-176, 204-213), so "requires the [id] for symmetry / audit" is wrong on the audit half. (2) There is no UUID validator on the DELETE path: the only UUID check (isUuid/resolveTargetUser in src/lib/admin/user-target.server.ts) is called only by POST (route.ts:59), and no middleware/proxy indirection applies to /api/administrator (verified by grep). (3) The DELETE handler has no 404 response — its complete response set is 403, 401, 400, 429, 502, and 200 — so the comment's "sentinel UUID → validator passes → server returns 404 but cookie still clears" flow cannot occur; with the sentinel the stop simply returns 200. The invented narrative also directly contradicts the accurate P2-1 comment in the same client file (only 2xx is success; errors return BEFORE the cookie clears). No reasonable reading of the code supports the comment. P1 severity stands: the comment describes a nonexistent fail-safe that could mislead a maintainer.

</details>

### `src/components/auth/sign-up-form.tsx:39`

**Comment:** "Email verification is required (AUTH-4): after sign-up the user is sent to `/verify-email` to confirm their address; once verified they land in the app and the provisioning service places non-seed users into `pending_approval`."

**Actually:** Since the 0007 per-org signup policy, both claims are conditional, not unconditional: an org policy can waive verification (the embedded EmailPasswordSignUpForm then skips /verify-email, signs in immediately and redirects to the app — its own doc lines 55-60 and code lines 106-124 describe exactly this branch), and decideInitialStatus can place a non-seed, non-invited user directly `active` (signup_approval_mode = 'auto_active', or a verified email matching auto_approve_email_domains) rather than `pending_approval`. Only the fail-closed default matches the comment.

**Evidence:** src/lib/auth-policy.server.ts decideInitialStatus lines 250-283: `hasValidInvitation` → active, `auto_active` → active, verified domain match → active, else pending_approval. src/components/auth/email-password-sign-up-form.tsx lines 55-60/106-124 implement the verification-waived immediate-sign-in path. The later paragraphs of this same header (invitation, organization scoping "subject to the org's signup policy") were updated for 0007/0008 but this first paragraph was not.

**Suggested fix:** Reword to: "The workflow follows the organization's signup policy (0007). Under the fail-closed default, email verification is required (AUTH-4): after sign-up the user is sent to `/verify-email`, and non-seed users are placed into `pending_approval`. Policy can waive verification and/or activate the account immediately (auto_active mode, verified auto-approve domains)."

<details><summary>Verifier reasoning</summary>

The comment states two unconditional invariants that the code makes policy-conditional since migration 0007. (1) "after sign-up the user is sent to /verify-email": the child component this wrapper renders (src/components/auth/email-password-sign-up-form.tsx, doc lines 50-60, code lines 106-124) implements a verification-waived branch — when result.data.user.emailVerified is true (org policy waived verification, server pre-verified at creation), the form signs in immediately with callbackURL = postVerifyHref (the app) and never routes to /verify-email. (2) "the provisioning service places non-seed users into pending_approval": src/lib/user-provisioning.server.ts:207-224 routes non-seed users through decideInitialStatus (src/lib/auth-policy.server.ts:250-291), which returns active for a non-seed, non-invited user under signup_approval_mode = 'auto_active' or a verified email matching auto_approve_email_domains. Both conditional paths are reachable from this exact component (organizationHint on line 93; email-domain routing at user-provisioning.server.ts:153-164 even for unscoped sign-ups). Defenses fail: the comment lacks any "by default" qualifier — and the sibling child-component doc explicitly writes "Verification required (the fail-closed default, AUTH-4)", showing the codebase qualifies this claim where it was updated; paragraph 2 carves out only invitations, and paragraph 3's "subject to the org's signup policy" contradicts paragraph 1 rather than rescuing it, confirming the first paragraph is a stale pre-0007 remnant. P1 severity is appropriate: misleading about security-adjacent approval/verification behavior, but no runtime defect.

</details>

### `src/db/migrations/0001-initial-schema.sql:434`

**Comment:** the canonical `admin.*` catalog MUST stay in sync with `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts` — the runtime check, the seed script, and this schema share the same keys.

**Actually:** The INSERT below (lines 437-469) seeds 30 admin.* keys plus `superuser` but is missing all five `admin.groups.*` keys (admin.groups.read/create/update/delete/assign) that ADMIN_PERMISSION_CATALOG contains. A migrated-but-not-seeded database (the exact scenario this baseline-data section says it exists for, lines 421-424) has no group-admin permission rows, so group permissions cannot be granted and group admin gates cannot be satisfied until pnpm db:seed runs.

**Evidence:** src/lib/admin/permissions.ts lines 39-43 define admin.groups.read/create/update/delete/assign inside ADMIN_PERMISSION_CATALOG; the SQL insert at 0001-initial-schema.sql lines 437-469 enumerates every other catalog key but none of the admin.groups.* keys. Only src/db/seeds/seed-local.ts and dev-init.ts (which loop over ADMIN_PERMISSION_CATALOG) backfill them.

**Suggested fix:** Either add the five admin.groups.* rows to the idempotent insert (on conflict do nothing makes this safe even in the FROZEN file's spirit, but if the file truly must not change, append a new NNNN migration) or correct the comment to: "the catalog here predates the groups feature; admin.groups.* keys are added by the seed (ADMIN_PERMISSION_CATALOG) — this schema does NOT contain the full catalog".

<details><summary>Verifier reasoning</summary>

The comment at 0001-initial-schema.sql lines 432-436 asserts the schema insert, ADMIN_PERMISSION_CATALOG, and the seed "share the same keys." They do not: src/lib/admin/permissions.ts (lines 39-43) defines admin.groups.read/create/update/delete/assign, while the SQL insert (lines 437-469) seeds the other 30 admin.* keys plus superuser but omits all five admin.groups.* keys. No other SQL file in the repo mentions admin.groups (0001 is the only core migration; the rest are locale email templates), so nothing backfills them at migration time — only seed-local.ts/dev-init.ts, which loop over the catalog. The groups feature is not a later addition: app_groups/app_group_roles/app_group_memberships are created in this same file (lines 134-162), and the section's own preamble (lines 421-424) claims the baseline rows let a migrated-but-not-seeded DB recognize the administrator surface. Runtime permission resolution joins app_permissions rows (auth-status.ts), so the missing rows make admin.groups.* ungrantable until seeded. The comment demonstrably misstates the code under any reasonable reading. Severity corrected to P1: the gap fails closed (403, no escalation), superadmins bypass gates via the isSuperadmin marker (and a migrated-not-seeded DB only has the superuser role), and the rows are recoverable via db:seed or the existing POST /api/administrator/permissions catalog API — a real functional defect on the migrate-only path, but not a P0 security/blocker issue.

</details>

### `src/lib/admin/list-query.server.ts:13`

**Comment:** Centralizing the parser ensures we always reject unknown sort fields and filters rather than silently ignoring them, which is what an attacker would probe for.

**Actually:** parseListQuery silently drops unknown sort fields (line 85: `if (!field || !allowedSort.has(field)) continue;`) and unknown filter keys (line 102: `if (allowedFilters && !allowedFilters.has(name)) continue;`). No error, 400, or any signal is ever produced for an unknown field — the request succeeds with the field ignored. The module's own option docs (lines 36-38) state the opposite of the header: 'Unknown fields are silently dropped.' / 'Unknown keys are silently dropped.'

**Evidence:** src/lib/admin/list-query.server.ts lines 79-89 (sort loop, `continue` on unknown field), lines 94-123 (filter loop, `continue` on disallowed key), lines 36-38 (ParseListQueryOptions JSDoc saying 'silently dropped'), and the full function body which contains no throw or error return path.

**Suggested fix:** Change the header sentence to: 'Centralizing the parser ensures unknown sort fields and filters are consistently dropped before they can reach SQL, rather than being passed through — which is what an attacker would probe for.'

<details><summary>Verifier reasoning</summary>

The header comment (src/lib/admin/list-query.server.ts lines 13-15) claims the centralized parser "always reject[s] unknown sort fields and filters rather than silently ignoring them," but parseListQuery does exactly the opposite: unknown sort fields hit `continue` at line 85 and disallowed filter keys hit `continue` at line 102, with no throw, error return, or 400 anywhere in the function — the request succeeds with the field ignored. The same file's own JSDoc contradicts the header twice ("Unknown fields are silently dropped." line 35; "Unknown keys are silently dropped." line 37; plus lines 58-63), and the contract the header cites, docs/admin-manager.md §5.1, states "Unknown sort fields are dropped" (line 303) and "Unknown filters are dropped" (line 309). I checked all 20+ route-handler callers' layer for any external rejection path — none exists; the drop-not-reject behavior is the published API contract. The only alternative reading ("reject" = keep out of SQL) fails because the comment explicitly contrasts rejection with "silently ignoring," which is precisely the implemented behavior. Severity P1 stands: the comment falsely asserts a security-signaling property, but the actual behavior (allowlist drop) is still injection-safe, so it misleads maintainers/reviewers rather than creating a vulnerability.

</details>

### `src/lib/email/providers.server.ts:39`

**Comment:** `AbortSignal.timeout` rejects the fetch, which the caller records as a failed outbox row (and a future retry worker can re-attempt).

**Actually:** The caller (sendAppEmail in src/lib/email/send.server.ts) records a timeout/failure as a RETRYABLE row: status stays 'pending' with attempts=1 and a future next_attempt_at; a row only becomes 'failed' after OUTBOX_MAX_ATTEMPTS (5) in the worker. And the retry worker is no longer 'future' — it exists (src/lib/email/outbox-worker.server.ts, review D1) and is invoked via `pnpm outbox:drain`.

**Evidence:** send.server.ts:185-203 catch block sets attempts/next_attempt_at but not status (row keeps 'pending', inline comment there says 'Leave the row RETRYABLE ... rather than terminally failed'); outbox-worker.server.ts:22 OUTBOX_MAX_ATTEMPTS=5 and :118-130 only marks 'failed' when attempts >= cap; package.json:28 has the outbox:drain script.

**Suggested fix:** Replace with: "`AbortSignal.timeout` rejects the fetch, which the caller records as a retryable pending outbox row; the outbox worker (outbox-worker.server.ts) re-attempts it with backoff."

<details><summary>Verifier reasoning</summary>

The comment misstates the caller's behavior in two verifiable ways. (1) "recorded as a failed outbox row": send.server.ts inserts the row with status 'pending' (line 152) and its catch block (lines 185-202) sets attempts=1, last_attempt_at, next_attempt_at (backoff via backoffDelayMs) and error but never changes status — the row remains 'pending' and the function returns status 'pending'. 'failed' is a distinct terminal status in this system (SendAppEmailResult enumerates both 'failed' and 'pending'; the catch block's own comment says "Leave the row RETRYABLE (still `pending`...) rather than terminally `failed`"), and a row only becomes 'failed' in outbox-worker.server.ts:118-122 once attempts >= OUTBOX_MAX_ATTEMPTS (5). (2) "a future retry worker": the worker exists at src/lib/email/outbox-worker.server.ts, package.json:28 defines the outbox:drain script, and send.server.ts already imports backoffDelayMs/summarizeDeliveryError from the worker module. No reasonable reading rescues the comment: the 'failed' status name is load-bearing and directly contradicted by adjacent code and comments. Severity P1 stands — the comment misleads about the outbox state machine at the exact place a developer/operator debugging delivery timeouts would look (e.g. querying status='failed' would miss all retryable timed-out rows), but it is not security- or data-loss-misleading, so not P0.

</details>

### `tests/unit/auth-status.extra.test.ts:11`

**Comment:** // Active user with deactivated membership: no explicit branch matches. // Treat as pending_approval (deny by default). (file header similarly claims this file "exercises the residual fallthrough branches")

**Actually:** The test calls decideSecureAccess("active", "pending_approval") — not a "deactivated" membership ("deactivated" is not even a member of the MembershipStatus union: "active" | "pending_approval" | "blocked" | "suspended", src/lib/auth-status.ts:16). And an explicit branch DOES match: src/lib/auth-status.ts:77 `if (membership === "pending_approval") return "pending_approval";` handles this pair directly, so the test never reaches the residual fallthrough at line 80 (which is unreachable for typed inputs).

**Evidence:** src/lib/auth-status.ts:16 (MembershipStatus union has no "deactivated"), :70-81 (decideSecureAccess: line 77 is the explicit membership==="pending_approval" branch; line 80 is the fallthrough) vs tests/unit/auth-status.extra.test.ts:13 which passes "pending_approval" as the membership argument.

**Suggested fix:** Replace with: // Active user with a pending_approval membership hits the explicit membership==="pending_approval" branch and stays pending_approval (deny by default).

<details><summary>Verifier reasoning</summary>

The comment is demonstrably wrong on every point. (1) The test at tests/unit/auth-status.extra.test.ts:13 calls decideSecureAccess("active", "pending_approval") — the membership argument is "pending_approval", not "deactivated"; "deactivated" is not even a member of the MembershipStatus union (src/lib/auth-status.ts:16: "active" | "pending_approval" | "blocked" | "suspended"). (2) "No explicit branch matches" is false: src/lib/auth-status.ts:77 (`if (membership === "pending_approval") return "pending_approval";`) explicitly handles this exact pair, so the residual fallthrough at line 80 is never executed by this test. (3) The file header's claim of exercising "the residual fallthrough branches" is also false — tracing lines 74–79 shows line 80 is unreachable for any correctly-typed input, and both tests in the file only pass valid typed pairs that hit explicit branches. Grep confirms a single decideSecureAccess implementation imported directly (no mock/indirection), so no alternate reading rescues the comment. Severity P1 stands: the comment falsely asserts coverage of the fail-closed fallthrough of a security-decision function used by every secure-route guard, giving false confidence that the deny-by-default path is regression-tested when it is not.

</details>

## P2 findings

### `src/app/[locale]/(secure)/app/account/_sections.ts:5`

**Comment:** Both the {@link AccountSidebar} and the account landing page render from this list, so adding a future personal-data area (Notifications, Connected accounts, API tokens, Data export, …) is a ONE-entry change: append a descriptor here and add the matching route folder.

**Actually:** Only AccountSidebar consumes the registry. A repo-wide grep for ACCOUNT_SECTIONS/getVisibleAccountSections/_sections shows the sole importer is src/app/[locale]/(secure)/app/account/_components/account-sidebar.tsx. The account landing page (src/app/[locale]/(secure)/app/account/page.tsx) renders identity/membership/permissions overview cards from getAccountOverview and never imports the registry, so `descriptionKey` has no consumer and adding a section updates the sidebar only, not the landing page.

**Evidence:** Grep for '_sections|ACCOUNT_SECTIONS|getVisibleAccountSections' across src/ matches only _sections.ts itself and account-sidebar.tsx:16/40; account/page.tsx imports getAccountOverview + PermissionsCard and contains no section-card rendering.

**Suggested fix:** Change to: "Single source of truth for the self-service Account app's navigation. The {@link AccountSidebar} renders from this list, so adding a future personal-data area is a one-entry change: append a descriptor here and add the matching route folder." (drop the claim that the account landing page renders from it, or reword `descriptionKey` as reserved for future use).

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/account/_sections.ts claims both AccountSidebar and the account landing page render from ACCOUNT_SECTIONS. Repo-wide grep shows the only src/ importer is _components/account-sidebar.tsx (lines 16, 40); the only other consumer is tests/unit/account-preferences.test.ts. page.tsx imports only requireSecureSession, getAccountOverview, and PermissionsCard and renders identity/memberships/permissions cards — it never reads the registry (its t("sections.overview.title") heading is a raw i18n key, not a registry read). descriptionKey has no consumer anywhere (the sidebar uses only labelKey and icon). Indirection was checked: layout.tsx mounts AccountSidebar, which is still the sidebar path, not the landing page rendering from the list. Git history (original commit 3faf09f) shows page.tsx never imported _sections, so the comment was inaccurate from inception, not stale drift. No reasonable reading makes the landing-page half true. Severity corrected to P2: it is a misleading doc comment with zero runtime impact — adding a descriptor still yields a working sidebar entry; the maintainer merely finds the landing page unchanged.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:33`

**Comment:** Expose an "Export CSV" button that downloads the current view via `/api/administrator/export/<resource>`. We POST nothing — the export endpoint reads filters from the same query string the grid is using, so we just hit the URL and let the browser save the file.

**Actually:** onExport (lines 87-136) does NOT just hit the URL: it fetch()es the CSV, scans for the `# export_truncated:` sentinel, strips sentinel lines, builds a Blob object-URL and clicks a synthetic anchor, then notifies the admin when truncated. The inline comment at lines 96-98 documents the new approach and contradicts this header.

**Evidence:** data-grid-toolbar.tsx:87-136 (fetch → sentinel check → Blob → programmatic anchor download) vs the header claim; inline comment lines 96-98 explicitly says "rather than a plain anchor click".

**Suggested fix:** Replace the last clause with: "We GET the CSV with the grid's query string, detect the server's `# export_truncated:` sentinel, and save the file via a Blob download so we can warn when the export was capped."

<details><summary>Verifier reasoning</summary>

The header (lines 30-34) claims "we just hit the URL and let the browser save the file," but onExport (lines 87-136) fetch()es the CSV, scans for the `# export_truncated:` sentinel, strips sentinel lines from the content (so the saved file is not the raw server response), builds a Blob object-URL, triggers a synthetic anchor download, and shows a truncation dialog. The inline comment at lines 94-97 explicitly says the fetch is done "rather than a plain anchor click," directly contradicting the header — no reasonable reading reconciles the two. However, the header's contract-level claims (GET with no body, filters via the grid's query string, /api/administrator/export/<resource>) remain correct, and the accurate mechanism description is co-located in the same function, so the practical misleading impact is limited: P2, not P1.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:41`

**Comment:** Stable key — used as the React key and forwarded to `onAction`.

**Actually:** There is no `onAction` anywhere; BulkActionDescriptor has a zero-argument `onSelect` callback and `key` is used only as the React key in the menu-item map.

**Evidence:** data-grid-toolbar.tsx:40-49 (interface: key, label, destructive, onSelect: () => void) and lines 191-199 (key={a.key}, onSelect={action.onSelect} with no key argument).

**Suggested fix:** Replace with: "Stable key — used as the React key."

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:41 says the key is "used as the React key and forwarded to `onAction`". The first half is true (line 193: key={a.key}), but the second half is demonstrably false and no defensible reading exists. (1) In the file itself, "onAction" appears only inside this comment; the BulkActionDescriptor interface (lines 40-49) exposes a zero-argument `onSelect: () => void`, and ActionMenuItem (line 224) wires `onSelect={action.onSelect}` with no arguments — the key is never forwarded to any callback. (2) A repo-wide grep for `onAction` yields only substring false positives inside "AdministratorNavigationAction*" identifiers in administrator-navigation.ts and administrator-top-header.tsx, which are an unrelated nav-action system that doesn't touch BulkActionDescriptor. (3) The sole consumer (src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx, lines 195-261) constructs descriptors whose keys ("approve", "block", "ban", "soft_delete") are used only as React keys; the handlers are self-contained closures. (4) Git history (commit 3c4ff39, the file's origin) shows the interface was born with the zero-arg `onSelect` and this same "forwarded to `onAction`" comment — it was inaccurate from the start, apparently drafted against an API shape that was never implemented. Severity P2 is correct: it's a misleading doc comment on an exported interface field with no runtime impact, but it could mislead a future consumer into expecting the key in a callback.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:55`

**Comment:** TanStack column definitions. `header` may be a translation key.

**Actually:** DataGrid never translates header strings — renderSortableHeader calls flexRender(columnDef.header, ctx) directly, so a translation key passed as a string renders as the literal raw key. Every in-repo caller passes `header: () => t(...)` functions.

**Evidence:** data-grid.tsx:326 (flexRender(columnDef.header, ctx), no t() lookup anywhere in the grid); all grids in the slice pass pre-translated header functions.

**Suggested fix:** Replace with: "TanStack column definitions. `header` must already be translated (callers pass `() => t(key)`)."

<details><summary>Verifier reasoning</summary>

The comment at data-grid.tsx:54 ("`header` may be a translation key") is demonstrably false. The only consumer of `columnDef.header` in the entire grid slice is data-grid.tsx:326, `flexRender(columnDef.header, ctx)`, which renders a string header verbatim — there is no t() lookup applied to header values anywhere (the file's `t` from useTranslations("administrator.grid") is used only for grid chrome: error/retry/loading/empty, pagination labels, and selection-checkbox aria-labels). No indirect translation path exists either: DataGridColumnHeader receives the already-rendered node as children, and the CSV exporter fetches server-generated CSV without touching column defs. Every in-repo caller (users, organizations, roles, groups, permissions, memberships, audit, email outbox, api-keys, enterprise-apps, and all detail-page panels — 100+ column defs) passes `header: () => t(...)` or `() => ""`; none passes a raw key, so the documented usage pattern is both unimplemented and unused. Severity corrected to P2: it is a misleading doc comment that could induce a future caller to render a literal raw key, but the resulting defect is immediately visible in the UI, and no existing code is affected — not a P1.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:58`

**Comment:** Optional initial server-rendered page (saves first round-trip).

**Actually:** useGridFetch fires its fetch unconditionally on mount regardless of initialData (the effect has no knowledge of it); initialData only fills the table and suppresses the skeleton while that first request is in flight — the round-trip still happens. No caller currently passes initialData.

**Evidence:** use-grid-state.ts:199-248 (effect always fetches; no initialData parameter) and data-grid.tsx:110-116 (initialData used only as display fallback and in isInitialLoading).

**Suggested fix:** Replace with: "Optional initial server-rendered page shown while the first fetch is in flight (avoids the loading skeleton; the fetch still runs)."

<details><summary>Verifier reasoning</summary>

The comment claims initialData "saves first round-trip", but useGridFetch (use-grid-state.ts:173-258) has no initialData parameter and its useEffect (lines 199-248) fetches unconditionally on mount — fetchKey is built only from endpoint/state/options/reloadToken, with no guard. In data-grid.tsx, useGridFetch is called at line 108 without initialData; the prop is used only at lines 110-116 as a display fallback and to suppress the initial skeleton (isInitialLoading). The first network round-trip always happens; initialData saves only the visible loading state. A repo-wide grep confirms no caller passes initialData and no wrapper/cache-seeding indirection exists that could make the comment true under any reading. Severity corrected to P2: the statement is objectively false but concerns an unused optional prop, so the harm is developer confusion/wasted effort (e.g., needlessly server-rendering a first page expecting to skip a fetch), not a correctness or security defect.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx:50`

**Comment:** Stable name used for local-storage / a11y (`administrator.users`, etc.).

**Actually:** `name` is emitted only as a `data-grid` attribute on the root div (line 158); nothing in the grid or repo reads it for local-storage, and it is not wired to any aria attribute.

**Evidence:** data-grid.tsx:158 is the sole use; grep for localStorage under the administrator tree returns nothing.

**Suggested fix:** Replace with: "Stable name emitted as the root `data-grid` attribute (test/debug hook), e.g. `administrator.users`."

<details><summary>Verifier reasoning</summary>

props.name is used exactly once in the entire repo: line 158 of data-grid.tsx as `<div data-grid={props.name}>`. No local-storage use exists anywhere in the grid subsystem (repo grep for localStorage/sessionStorage hits only theme and app-shell code; grid state is explicitly URL-backed and name is never passed to useGridState/useGridFetch). No a11y attribute is derived from name — all aria-* attributes in the grid come from sort state, totals, or i18n strings, and nothing (tests, e2e, CSS) even selects on [data-grid=...]. Both concrete uses the comment asserts ("local-storage / a11y") are nonexistent, so the comment demonstrably misstates the code. P2 severity is correct: misleading docblock, no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-selection.ts:7`

**Comment:** (docs/admin-manager.md §7.1, §7.2 — "select all matching")

**Actually:** docs/admin-manager.md has no §7.2 — §7 has only one subsection, §7.1 "Row actions and selection"; "select all matching" is covered under §13 Bulk row actions / §19.

**Evidence:** Heading scan of docs/admin-manager.md: ## 7 (line 294), ### 7.1 (line 325), then ## 8 (line 342) — no 7.2.

**Suggested fix:** Change to "(docs/admin-manager.md §7.1, §13 — 'select all matching')".

<details><summary>Verifier reasoning</summary>

The current docs/admin-manager.md has no §7.2: headings run ## 7 (line 294), ### 7.1 "Row actions and selection" (line 325), then ## 8 (line 342), and a grep for "7.2" in the doc returns nothing. The comment's §7.2 reference is a stale citation from the original spec version (commit a89e66f had §7.1 Capabilities / §7.2 Components) that survived the docs regeneration (704b215). The reviewer's characterization is slightly imprecise — "select-all-matching mode" IS covered directly in the current §7.1 (lines 332-335), which even names use-grid-selection.ts, not only in §13/§19 — but the core claim (no §7.2 exists) is demonstrably true and no reasonable reading rescues the citation. Severity P2 stands: the comment's substantive description of the two modes and ids:"*" contract is accurate; only the dangling sub-section reference is wrong.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/metric-card.tsx:10`

**Comment:** Presentational KPI card for the Administrator overview (docs/admin-manager.md §8.1).

**Actually:** §8.1 of docs/admin-manager.md is "Users", not the overview dashboard.

**Evidence:** docs/admin-manager.md line 351: ### 8.1 Users.

**Suggested fix:** Remove or update the stale §8.1 reference.

<details><summary>Verifier reasoning</summary>

The comment cites docs/admin-manager.md §8.1 as the spec for the Administrator overview dashboard, but in the current doc §8.1 (line 351) is "Users" under "## 8. Administrator areas"; no section of the current admin-manager.md describes the overview dashboard at all. Git history shows the reference was valid when written (commit 622653b, where §8.1 was "Overview (administrator/page.tsx)") but the doc was later renumbered, leaving the citation stale and now pointing at the wrong section. The same stale §8.1 reference also exists in src/lib/admin/overview.server.ts line 8. No reasonable reading of the current code/doc makes the citation correct, so the claim stands; P2 is the right severity for a misleading cross-reference with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/_components/overview-list-card.tsx:17`

**Comment:** Presentational "recent activity" table for the Administrator overview's second tier (docs/admin-manager.md §8.1).

**Actually:** §8.1 of docs/admin-manager.md is "Users", not the overview dashboard.

**Evidence:** docs/admin-manager.md line 351: ### 8.1 Users.

**Suggested fix:** Remove or update the stale §8.1 reference.

<details><summary>Verifier reasoning</summary>

docs/admin-manager.md line 351 is "### 8.1 Users" (endpoint table for user lifecycle), and the current doc contains no section on the Administrator overview dashboard — "second tier"/"recent activity" appear nowhere in it. The comment's citation is stale: an older revision of the doc (pre-704b215 regeneration) had "### 8.1 Overview (administrator/page.tsx)" under "## 8. Page specifications", and the code comments were never updated after renumbering (sibling files show the same drift, e.g. users grid cites §8.2, permissions cite §8.7). The component description itself ("recent activity", "second tier", data in overview.server.ts) is accurate — overview.server.ts line 165 literally says "Recent activity (the dashboard's second tier)" — but the §8.1 pointer demonstrably directs readers to the wrong section in the current doc, so the reviewer's claim stands. P2 is the right severity: a misleading doc reference with no behavioral impact, part of a systemic renumbering drift.

</details>

### `src/app/[locale]/(secure)/app/administrator/api-keys/_api-keys-grid.tsx:26`

**Comment:** Client-side API-key governance grid (docs/admin-manager.md §8.12).

**Actually:** API keys is §8.8 in docs/admin-manager.md; §8.12 is "Email".

**Evidence:** docs/admin-manager.md headings: ### 8.8 API keys (line 457), ### 8.12 Email (line 493).

**Suggested fix:** Change §8.12 to §8.8.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/administrator/api-keys/_api-keys-grid.tsx line 26 cites "docs/admin-manager.md §8.12" for the API-key governance grid. In docs/admin-manager.md, "### 8.8 API keys" (line 457) is the section that matches this grid exactly (admin.apikeys.read/.manage permissions, list filters, rotate/revoke, plaintext-returned-once — all mirrored in the component's own doc text), while "### 8.12 Email" (line 493) covers the email outbox/templates surface. The comment names the specific file, so no other doc could be meant, and the section numbering is contiguous 8.1–8.12 with no ambiguity. The cross-reference is demonstrably wrong; P2 is the right severity for a stale/incorrect doc pointer with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/api-keys/new/_new-api-key-form.tsx:24`

**Comment:** Issue-an-API-key-on-behalf-of-a-user form (docs/admin-manager.md §8.12; docs/form-validation.md).

**Actually:** API keys is §8.8; §8.12 is Email.

**Evidence:** docs/admin-manager.md lines 457 / 493.

**Suggested fix:** Change §8.12 to §8.8.

<details><summary>Verifier reasoning</summary>

The comment cites docs/admin-manager.md §8.12 for the issue-an-API-key-on-behalf-of-a-user form, but §8.12 (docs/admin-manager.md line 493) is "Email" (outbox/templates/test send). The API-keys section is §8.8 (line 457), whose content matches the form exactly ("Issue on behalf of a user; plaintext returned once", owner-authority ungrantableScopes validation). Only one admin-manager.md exists and no other §8.12 heading is present, so no reasonable reading makes the citation correct. P2 is the right severity: a wrong doc cross-reference in a comment, no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/api-keys/new/page.tsx:13`

**Comment:** Server entry for the issue-on-behalf form (docs/admin-manager.md §8.12).

**Actually:** API keys is §8.8; §8.12 is Email.

**Evidence:** docs/admin-manager.md lines 457 / 493.

**Suggested fix:** Change §8.12 to §8.8.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/api-keys/new/page.tsx lines 12-13 cites docs/admin-manager.md §8.12 for the issue-on-behalf API-key form. In docs/admin-manager.md, §8.8 (line 457) is "API keys" and contains the exact feature the page implements — POST /api-keys "Issue on behalf of a user" (line 466) plus the owner-authority scope validation (lines 469-471) that the comment itself paraphrases — while §8.12 (line 493) is "Email" (outbox/templates/test). No alternate section numbering or other reading makes §8.12 correct; the pointer should be §8.8. Comment-only stale reference, no runtime effect, so P2 severity is appropriate.

</details>

### `src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx:14`

**Comment:** Server entry point for the API-key governance console (docs/admin-manager.md §8.12).

**Actually:** API keys is §8.8; §8.12 is Email.

**Evidence:** docs/admin-manager.md lines 457 / 493.

**Suggested fix:** Change §8.12 to §8.8.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx (line 14) cites docs/admin-manager.md §8.12 for the API-key governance console. In docs/admin-manager.md, §8.8 (line 457) is "API keys" — it documents exactly this console (admin.apikeys.read/manage, list/issue/revoke/rotate), matching the page's permission guard — while §8.12 (line 493) is "Email" (outbox and templates, admin.email.*). Sections run 8.1–8.12 with no alternate numbering scheme, so no reasonable reading makes §8.12 refer to API keys. The comment's cross-reference is factually wrong; the rest of the comment (permission gating description) is accurate, so this is a stale/incorrect doc pointer with no behavioral impact — P2 is the correct severity.

</details>

### `src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:61`

**Comment:** Stable grid name for URL/a11y bookkeeping.

**Actually:** Copy of the DataGrid `name` doc drift: the name is forwarded to DataGrid where it only becomes the `data-grid` attribute — it plays no role in URL state (URL state is pathname+search params) or a11y.

**Evidence:** data-grid.tsx:158 (only use of name); use-grid-state.ts keys URL state off pathname/searchParams, never the grid name.

**Suggested fix:** Replace with: "Stable name emitted as the grid's `data-grid` attribute."

<details><summary>Verifier reasoning</summary>

The comment "Stable grid name for URL/a11y bookkeeping" (src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:60-61) misstates what the code does on both counts. The `name` prop is forwarded to DataGrid (line 173), where its ONLY use is `<div data-grid={props.name} ...>` at data-grid.tsx:158 — a plain data attribute. (a) URL: use-grid-state.ts derives all grid state from usePathname()/useSearchParams() and writes via router.replace(pathname + querystring); the grid name is never passed to or used by useGridState/useGridFetch, and query params (page, sort, filter[...], q) are un-namespaced. (b) A11y: no aria-* attribute, id, or accessible name is derived from `name`; data-* attributes are not exposed to accessibility APIs. A repo-wide grep confirms no consumer of the attribute at all — no `[data-grid=` selector in tests/e2e/CSS, and no localStorage/sessionStorage use in the administrator tree (the parent doc at data-grid.tsx:50, "local-storage / a11y", is the same drift this comment was copied from). No reasonable reading makes "URL/a11y bookkeeping" true. P2 is the right severity: misleading doc comment with no runtime impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/_enterprise-apps-grid.tsx:17`

**Comment:** Client-side enterprise applications grid (docs/admin-manager.md §8.10, Phase 6).

**Actually:** Enterprise applications is §8.7 in docs/admin-manager.md; §8.10 is "Audit".

**Evidence:** docs/admin-manager.md headings: ### 8.7 Enterprise applications (line 447), ### 8.10 Audit (line 479).

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

docs/admin-manager.md currently has "### 8.7 Enterprise applications" (line 447) and "### 8.10 Audit" (line 479), so the comment's "§8.10" pointer in _enterprise-apps-grid.tsx line 17 sends readers to the Audit section, not the enterprise-apps catalog. Git history shows why: when the grid file was added (commit 5d4137f), the doc had "### 8.10 Enterprise apps", but a later docs consolidation renumbered sections and the code comments were never updated — the same stale §8.10 reference persists across ~8 enterprise-apps files (lib/admin/enterprise-apps.ts, .server.ts, the API route, and all page/form files). No alternate reading rescues the reference: the comment explicitly names docs/admin-manager.md, of which there is exactly one, and its §8.10 is unambiguously Audit. The comment's description of the code itself is accurate; only the doc cross-reference is wrong, so P2 (stale reference, no functional impact) is the correct severity.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/_enterprise-app-settings-form.tsx:27`

**Comment:** Enterprise application settings form (docs/admin-manager.md §8.10; docs/form-validation.md).

**Actually:** Enterprise applications is §8.7; §8.10 is Audit.

**Evidence:** docs/admin-manager.md lines 447 / 479.

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

docs/admin-manager.md line 447 is "### 8.7 Enterprise applications" (the catalog whose GET/PATCH/DELETE /enterprise-apps/[id] surface this settings form drives), while line 479 is "### 8.10 Audit" (a read-only audit-events endpoint with no relation to app settings). The comment's "§8.10" citation for the enterprise application settings form is therefore demonstrably wrong; the correct reference is §8.7. No alternate reading rescues it — §8.10's content (audit filters, org scoping) has nothing to do with this form. Severity P2 stands: only the cross-reference digit is wrong; the rest of the comment is accurate.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page.tsx:15`

**Comment:** Server entry for the enterprise application detail (docs/admin-manager.md §8.10, Phase 6).

**Actually:** Enterprise applications is §8.7; §8.10 is Audit.

**Evidence:** docs/admin-manager.md lines 447 / 479.

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

Current docs/admin-manager.md has "### 8.7 Enterprise applications" (line 447) and "### 8.10 Audit" (line 479), so the comment's citation of §8.10 for the enterprise application detail page points to the wrong section. Refutation was attempted via git history: at the commit introducing the comment (5d4137f, 2026-05-02), the doc did have "### 8.10 Enterprise apps" and a "Phase 6 — Enterprise apps & audit explorer" section, so the comment was correct when written. However, the doc was renumbered in later rewrites (2026-06-12 refresh, ada39a4 2026-06-22), and "Phase 6" no longer exists in the current doc; against the current tree the citation is demonstrably stale/wrong. Note: the same stale §8.10 citation appears in ~7 sibling files (enterprise-apps.ts, enterprise-apps.server.ts, list/new pages, grid and form components), and the permissions pages' §8.7 citations suffer the same drift (permissions is now §8.5) — a fix should cover the whole family. P2 severity is correct: doc cross-reference drift only, no runtime impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form.tsx:24`

**Comment:** Client-side new enterprise application form (docs/admin-manager.md §8.10; docs/form-validation.md).

**Actually:** Enterprise applications is §8.7; §8.10 is Audit.

**Evidence:** docs/admin-manager.md lines 447 / 479.

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/_new-enterprise-app-form.tsx (line 24) cites docs/admin-manager.md §8.10 for the enterprise application form. In docs/admin-manager.md, §8.7 (line 447) is "Enterprise applications" and §8.10 (line 479) is "Audit". The section reference is demonstrably wrong; no reasonable reading maps §8.10 to enterprise apps. Severity P2 is correct — it is a stale doc pointer in a comment with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page.tsx:12`

**Comment:** Server entry for the create-application form (docs/admin-manager.md §8.10, Phase 6).

**Actually:** Enterprise applications is §8.7; §8.10 is Audit.

**Evidence:** docs/admin-manager.md lines 447 / 479.

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page.tsx:11-12 cites "docs/admin-manager.md §8.10" for the create-application form, but in the current docs/admin-manager.md, §8.7 (line 447) is "Enterprise applications" and §8.10 (line 479) is "Audit" — exactly as the reviewer states. I attempted to refute via doc history: at older commits (e.g. 93739c7, e0f13d3) the doc did have "§8.10 Enterprise apps" and "§8.7 Permissions", which explains the comment's origin — the doc was renumbered during the documentation regeneration/consolidation (704b215/ada39a4) and this cross-reference was never updated. That is an explanation, not a defense: under the current repo state the pointer demonstrably sends a reader to the Audit section, and no reasonable reading of the present docs makes §8.10 mean enterprise applications. Note the same stale §8.10 reference also exists in sibling files (src/lib/admin/enterprise-apps.server.ts:5, _enterprise-apps-grid.tsx:17, [appId]/_enterprise-app-settings-form.tsx:27, new/_new-enterprise-app-form.tsx:24), and conversely the permissions pages cite §8.7 (old numbering; current permissions section is §8.5) — a systematic renumbering drift. Severity P2 is appropriate: it is a documentation cross-reference error with no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/enterprise-apps/page.tsx:14`

**Comment:** Server entry point for the enterprise applications list (docs/admin-manager.md §8.10, Phase 6).

**Actually:** Enterprise applications is §8.7; §8.10 is Audit.

**Evidence:** docs/admin-manager.md lines 447 / 479.

**Suggested fix:** Change §8.10 to §8.7.

<details><summary>Verifier reasoning</summary>

The comment cites "docs/admin-manager.md §8.10, Phase 6" for the enterprise applications list, but in the current docs/admin-manager.md, §8.7 (line 447) is "Enterprise applications" and §8.10 (line 479) is "Audit" — matching the reviewer's evidence exactly. Refutation attempt via git history shows the reference was accurate only against an old, superseded version of the doc (a89e66f had "### 8.10 Enterprise apps" with phases; the doc was regenerated in 704b215/ada39a4 and renumbered). A stale cross-reference that points readers to the wrong section today demonstrably misstates the doc mapping, so the claim stands. The same stale reference also appears in ~9 other enterprise-apps files. P2 severity is correct: comment/doc-pointer error with no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid.tsx:99`

**Comment:** // The endpoint silently drops a user who isn't an ACTIVE member of the // group's org (returns `added: 0`); surface that rather than a false ok.

**Actually:** When none of the submitted users are eligible (which is always the case for this grid's single-id add of an ineligible user), the endpoint returns 404 `user_not_found`, not 200 with `added: 0`. So res.ok is false, the generic addError branch runs, and the `(body.added ?? 0) === 0` / notEligible branch is unreachable — `added: 0` is never returned (a 2xx response always has added >= 1).

**Evidence:** src/app/api/administrator/groups/[id]/members/route.ts:154-157 (`if (eligibleIds.length === 0) return adminErrorResponse("user_not_found", 404, ...)`) and :172 (`added: eligibleIds.length` only after at least one eligible id).

**Suggested fix:** Replace with: 'An ineligible pick (not an ACTIVE member of the group's org) makes the endpoint return 404 user_not_found; surface that as notEligible when the response is 404.' (and map the 404 instead of the dead added===0 check), or delete the comment and the dead branch.

<details><summary>Verifier reasoning</summary>

The comment claims the endpoint returns a 200 with `added: 0` when the picked user isn't an ACTIVE member of the group's org. The route (src/app/api/administrator/groups/[id]/members/route.ts:155-157) returns adminErrorResponse("user_not_found", 404) when eligibleIds.length === 0, and the success response (line 172, `added: eligibleIds.length`) is only reached with eligibleIds.length >= 1 — so a 2xx never carries added: 0 for any input. adminErrorResponse (src/lib/admin/errors.server.ts) always uses the passed 4xx status; no proxy/middleware indirection rewrites it. The grid sends a single id, so an ineligible pick yields 404 → res.ok false → the generic addError branch; the `(body.added ?? 0) === 0` / notEligible branch at lines 101-105 is unreachable. Git history shows the 404 branch existed from the route's original commit (a7e0f11), so the comment was never accurate. Severity corrected to P2: the impact is a misleading comment plus dead code and a less-specific (but still present) error message — no security or data-integrity consequence.

</details>

### `src/app/[locale]/(secure)/app/administrator/layout.tsx:23`

**Comment:** Per-page guards (Phase 2+) call the more specific `requireAdminPermission(<exact perm>)` to enforce the read needed by that page.

**Actually:** Every administrator page calls `checkAdminPermissionServer(<exact perm>)` (the RSC variant); `requireAdminPermission` takes a NextRequest and is used only by API route handlers — it cannot be called from a page as described.

**Evidence:** All page.tsx files in the slice import checkAdminPermissionServer; src/lib/admin/permissions.server.ts:82 (requireAdminPermission(request, …)) vs :169 (checkAdminPermissionServer, documented as the "Server-component variant").

**Suggested fix:** Replace `requireAdminPermission(<exact perm>)` with `checkAdminPermissionServer(<exact perm>)`.

<details><summary>Verifier reasoning</summary>

The comment names `requireAdminPermission(<exact perm>)` as the per-page guard, but zero page.tsx files in src/app/[locale]/(secure)/app/administrator call it — all ~24 pages (users, roles, audit, orgs, groups, email, api-keys, enterprise-apps, memberships, etc.) call `checkAdminPermissionServer(<exact perm>)`. The named function cannot fill the described role: requireAdminPermission (src/lib/admin/permissions.server.ts:82) requires a request/headers first argument (the comment's single-arg call shape is not a valid invocation) and returns a NextResponse-bearing denial usable only by route handlers, while checkAdminPermissionServer (:169) is the documented "Server-component variant" returning the grant/"denied"/"unauthenticated" sentinel that pages use with notFound(). The layout itself calls checkAdminPermissionServer three lines below the comment. No reasonable reading rescues the comment: Phase 2+ has landed, the identifier is exact and backticked, and grepping for it in pages finds nothing. Severity P2 stands — documentation-only drift, no runtime effect, but it misdirects maintainers to the wrong guard API for pages.

</details>

### `src/app/[locale]/(secure)/app/administrator/memberships/_memberships-grid.tsx:15`

**Comment:** Client-side memberships grid (docs/admin-manager.md §19).

**Actually:** Memberships is §8.3 in docs/admin-manager.md; §19 is "Phase 7 — impersonation, bulk actions, CSV export" (unrelated to the memberships grid).

**Evidence:** docs/admin-manager.md headings: ### 8.3 Memberships (line 400), ## 19 Phase 7 (line 597).

**Suggested fix:** Change §19 to §8.3.

<details><summary>Verifier reasoning</summary>

The reviewer is correct against the current tree. docs/admin-manager.md line 400 is "### 8.3 Memberships" and describes exactly what this grid fronts (read-only cross-org search of app_organization_memberships joined to users and organizations via GET /api/administrator/memberships — the grid's endpoint at line 110 of _memberships-grid.tsx). Line 597 is "## 19. Phase 7 — impersonation, bulk actions, CSV export", none of which this component implements (it passes only `searchable` and a status filter to DataGrid; bulk/export live in data-grid-toolbar.tsx, which cites §19 correctly). Attempted refutation via history: the comment was written in commit 31b637a ("feat: implement Phase 5 organizations & memberships admin management") when the doc's §19 was "Phased delivery" with "Phase 5 — Organizations & memberships" — so the citation was defensible when written, but the doc was regenerated and renumbered (704b215) and the reference is now stale; under the current doc §19 is demonstrably unrelated and no reasonable reading of today's doc supports it. Severity P2 is appropriate: a stale doc cross-reference in a comment, no functional impact. Note the drift is systemic (organizations/* files, roles §8.5→now §8.4, permissions §8.7→§8.5, api-keys §8.12→§8.8, users §8.2→§8.1, enterprise-apps §8.10→§8.7), so a sweep fix is warranted rather than a one-line patch; a background task chip was spawned for that.

</details>

### `src/app/[locale]/(secure)/app/administrator/memberships/page.tsx:11`

**Comment:** Server entry point for the cross-org memberships search (docs/admin-manager.md §19).

**Actually:** Memberships is §8.3; §19 is Phase 7 (impersonation / bulk actions / CSV export).

**Evidence:** docs/admin-manager.md lines 400 / 597.

**Suggested fix:** Change §19 to §8.3.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/memberships/page.tsx line 11 cites docs/admin-manager.md §19 for the cross-org memberships search, but in the current doc §19 (line 597) is "Phase 7 — impersonation, bulk actions, CSV export" while the memberships search is §8.3 "Memberships" (line 400), which describes exactly this page's behavior (read-only cross-org search via GET /api/administrator/memberships). Refutation attempts failed: current §19 contains no memberships-search content (only 'memberships' as a CSV-export resource, which the page does not use); there is no second §19 in the doc; and while git history shows the reference was once correct (original §19 was "Phased delivery" with Phase 5 = Organizations & memberships, explaining the same stale §19 in ~10 sibling files), the doc was restructured and the comment now points a reader to the wrong section. P2 severity is appropriate: a stale doc cross-reference with no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page.tsx:46`

**Comment:** Tabs (rendered client-side): - Members — paginated grid of memberships - Providers — paginated grid of provider bindings - Settings — name/slug/status editor

**Actually:** OrganizationDetailTabs renders four tabs: Members (which also hosts the Invitations panel), Providers, Authentication (AuthPolicyForm), and Settings. The Authentication tab is missing from the enumeration even though this same file loads its initial rows (lines 86-92).

**Evidence:** _organization-detail-tabs.tsx:43-46 (four TabsTriggers incl. "authentication") and :52 (OrganizationInvitationsPanel inside Members).

**Suggested fix:** Add '- Authentication — per-org sign-up policy editor (0007)' to the tab list (and optionally note the invitations panel under Members).

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page.tsx lines 46-49 enumerates three tabs (Members, Providers, Settings), but _organization-detail-tabs.tsx lines 43-46 unconditionally render four TabsTriggers including "authentication" (AuthPolicyForm at lines 60-71), and the Members tab additionally hosts OrganizationInvitationsPanel (line 52). The staleness is internally inconsistent within the same file: lines 86-92 of page.tsx load the Authentication tab's initial rows ("Initial rows for the Authentication tab (0007)...") and pass them to OrganizationDetailTabs. No conditional rendering, flag, or indirection could make the three-tab enumeration accurate. The reviewer's claim is exactly right. P2 severity is correct — misleading documentation with no runtime impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/organizations/page.tsx:21`

**Comment:** Server entry point for the organizations list (docs/admin-manager.md §19).

**Actually:** §19 is now 'Phase 7 — impersonation, bulk actions, CSV export'; the Organizations area is §8.2. Old doc §19 was 'Phased delivery' (which contained the organizations phase). The same stale §19 reference appears in _organizations-grid.tsx:18, organizations/new/page.tsx:11, new/_new-organization-form.tsx:25, [orgId]/page.tsx:40, [orgId]/_organization-detail-tabs.tsx:12, [orgId]/_organization-members-grid.tsx:13, [orgId]/_organization-providers-grid.tsx:11, and [orgId]/_organization-settings-form.tsx:32.

**Evidence:** docs/admin-manager.md: '### 8.2 Organizations' and '## 19. Phase 7 — impersonation, bulk actions, CSV export' vs pre-704b215 '## 19. Phased delivery'.

**Suggested fix:** Change all nine references to §8.2.

<details><summary>Verifier reasoning</summary>

The comment cites docs/admin-manager.md §19 for the organizations list, but current §19 (line 597) is "Phase 7 — impersonation, bulk actions, CSV export"; the organizations area is documented at §8.2 (line 373). Pre-704b215, §19 was "Phased delivery (single final PR)" (verified via git show 704b215^:docs/admin-manager.md, line 961), which contained the phased org work — commit 704b215 regenerated/renumbered the doc and orphaned the reference. The identical stale "§19" reference was confirmed by grep in all eight sibling files the reviewer listed. No reading makes the current reference correct, so the claim stands. P2 severity is appropriate (stale comment cross-reference, no functional impact).

</details>

### `src/app/[locale]/(secure)/app/administrator/page.tsx:23`

**Comment:** Administrator overview dashboard (docs/admin-manager.md §8.1).

**Actually:** docs/admin-manager.md §8.1 is "Users"; the doc's §8 area list has no overview-dashboard subsection (workspace chrome is §2.1). The §8.x numbering was reshuffled after these comments were written.

**Evidence:** docs/admin-manager.md headings: ### 8.1 Users (line 351).

**Suggested fix:** Drop the stale section number (e.g. "Administrator overview dashboard (docs/admin-manager.md §2.1 workspace / §8 areas)") or repoint to the current section.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/page.tsx:23 cites docs/admin-manager.md §8.1 as the spec for the administrator overview dashboard, but the current doc's §8.1 (line 351) is "Users" — the user-lifecycle API area. No section of the current doc describes the overview dashboard (no matches for overview/dashboard/metric beyond the generic "## 1. Overview" heading); workspace chrome is §2.1. Git history confirms the reviewer's reshuffle theory: the comment was added in commit 622653b when the doc had "### 8.1 Overview (administrator/page.tsx)", and later doc rewrites (704b215, ada39a4) renumbered §8 into "Administrator areas" with §8.1 = Users, leaving the comment's cross-reference stale. No reasonable reading of the current doc makes the citation correct, so the claim stands. P2 is the right severity — a misleading but behavior-neutral doc pointer.

</details>

### `src/app/[locale]/(secure)/app/administrator/permissions/_permissions-grid.tsx:15`

**Comment:** Permissions catalog grid (docs/admin-manager.md §8.7).

**Actually:** Permissions is §8.5 in docs/admin-manager.md; §8.7 is "Enterprise applications".

**Evidence:** docs/admin-manager.md headings: ### 8.5 Permissions (line 421), ### 8.7 Enterprise applications (line 447).

**Suggested fix:** Change §8.7 to §8.5.

<details><summary>Verifier reasoning</summary>

The comment at line 15 of C:\my\repos\devresponsekit\src\app\[locale]\(secure)\app\administrator\permissions\_permissions-grid.tsx reads "Permissions catalog grid (docs/admin-manager.md §8.7)." In the current docs/admin-manager.md, the numbered headings under "## 8. Administrator areas" are: 8.4 Roles (line 407), 8.5 Permissions (line 421), 8.6 Groups (line 432), 8.7 Enterprise applications (line 447). Section 8.5 is unambiguously the one describing this grid — it covers the permission catalog (app_permissions), usage counts ("List with usage counts"), and the manage/delete-blocked semantics that match the grid's "Used by N roles" behavior. §8.7 is the SSO enterprise-application catalog, unrelated to permissions. There is no alternate heading scheme, no second admin-manager.md, and no reading under which "§8.7" is a correct pointer, so the comment demonstrably misstates the cross-reference. Severity P2 is appropriate: it is a stale documentation pointer in a doc-comment with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet.tsx:11`

**Comment:** "Roles using this permission" panel rendered inside the catalog Sheet (docs/admin-manager.md §8.7).

**Actually:** Permissions is §8.5; §8.7 is Enterprise applications.

**Evidence:** docs/admin-manager.md lines 421 / 447.

**Suggested fix:** Change §8.7 to §8.5.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/administrator/permissions/_roles-using-sheet.tsx (lines 9-11) cites "docs/admin-manager.md §8.7" for the permissions-catalog Sheet. In the current docs/admin-manager.md, "### 8.5 Permissions" is at line 421 and "### 8.7 Enterprise applications" is at line 447 — exactly as the reviewer stated. There is only one admin-manager.md in the repo, and §8.7 (the SSO application catalog, app_enterprise_applications) has nothing to do with the permissions catalog or the roles-using-permission panel. Sibling files in the same permissions/ directory (_permissions-grid.tsx, page.tsx, new/page.tsx) carry the same stale §8.7 reference, indicating the doc was renumbered after the code was written, but that doesn't make the current reference defensible — the comment demonstrably points to the wrong section. Severity P2 is correct: it's a stale documentation cross-reference with no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/permissions/new/page.tsx:9`

**Comment:** Administrator → New permission page (docs/admin-manager.md §8.7).

**Actually:** Permissions is §8.5; §8.7 is Enterprise applications.

**Evidence:** docs/admin-manager.md lines 421 / 447.

**Suggested fix:** Change §8.7 to §8.5.

<details><summary>Verifier reasoning</summary>

The comment at line 9 of src/app/[locale]/(secure)/app/administrator/permissions/new/page.tsx cites "docs/admin-manager.md §8.7" for the New permission page. In docs/admin-manager.md, §8.5 (line 421, "### 8.5 Permissions") is the section covering the permission catalog and POST /permissions guarded by admin.permissions.manage — exactly what this page does (it gates on admin.permissions.manage and its form POSTs to /api/administrator/permissions). §8.7 (line 447) is "Enterprise applications" (the app_enterprise_applications SSO catalog), unrelated to permissions. There is only one §8.7 in the doc and no alternate reading under which the citation is correct, so the comment demonstrably misstates the doc reference. Severity P2 is appropriate: it is a stale/incorrect doc pointer in a code comment with no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/permissions/page.tsx:13`

**Comment:** Permission-catalog management view (docs/admin-manager.md §8.7).

**Actually:** Permissions is §8.5; §8.7 is Enterprise applications.

**Evidence:** docs/admin-manager.md lines 421 / 447.

**Suggested fix:** Change §8.7 to §8.5.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/permissions/page.tsx:13 cites docs/admin-manager.md §8.7 for the permission-catalog view, but §8.7 (docs/admin-manager.md line 447) is "Enterprise applications" (app_enterprise_applications, admin.apps.* permissions). The permission catalog is §8.5 (line 421), which explicitly covers app_permissions with GET gated on admin.roles.read and mutations on admin.permissions.manage — exactly the gating the page implements (guard on admin.roles.read at line 24, canManage on admin.permissions.manage at line 28). No alternate reading makes §8.7 correct; the cross-reference is demonstrably wrong. P2 is the right severity: it is a stale doc pointer with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/roles/[roleId]/page.tsx:15`

**Comment:** Server entry for the role detail (docs/admin-manager.md §8.6).

**Actually:** §8.6 is now 'Groups'; the role detail surface (permissions editor, members, settings) is documented under §8.4 Roles. Old doc had §8.6 'Role detail'. Same stale §8.6 reference in _role-detail-tabs.tsx:10 ('plan §8.6'), _role-permissions-editor.tsx:12, _role-members-grid.tsx:10 ('plan §8.6 — Members'), and _role-settings-form.tsx:21.

**Evidence:** docs/admin-manager.md: '### 8.6 Groups' vs pre-704b215 '### 8.6 Role detail (administrator/roles/[roleId])'.

**Suggested fix:** Change all five references to §8.4.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/roles/[roleId]/page.tsx:15 cites "docs/admin-manager.md §8.6" for the role detail surface, but the current docs/admin-manager.md §8.6 is "Groups" (org-scoped cohorts bundling roles). The role detail endpoints (GET/PATCH/DELETE /roles/[id], /permissions dual-list editor, /members) are documented under §8.4 Roles. Git history confirms the reviewer's evidence: at 704b215~1 the doc had "### 8.6 Role detail (administrator/roles/[roleId])", and commit 704b215 (docs regeneration) renumbered the sections. The same stale §8.6 reference exists in the four sibling files listed (_role-detail-tabs.tsx:10, _role-permissions-editor.tsx:12, _role-members-grid.tsx:10, _role-settings-form.tsx:21). Because the flagged comment names the doc file explicitly, no alternative reading (e.g., an internal plan document) is defensible. P2 severity is correct for a stale doc cross-reference with no functional impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/roles/page.tsx:13`

**Comment:** Server entry point for the roles list (docs/admin-manager.md §8.5).

**Actually:** §8.5 is now 'Permissions'; the Roles area is §8.4. Old doc had §8.5 'Roles'. Same stale §8.5 reference in _roles-grid.tsx:18, roles/new/page.tsx:12, and roles/new/_new-role-form.tsx:21 ('plan §8.5').

**Evidence:** docs/admin-manager.md: '### 8.4 Roles', '### 8.5 Permissions' vs pre-704b215 '### 8.5 Roles (administrator/roles/page.tsx)'.

**Suggested fix:** Change all four references to §8.4.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/roles/page.tsx:13 cites "docs/admin-manager.md §8.5" for the roles list, but the current docs/admin-manager.md has "### 8.4 Roles" (line 407) and "### 8.5 Permissions" (line 421, the platform-global permission catalog / /permissions endpoints). §8.5 cannot reasonably be read as describing the roles list. Git history confirms the drift: before commit 704b215 (docs regeneration) the doc had "### 8.5 Roles (administrator/roles/page.tsx)", so the reference was correct against the old numbering and is now stale. The reviewer's cross-references also verify: the same stale "docs/admin-manager.md §8.5" appears in _roles-grid.tsx:18 and roles/new/page.tsx:12 (the _new-role-form.tsx:21 instance says "plan §8.5", citing a plan rather than the doc). P2 severity is appropriate for a misleading but non-behavioral doc-pointer in a comment.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:26`

**Comment:** Client-side users grid for the Administrator workspace (docs/admin-manager.md §8.2).

**Actually:** docs/admin-manager.md was regenerated (commit 704b215) and renumbered: §8.2 is now 'Organizations'; the Users area is §8.1. The reference points at the wrong section (old doc had §8.2 Users).

**Evidence:** docs/admin-manager.md current headings: '### 8.1 Users', '### 8.2 Organizations'; pre-704b215 version had '### 8.2 Users (administrator/users/page.tsx)'.

**Suggested fix:** Change to 'docs/admin-manager.md §8.1'.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx (lines 24-25) cites "docs/admin-manager.md §8.2" for the users grid. In the current docs/admin-manager.md, §8.1 is "Users" (line 351) and §8.2 is "Organizations" (line 373). Commit 704b215 regenerated the docs; the pre-704b215 file had "### 8.2 Users (administrator/users/page.tsx)", which is what the comment originally referenced. No defensible reading survives: the comment names an exact path and section number, and that section is now Organizations. The correct reference is §8.1. P2 is the right severity — a stale section pointer in a doc comment, otherwise accurate.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-memberships-panel.tsx:13`

**Comment:** Memberships tab for the user detail (docs/admin-manager.md §19).

**Actually:** §19 is now 'Phase 7 — impersonation, bulk actions, CSV export' and says nothing about the memberships tab; user memberships are covered under §8.1 (User-detail tabs) / §8.3 (Memberships). Old doc §19 was 'Phased delivery'.

**Evidence:** docs/admin-manager.md: '## 19. Phase 7 — impersonation, bulk actions, CSV export' vs pre-704b215 '## 19. Phased delivery (single final PR)'.

**Suggested fix:** Change to §8.1/§8.3.

<details><summary>Verifier reasoning</summary>

The comment at line 13 of _user-memberships-panel.tsx cites docs/admin-manager.md §19 for the user-detail memberships tab, but current §19 (line 597) is "Phase 7 — impersonation, bulk actions, CSV export" and contains nothing about the user-detail memberships tab (its only "memberships" mention is as a CSV export resource). The tab is actually documented in §8.1 (user-detail tabs row for …/[id]/memberships) and §8.3 (Memberships). Git history confirms the reviewer's evidence: pre-704b215 §19 was "Phased delivery (single final PR)", whose Phase 3 listed the user-detail memberships tab, so the reference went stale when commit 704b215 regenerated and renumbered the doc. No reasonable reading of the current doc makes the §19 reference correct. P2 severity is appropriate for a stale, misdirecting doc pointer with no functional impact (the same stale §19 pattern also exists in ~15 sibling admin files).

</details>

### `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:24`

**Comment:** 3. Renders the static metadata header + a client `UserDetailTabs` component that owns the interactive tabs (Overview, Roles, Memberships, Sessions, and — for callers holding `admin.audit.read` — Audit, ...).

**Actually:** UserDetailTabs also renders a Groups tab (always visible; management gated by admin.groups.assign via canManageGroups) between Roles and Memberships. The enumeration is missing it.

**Evidence:** _user-detail-tabs.tsx:73 (<TabsTrigger value="groups">) and :114-116 (UserGroupsPanel); this page itself computes canManageGroups (line 76) and passes it down.

**Suggested fix:** Update the enumeration to '(Overview, Roles, Groups, Memberships, Sessions, and — for callers holding `admin.audit.read` — Audit, ...)'.

<details><summary>Verifier reasoning</summary>

The comment's tab enumeration (Overview, Roles, Memberships, Sessions, + gated Audit) omits the Groups tab, which _user-detail-tabs.tsx renders unconditionally at line 73 (<TabsTrigger value="groups">) between Roles and Memberships, with its panel (UserGroupsPanel, line 115) receiving canManage={canManageGroups}. page.tsx itself computes canManageGroups from admin.groups.assign (line 76) and passes it to UserDetailTabs (line 122), so the omitted tab is handled in the very file bearing the comment. The enumeration reads as exhaustive — it even calls out the one permission-gated tab (Audit) explicitly — so omitting an always-visible tab is a factual misstatement, not an acceptable abbreviation. No alternate reading or indirection rescues it; the import resolves to the single _user-detail-tabs definition. Severity P2 is correct: doc-only inaccuracy, no behavioral impact.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:14`

**Comment:** Administrator → User detail page (docs/admin-manager.md §8.4).

**Actually:** §8.4 is now 'Roles'; the user detail surface is documented under §8.1 Users ('User-detail tabs' row). Old doc had §8.4 'User detail'. The same stale §8.4 reference appears in _user-detail-tabs.tsx:14 ('plan §8.4'), _user-audit-panel.tsx:6, _user-sessions-panel.tsx:9 ('plan §8.4 — Sessions'), _user-roles-panel.tsx:21, and _user-groups-panel.tsx:19.

**Evidence:** docs/admin-manager.md: '### 8.4 Roles' vs pre-704b215 '### 8.4 User detail (administrator/users/[userId])'.

**Suggested fix:** Change all six references to §8.1 (User-detail tabs).

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:14 cites "docs/admin-manager.md §8.4" for the user detail page. In the current docs/admin-manager.md, §8.4 is "Roles" (line 407); the user-detail surface is covered under §8.1 Users (line 351, "User-detail tabs" row at line 366). Verified via git that before commit 704b215 the doc had "### 8.4 User detail (administrator/users/[userId])", so the reference is stale, exactly as the reviewer claims. No alternative reading rescues the comment: it names a specific file and section number that now points to an unrelated area. The rest of the comment (permissions, 404 semantics, tabs) is accurate, so this is a pure cross-reference drift — P2 severity is appropriate.

</details>

### `src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:9`

**Comment:** Administrator → New user page (docs/admin-manager.md §8.3).

**Actually:** §8.3 is now 'Memberships'; user creation is documented under §8.1 Users (POST /users). Old doc had §8.3 'New user'. Same stale reference in users/new/_new-user-form.tsx line 21 ('plan §8.3').

**Evidence:** docs/admin-manager.md: '### 8.3 Memberships' vs pre-704b215 '### 8.3 New user (administrator/users/new/page.tsx)'.

**Suggested fix:** Change both references to §8.1.

<details><summary>Verifier reasoning</summary>

The comment at src/app/[locale]/(secure)/app/administrator/users/new/page.tsx line 9 cites "docs/admin-manager.md §8.3", but the current docs/admin-manager.md §8.3 is "Memberships" (a read-only cross-org membership search API). User creation for this page is documented under §8.1 Users (POST /users with admin.users.create). Verified via git that the pre-704b215 version of the doc contained "### 8.3 New user (administrator/users/new/page.tsx)" at line 629, which commit 704b215 (docs regeneration) removed/renumbered. The comment's explicit file+section citation is therefore demonstrably stale and points to the wrong section; the same stale "§8.3" also appears in _new-user-form.tsx line 21. No alternative reading makes the reference correct. P2 severity is appropriate (comment-only doc drift, no functional impact).

</details>

### `src/app/[locale]/(secure)/app/error.tsx:11`

**Comment:** This is the concrete realization of the "AdministratorErrorBoundary" referenced in docs/admin-manager.md §12 (broadened to cover every secure workspace, not just the administrator app).

**Actually:** docs/admin-manager.md §12 is titled "12. Audit model" and says nothing about an error boundary; the string "AdministratorErrorBoundary" appears nowhere in docs/admin-manager.md nor anywhere else in the repo except this comment. The doc's section numbering has been reworked (sections jump 13 → 19 → 20), so the §12 anchor no longer points at any error-boundary content.

**Evidence:** grep -rin 'AdministratorErrorBoundary' over the repo matches only src/app/[locale]/(secure)/app/error.tsx:11; grep of docs/admin-manager.md section headers shows '## 12. Audit model' and zero hits for 'ErrorBoundary'/'error boundary'.

**Suggested fix:** Delete the second paragraph of the comment (the docs/admin-manager.md §12 / AdministratorErrorBoundary sentence), or repoint it at a doc section that actually describes the error boundary if one exists.

<details><summary>Verifier reasoning</summary>

The comment in src/app/[locale]/(secure)/app/error.tsx (lines 11-13) claims the file realizes the "AdministratorErrorBoundary" referenced in docs/admin-manager.md §12. Today that is false: §12 of docs/admin-manager.md is "## 12. Audit model" and contains only audit-schema content; the string "AdministratorErrorBoundary" appears nowhere in the repo except this comment, and no doc mentions any error boundary (grep for boundary/ErrorBoundary/error.tsx across docs/ confirms). The reviewer's evidence, including the reworked section numbering (12 → 13 → 19 → 20 with a stray nested "### 17"), is accurate. Adversarial check via git history shows the comment WAS true when written: commit 1ec283c edited the then-current doc, whose "## 12. Audit & observability" section contained the "<AdministratorErrorBoundary/>" bullet, and rewrote that bullet to point at this new file. But the spec was later rewritten and the error-boundary bullet and the term were removed entirely, so the comment's present-tense pointer to §12 now resolves to unrelated content and the referenced name no longer exists in the doc. No reasonable current reading rescues it — it is a stale, misleading cross-reference. Severity P2 is appropriate: the rest of the comment accurately describes the code's behavior (subtree boundary, Sentry capture with Support ID via RouteError), so the defect is documentation-pointer rot only.

</details>

### `src/app/api/administrator/users/[id]/ban/route.ts:25`

**Comment:** The new password / token is never logged.

**Actually:** The ban flow has no new password or token anywhere: the handler forwards only userId/banReason/banExpiresIn to `banBetterAuthUser` and audits reason + expiresInSeconds. The sentence is copy-pasted from the sibling password endpoint (users/[id]/password/route.ts lines 30-31, where it is accurate).

**Evidence:** Same file lines 79-107: `banBetterAuthUser({ userId, banReason, banExpiresIn })` and audit metadata `{ expiresInSeconds }` — no password/token exists in the flow; sibling src/app/api/administrator/users/[id]/password/route.ts carries the original sentence.

**Suggested fix:** delete comment (the sentence 'The new password / token is never logged.')

<details><summary>Verifier reasoning</summary>

The comment at src/app/api/administrator/users/[id]/ban/route.ts lines 25-26 ("The new password / token is never logged.") references an entity that does not exist anywhere in the ban flow. The zod schema accepts only { reason, expiresInSeconds }; the handler forwards { userId, banReason, banExpiresIn } to banBetterAuthUser, which calls auth.api.banUser with exactly those fields (src/lib/admin/auth-admin.server.ts:130-142); audit rows record reason and { expiresInSeconds }; the response is { ok: true }. No password or token is created, handled, or reachable in this code path (Better Auth banUser revokes sessions but mints nothing new), so there is no reasonable reading under which the sentence describes this route. The sibling src/app/api/administrator/users/[id]/password/route.ts lines 30-31 carries the accurate original ("The new password is forwarded to Better Auth and never logged or echoed..."), confirming the ban-route sentence is a copy-paste remnant. P2 severity is appropriate: misleading doc comment, no functional or security impact.

</details>

### `src/app/api/administrator/users/bulk/route.ts:290`

**Comment:** Touch the parsed action once so the audit row records the original batch surface. Per-row events written by the helpers cover detail.

**Actually:** The code below the comment is a plain `NextResponse.json` return; it has no effect on any audit row — the summary audit row was already written above (lines 272-288) using its own metadata. Nothing in the return 'touches' anything for auditing purposes.

**Evidence:** Lines 272-288 write the summary `admin.users.bulk_action` audit row before this comment; lines 292-299 only build the JSON response from already-computed values.

**Suggested fix:** delete comment

<details><summary>Verifier reasoning</summary>

The comment at lines 290-291 annotates the final `return NextResponse.json(...)` (lines 292-299), which only builds the HTTP response from already-computed locals (action, results.length, succeeded, failed, results) and has no side effects. The summary "admin.users.bulk_action" audit row is written and awaited earlier, at lines 272-288, and it records `action` in its own metadata (line 281) independently of the return. I verified auditUserAction in src/lib/admin/audit-helpers.server.ts (lines 31-47): it writes the audit event immediately via auditEvent, with no deferred or response-coupled behavior. There is no mechanism by which 'touching' the `action` variable in the response affects any audit row, and no alternate reading rescues the comment — the audit block above already has its own accurate comment (lines 269-271), and 'touch the parsed action once so the audit row records the original batch surface' describes neither statement. The comment demonstrably misstates what the annotated code does. Severity P2 is appropriate: it is a misleading comment with no runtime, security, or correctness impact.

</details>

### `src/components/admin/impersonation-banner.tsx:10`

**Comment:** "Server component: reads the active session and the original actor's email (best effort) so the banner shows 'you are impersonating target@x.com'"

**Actually:** The component never resolves the ORIGINAL actor's (admin's) email. It queries app_users by the live session's user id, which during impersonation is the impersonated TARGET, and shows the target's primary_email in the banner. "Original actor" consistently means the admin (impersonatedBy) elsewhere in this codebase (e.g. the impersonate route docs).

**Evidence:** Lines 31-36 of the same file: `targetBetterAuthId = session.user.id` then `.where("better_auth_user_id", "=", targetBetterAuthId)`; line 45 renders `targetRow?.primary_email` as the impersonated address. `impersonatedBy` (the original actor id, line 28) is only used as a boolean gate.

**Suggested fix:** Change to: "reads the active session and the impersonated target's email (best effort) so the banner shows 'you are impersonating target@x.com'"

<details><summary>Verifier reasoning</summary>

The comment claims the component reads "the original actor's email (best effort)". The code (lines 28-45) uses impersonatedBy (the original actor id) only as a boolean gate, then queries app_users by session.user.id — which during impersonation is the impersonated TARGET per better-auth semantics — and renders targetRow?.primary_email (the target's email). "Original actor" is not defensible as meaning the target: the codebase uses the term consistently for the admin who started impersonation (docs/admin-manager.md §17 "restores the original actor's cookies"/"audits with the original actor", src/app/api/administrator/users/[id]/impersonate/route.ts lines 121/160/180, src/lib/admin/auth-admin.server.ts line 191 "remembering the original actor in session.impersonatedBy", tests/integration/administrator-phase7.test.ts line 290 where the original actor ACTOR_ID is explicitly distinct from user.id="ba-target"). The comment is also internally inconsistent — the original actor's email could not produce the banner text "you are impersonating target@x.com". Severity downgraded to P2: the same sentence's concrete example accurately states the visible behavior and the sibling client component correctly documents the row as the target's, so the misstatement is a terminology error with low practical misleading power, not a P1.

</details>

### `src/components/ui/card.tsx:5`

**Comment:** Card primitive (shadcn-style). Public/auth pages use this for sign-in, sign-up, pending-approval, blocked, and logged-out screens.

**Actually:** Sign-in, sign-up, pending-approval, and blocked screens do use Card, but the logged-out screen does not: src/app/[locale]/(public)/logged-out/page.tsx renders LoggedOutPanel, which is built on Alert/AlertTitle/AlertDescription and contains no Card import.

**Evidence:** src/components/auth/logged-out-panel.tsx lines 3, 22-35 (imports and renders Alert only); grep for '@/components/ui/card' in src/components matches sign-in-form, sign-up-form, pending-approval-panel, blocked-account-panel (plus email panels) but not logged-out-panel.

**Suggested fix:** Change to: "Card primitive (shadcn-style). Public/auth pages use this for sign-in, sign-up, pending-approval, and blocked screens."

<details><summary>Verifier reasoning</summary>

The comment at src/components/ui/card.tsx lines 4-7 claims the logged-out screen uses Card, but it does not. src/app/[locale]/(public)/logged-out/page.tsx renders only LoggedOutPanel inside a plain <main>; src/components/auth/logged-out-panel.tsx imports and renders Alert/AlertTitle/AlertDescription only (src/components/ui/alert.tsx, a standalone div-based primitive with no Card dependency). The (public) layout also adds no Card wrapper. A repo-wide grep for '@/components/ui/card' matches sign-in-form, sign-up-form, pending-approval-panel, blocked-account-panel, email/invite panels, and secure/admin pages — not logged-out-panel or the logged-out page. The comment's other four claims (sign-in, sign-up, pending-approval, blocked) are accurate, so this is a one-item inaccuracy in a descriptive doc comment with no behavioral impact; P2 severity is appropriate.

</details>

### `src/components/ui/dialog-manager.tsx:42`

**Comment:** `confirm(...)` ... Resolves with `true` if confirmed, `false` otherwise (including ESC/overlay click).

**Actually:** The confirm dialog is a Radix AlertDialog. AlertDialogContent hard-prevents outside dismissal (node_modules/@radix-ui/react-alert-dialog/dist/index.mjs lines 67-68: onPointerDownOutside/onInteractOutside call event.preventDefault()), so clicking the overlay does nothing — the dialog stays open and the promise does not resolve. Only ESC, the Cancel button, or the Confirm button resolve it (ESC/Cancel resolve false via onOpenChange(false) -> onResult(false)).

**Evidence:** src/components/ui/dialog-manager.tsx ConfirmDialog (lines 220-251) renders AlertDialog/AlertDialogContent from src/components/ui/alert-dialog.tsx, which wraps AlertDialogPrimitive.Content with no override of the outside-interaction prevention; Radix dist source confirms onPointerDownOutside and onInteractOutside are preventDefault'd unconditionally.

**Suggested fix:** Change to: "Resolves with `true` if confirmed, `false` otherwise (including ESC; overlay clicks do not dismiss an AlertDialog)."

<details><summary>Verifier reasoning</summary>

The comment claims confirm() "Resolves with true if confirmed, false otherwise (including ESC/overlay click)". ESC is accurate, but overlay click is not: ConfirmDialog (src/components/ui/dialog-manager.tsx lines 209-252) uses the Radix AlertDialog primitive via src/components/ui/alert-dialog.tsx, whose AlertDialogContent wrapper passes props straight to AlertDialogPrimitive.Content with no outside-interaction override and whose overlay has no click handler. The installed Radix source (node_modules/@radix-ui/react-alert-dialog/dist/index.mjs lines 67-68) unconditionally sets onPointerDownOutside and onInteractOutside to event.preventDefault(), placed after ...contentProps in the spread so they cannot be overridden by consumers anyway. A preventDefault'ed outside event suppresses DismissableLayer's onDismiss, so onOpenChange(false) never fires on overlay click — the dialog stays open and the promise does not resolve (neither true nor false). Only ESC, Cancel, or Confirm settle it. There is no indirection (no custom overlay onClick, no handler composition, no alternate content path) under which the comment's overlay-click claim holds; the confirm dialog specifically uses AlertDialog, not the dismissible Dialog primitive used by promptText. P2 severity is correct: it is a misleading doc comment on a UI utility, but the user always has visible Cancel/ESC affordances, so no promise is leaked in practice and no runtime bug results.

</details>

### `src/components/ui/select.tsx:9`

**Comment:** Select primitive (Radix-backed). Used by the locale switcher and any compact-mode toggle.

**Actually:** The locale switcher (src/components/i18n/locale-switcher.tsx) does use Select, but the compact-mode toggle (src/components/app-shell/compact-mode-toggle.tsx) is a ghost Button with aria-pressed that flips a Zustand density value — it imports no Select component, and no other compact-mode UI uses Select.

**Evidence:** src/components/app-shell/compact-mode-toggle.tsx lines 4, 26-36 (imports Button, renders <Button aria-pressed=...>); grep for SelectTrigger outside components/ui matches locale-switcher, organization-switcher, auth-policy-form, and two org admin forms — no compact-mode component.

**Suggested fix:** Change to: "Select primitive (Radix-backed). Used by the locale switcher and other dropdown pickers (organization switcher, admin forms). Keyboard navigation and focus trapping are provided by Radix."

<details><summary>Verifier reasoning</summary>

The comment in src/components/ui/select.tsx (lines 8-12) claims Select is "Used by the locale switcher and any compact-mode toggle." The locale-switcher half is accurate (src/components/i18n/locale-switcher.tsx imports from @/components/ui/select), but the compact-mode half is demonstrably false: src/components/app-shell/compact-mode-toggle.tsx renders a ghost Button with aria-pressed that toggles the Zustand density value in useAppShellStore — it imports no Select. An exhaustive grep shows only five consumers of @/components/ui/select (locale-switcher, organization-switcher, auth-policy-form, and two org admin forms), none compact-mode related; no other density/compact UI (data-grid, compact-density-wrapper) uses Select. Git history confirms compact-mode-toggle has been a Button since its creation (commit 982b020), so the comment was never accurate. The hypothetical reading ("any compact-mode toggle, should one exist") fails because such a toggle exists and does not use Select. P2 severity is appropriate for a misleading doc comment with no functional impact.

</details>

### `src/config/i18n-config.ts:7`

**Comment:** 3. Updating the `NEXT_PUBLIC_SUPPORTED_LOCALES` env value used by the client locale switcher.

**Actually:** NEXT_PUBLIC_SUPPORTED_LOCALES is not read anywhere in src/ — the client locale switcher imports the `locales` array from this very module. docs/configuration.md line 31 explicitly documents the env var as "Informational only — NOT read at runtime. The canonical locale list lives in src/config/i18n-config.ts; editing this does not change behavior."

**Evidence:** Grep for NEXT_PUBLIC_SUPPORTED_LOCALES hits only .env.example, docs/configuration.md, specs.md, and this comment — no runtime code. src/components/i18n/locale-switcher.tsx line 12 imports { locales } from "@/config/i18n-config" and maps over it (line 70).

**Suggested fix:** Replace step 3 with the real surface (message catalogs + LOCALE_LABELS in locale-switcher.tsx and language-menu.tsx, email-template locale migration, etc.), or at minimum reword to: "3. (Optional) updating the informational NEXT_PUBLIC_SUPPORTED_LOCALES value in .env.example/docs — it is not read at runtime."

<details><summary>Verifier reasoning</summary>

The comment in src/config/i18n-config.ts (line 7) claims NEXT_PUBLIC_SUPPORTED_LOCALES is "used by the client locale switcher." This is demonstrably false: (1) a repo-wide grep shows the env var appears only in .env.example, docs/configuration.md, specs.md, and the comment itself — no runtime code reads it; (2) src/components/i18n/locale-switcher.tsx line 12 imports { locales } directly from @/config/i18n-config and maps over it at line 70, so the switcher's locale list comes from the very module containing the comment, not the env var; (3) docs/configuration.md line 31 explicitly documents the var as "Informational only — NOT read at runtime"; (4) no dynamic process.env access could rescue the claim since Next.js only inlines literal NEXT_PUBLIC_ references, and none exist. No reasonable reading makes the comment defensible. Severity corrected to P2: the wrong step is a harmless no-op (updating an unread env value), the docs already contradict it, and no runtime behavior is affected — it only wastes a developer's time during locale addition.

</details>

### `src/config/route-regions.ts:25`

**Comment:** Path segments (the second segment after `/[locale]`) that belong to the auth route group. Kept in sync with `src/app/[locale]/(auth)`.

**Actually:** The (auth) route group also contains `invite`, `sso`, and `verify-email` (each with real pages: invite/page.tsx, sso/confirm, verify-email/page.tsx), none of which are in AUTH_PATH_SEGMENTS — so classifyRoute() returns "public" (not "auth") for /en/invite, /en/sso/confirm, /en/verify-email. The header prose (lines 11-12) also enumerates the auth region as "sign-in / sign-up / forgot-password / pending-approval / blocked", omitting reset-password which IS in the array.

**Evidence:** ls src/app/[locale]/(auth) shows: blocked, forgot-password, invite, pending-approval, reset-password, sign-in, sign-up, sso, verify-email. AUTH_PATH_SEGMENTS (lines 27-34) lists only sign-in, sign-up, forgot-password, reset-password, pending-approval, blocked. tests/unit/route-regions.test.ts does not assert directory sync.

**Suggested fix:** Either add "invite", "sso", "verify-email" to AUTH_PATH_SEGMENTS if they should classify as auth, or change the comment to: "Kept in sync with the redirect-relevant subset of src/app/[locale]/(auth); invite/sso/verify-email deliberately classify as public." Also add reset-password to the header enumeration on lines 11-12.

<details><summary>Verifier reasoning</summary>

The comment's claim "Kept in sync with src/app/[locale]/(auth)" is demonstrably false. The directory contains nine segments; AUTH_PATH_SEGMENTS lists six. invite, sso, and verify-email all have real pages (invite/page.tsx, sso/confirm/page.tsx, verify-email/page.tsx and verify-email/confirmed/page.tsx) yet classifyRoute() returns "public" for /en/invite, /en/sso/confirm, and /en/verify-email. Git history shows the sync practice existed (commit 0267c3c added reset-password to both the page tree and the array) but the array was never updated when verify-email (141feb0), invite (7f5b4bd), and sso/confirm (71d0b11) were added afterward — route-regions.ts has not been touched since 0267c3c. The header prose (lines 11-12) also omits reset-password, which IS in the array, confirming general drift. The only defensible-intent evidence, docs/uat/public-auth.md documenting sso/confirm as "classified public, not auth", rescues the behavior but not the comment: if the array is a deliberate subset, "kept in sync" is exactly the wrong description of the relationship. tests/unit/route-regions.test.ts hardcodes five segments and asserts no directory sync. Severity corrected to P2: the "auth" region has zero production consumers (src/proxy.ts imports only isLocalizedSecurePath; isLocalizedAuthPath appears only in tests), so the misclassification causes no runtime behavior difference today — the harm is a misleading stale comment on a self-described single-source-of-truth module (a latent trap for future consumers of the auth region), not a live defect.

</details>

### `src/db/migrations/0001-initial-schema.sql:850`

**Comment:** unlike roles/keys, which mean the org is genuinely "in use" and correctly RESTRICT - see 0005

**Actually:** There is no 0005 core migration — the former 0005 (the DB-1 org-deletion FK/RESTRICT rationale) was squashed into this same file (the "Organization deletion: audit-tombstone FK" section, lines 720-808). The cross-reference points at a file that no longer exists.

**Evidence:** ls src/db/migrations shows only 0001-initial-schema.sql at the top level; the RESTRICT rationale referenced now lives at lines 748-753 of this file.

**Suggested fix:** Replace "see 0005" with "see the 'Organization deletion: audit-tombstone FK' section above".

<details><summary>Verifier reasoning</summary>

The comment at src/db/migrations/0001-initial-schema.sql:850 says "see 0005", but no core 0005 migration exists. Git history shows 0005-organizations-fk-on-delete.sql was squashed into 0001 by commit 383177b ("consolidate the core migrations into a single 0001-initial-schema"); the RESTRICT rationale it referenced now lives at lines 748-753 of the same file (the "Organization deletion: audit-tombstone FK" section, lines 720-808). No defensible alternative reading survives: the only remaining file named 0005 is locales/0005-email-templates-zh.sql (unrelated Chinese email seeds), "0005" appears nowhere else in 0001-initial-schema.sql so it cannot be a same-file section label, and docs/admin-manager.md:562 itself calls it "the folded-in `0005` section", confirming the file is gone. The cross-reference is a stale artifact of the squash. Severity P2 is correct: the substantive claim (roles/keys deliberately RESTRICT) remains accurate and the rationale is findable ~100 lines above; only the pointer is dangling, with no functional impact.

</details>

### `src/db/provision.ts:10`

**Comment:** 2. pnpm db:app:migrate   — extensions (pgcrypto, pg_trgm) + app schema (0001 … 0010), ledgered in `app_schema_migrations`

**Actually:** The core migrations directory contains exactly one numbered file, 0001-initial-schema.sql (the former 0001-0010 series was consolidated); there is no 0002..0010. run-migrations.ts's header was updated for this ("Today that is the single 0001-initial-schema.sql") but provision.ts was not. The runtime step label at line 31 ("extensions + 0001 … 0010") repeats the stale range.

**Evidence:** ls src/db/migrations shows only 0001-initial-schema.sql, better-auth-schema.sql, and the locales/ subdirectory; src/db/migrations/run-migrations.ts lines 16-22 confirm the single-file baseline.

**Suggested fix:** Change both line 10 and the line 31 label to reference the current layout, e.g. "app schema (0001-initial-schema.sql + locales/*)".

<details><summary>Verifier reasoning</summary>

The comment is demonstrably stale. Verified directly: (1) C:/my/repos/devresponsekit/src/db/migrations contains exactly one core numbered file, 0001-initial-schema.sql (plus better-auth-schema.sql, the runner scripts, and locales/) — there is no 0002…0010 series. (2) src/db/migrations/run-migrations.ts lines 16-22 explicitly document the consolidated state: "CORE — every top-level *.sql (lexical). Today that is the single 0001-initial-schema.sql: the complete baseline … It is FROZEN". (3) Git history confirms the consolidation: commit 383177b "refactor(db): consolidate the core migrations into a single 0001-initial-schema" touched the former numbered files. I tried alternate readings to refute: the locale pass is numbered 0000–0007 (not 0001–0010), so the range cannot refer to locales; provision.ts is explicitly for a FRESH database, so the range cannot be defended as describing a pre-consolidation ledger on an existing DB — a fresh db:app:migrate applies and ledgers only 0001-initial-schema.sql. The stale "0001 … 0010" also appears in the runtime step label at provision.ts line 31 ("application schema (extensions + 0001 … 0010)"), which prints during provisioning, exactly as the reviewer states. No reasonable reading of the current code makes "0001 … 0010" accurate. Severity P2 is appropriate: it is a misleading doc comment and a cosmetic runtime label with no functional impact — the actual migration behavior (extensions + lexical apply + app_schema_migrations ledger) is otherwise correctly described.

</details>

### `src/db/seeds/seed-local.ts:63`

**Comment:** Sourced from the single canonical list in `src/lib/admin/permissions.server.ts` so the seed cannot drift from the runtime check.

**Actually:** The canonical ADMIN_PERMISSION_CATALOG is defined in src/lib/admin/permissions.ts (a deliberately non-server-only module created precisely so this seed can import it); permissions.server.ts merely re-exports it. The seed's own import (line 5) is from "@/lib/admin/permissions" — it could not import permissions.server.ts at all under plain Node.

**Evidence:** src/lib/admin/permissions.ts lines 1-12 (header explains the extraction for seed scripts) and line 23 (the catalog definition); src/lib/admin/permissions.server.ts line 195 is only a re-export; seed-local.ts line 5 imports from @/lib/admin/permissions.

**Suggested fix:** Change the path in the comment to `src/lib/admin/permissions.ts`.

<details><summary>Verifier reasoning</summary>

The comment at src/db/seeds/seed-local.ts lines 61-64 states the permission list is "Sourced from the single canonical list in `src/lib/admin/permissions.server.ts`", but every checkable fact contradicts this. (1) The seed's actual import on line 5 is `from "@/lib/admin/permissions"` — the non-server-only module. (2) src/lib/admin/permissions.ts lines 1-12 explicitly document that ADMIN_PERMISSION_CATALOG was extracted there precisely because the seed "runs under plain Node and cannot resolve the `server-only` import sentinel" — i.e., the seed could not import permissions.server.ts at all. (3) The catalog definition lives at permissions.ts line 23. (4) permissions.server.ts line 195 is a pure re-export (`export { ADMIN_PERMISSION_CATALOG, ... } from "./permissions"`), and its own adjacent doc comment (lines 191-193) says it is "Sourced from the non-`server-only` catalog module" — identifying itself as a consumer, not the canonical home. The only conceivable defense — that permissions.server.ts transitively exposes the same list — fails because the comment makes a specific claim about where the single canonical list resides, and both files' own documentation plus the import statement three lines above prove otherwise. This is a stale file pointer (likely predating the extraction). The comment's functional claim (seed cannot drift from the runtime check) remains true since both source one shared list, so the impact is limited to misdirecting a maintainer to the wrong file; P2 severity is appropriate.

</details>

### `src/lib/active-org.server.ts:16`

**Comment:** Security: the cookie only SELECTS among the caller's own memberships. ... a forged or stale cookie naming an org the user is not an active member of simply falls back to their primary membership and can never grant access.

**Actually:** The fallback only happens when the user has NO membership row at all in the cookie-named org. getUserAccessContext's cookie path (src/lib/auth-status.ts lines 161-177) looks up the membership WITHOUT a status filter: a stale cookie naming an org where the user's membership is pending_approval/blocked/suspended resolves THAT membership (no fallback to the primary/earliest one), and decideSecureAccess then denies access — the user is bounced to the pending-approval/blocked page even though they hold an active membership elsewhere. "Can never grant access" holds, but "simply falls back to their primary membership" is wrong for the comment's own named scenario (a stale cookie for an org where the membership was since suspended).

**Evidence:** src/lib/auth-status.ts lines 161-169: the activeOrgId lookup filters only on app_user_id + organization_id (no status filter); the earliest-membership fallback at lines 170-177 runs only `if (!membership)`. Contrast the accurate wording in auth-status.ts's own comment: "names an org the user is not a MEMBER of".

**Suggested fix:** Change to: "a forged or stale cookie naming an org the user has NO membership in falls back to their primary membership; one naming an org where their membership is non-active resolves that membership and the guard denies (pending/blocked) — either way it can never grant access. So the cookie does not need to be signed."

<details><summary>Verifier reasoning</summary>

The reviewer's reading is correct and the comment cannot be rescued under any reasonable interpretation. In src/lib/auth-status.ts:162-168 the cookie-path membership lookup filters only on app_user_id + organization_id with NO status filter, and the earliest-membership fallback (lines 170-177) runs only `if (!membership)` — i.e., only when the user has no membership row at all in the cookie-named org. A stale cookie naming an org where the user's membership was downgraded to suspended/blocked/pending_approval (real admin operations: updateTable("app_organization_memberships") in src/app/api/administrator/organizations/[id]/members/route.ts:291, src/app/api/administrator/users/[id]/memberships/route.ts:276, src/lib/admin/user-actions.server.ts:241/332) resolves THAT non-active membership; decideSecureAccess (auth-status.ts:70-81) then returns blocked/pending_approval and requireSecureSession (src/lib/auth-guard.ts:67-73) redirects the user — no fallback to their primary/earliest membership occurs, nothing clears the cookie, and the org switcher is inside the secure shell they can no longer reach. The charitable reading of "not an active member of" as "not a member of" is foreclosed by the file's own vocabulary: active-org.server.ts itself defines userHasActiveMembership (status='active' filter) and listUserActiveOrganizations ("ACTIVE member") — "active member" is a term of art in this module, and the comment even cites userHasActiveMembership as the authority. The comment further misattributes the status authority to "the membership filter in getUserAccessContext" (which has no status filter on the cookie path; the authority is decideSecureAccess), while the sibling comment in auth-status.ts:156-157 uses the accurate wording "names an org the user is not a member of". What survives: the fallback claim IS correct for forged cookies (no row) and for deleted memberships (delete routes at organizations/[id]/members/route.ts:392, users/[id]/memberships/route.ts:374), and the load-bearing security conclusion — "can never grant access", so the cookie needn't be signed — holds in all cases (fail-closed via decideSecureAccess). Severity corrected to P2: the inaccuracy is in a secondary behavioral clause, not the security rationale; its consequence is a hidden UX/availability edge case (user with a stale cookie for a since-suspended membership is bounced to /blocked despite holding an active membership elsewhere), not any privilege escalation.

</details>

### `src/lib/api-auth/scopes.ts:5`

**Comment:** Scopes ARE the existing permission vocabulary — the 26-key admin catalog plus a small set of user-level `account.*` scopes for the self-service surface.

**Actually:** ADMIN_PERMISSION_CATALOG in src/lib/admin/permissions.ts contains 35 keys, not 26 (the catalog grew with admin.apps.*, admin.email.*, admin.apikeys.*, admin.clients.* entries after this comment was written). API_SCOPE_CATALOG therefore spreads 35 admin keys plus 4 account scopes.

**Evidence:** grep -c '{ key: "admin\.' src/lib/admin/permissions.ts returns 35; scopes.ts line 38 builds API_SCOPE_CATALOG from ANY_ADMIN_PERMISSION (all 35 keys) + ACCOUNT_SCOPES (4).

**Suggested fix:** Change 'the 26-key admin catalog' to 'the admin permission catalog (ADMIN_PERMISSION_CATALOG)' — or drop the count entirely so it cannot drift again.

<details><summary>Verifier reasoning</summary>

ADMIN_PERMISSION_CATALOG in src/lib/admin/permissions.ts (lines 24-58) has exactly 35 entries, not 26. ANY_ADMIN_PERMISSION is a direct .map over that catalog, and API_SCOPE_CATALOG in src/lib/api-auth/scopes.ts (lines 37-40) spreads all 35 admin keys plus the 4 ACCOUNT_SCOPES. The comment's "26-key" figure was accurate for the original catalog (users 10 + roles 5 + groups 5 + permissions 1 + orgs 5 = 26) but the catalog later gained 9 keys (admin.apps.* x2, admin.audit.read, admin.email.* x2, admin.apikeys.* x2, admin.clients.* x2). No alternate 26-element constant exists that the comment could be referring to, so the numeric claim demonstrably misstates the current code. The conceptual claim (scopes reuse the permission vocabulary) remains true, so P2 severity is correct — a stale count with no functional impact.

</details>

### `src/lib/docs/render/pipeline.server.ts:22`

**Comment:** No author JavaScript is ever executed (`allowDangerousHtml: false` keeps raw HTML out; MDX expressions are dropped, not run).

**Actually:** The pipeline has no MDX parser (remark-parse + remark-gfm only), so MDX `{expression}` syntax has no special meaning: brace expressions are emitted verbatim as literal text in the rendered HTML, not dropped. Only raw HTML/JSX-style tags are dropped (by remark-rehype with allowDangerousHtml: false). The 'not run' half of the claim is correct.

**Evidence:** pipeline.server.ts:187-202 plugin chain contains no @mdx-js/* plugin; the docs page (src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:40-46) passes doc.body straight to renderDocument for both md and mdx formats with no MDX preprocessing, so CommonMark treats `{...}` as plain text.

**Suggested fix:** Replace "MDX expressions are dropped, not run" with "MDX expressions are never evaluated — with no MDX parser in the chain they render as literal text; raw HTML/JSX tags are dropped".

<details><summary>Verifier reasoning</summary>

Empirically verified with the project's own dependencies: the pipeline chain in src/lib/docs/render/pipeline.server.ts:187-202 (remark-parse + remark-gfm + remark-rehype {allowDangerousHtml:false} + rehype-sanitize) renders 'Year: {new Date().getFullYear()}' as '<p>Year: {new Date().getFullYear()}</p>' — the brace expression is emitted verbatim as literal text, not dropped. Only raw HTML/JSX-style tags are dropped. There is no @mdx-js/* or remark-mdx dependency in package.json, and no MDX preprocessing anywhere: filesystem-source.server.ts only matches *.md/*.mdx extensions for cataloging, and page.tsx:40-46 passes doc.body directly to renderDocument for both formats. No defensible reading rescues the comment: 'MDX expressions' is the term of art for {...} syntax (JSX tags are 'elements', and tag-like content is already covered by the comment's preceding allowDangerousHtml clause), and 'dropped' cannot reasonably mean 'passed through as visible text'. The 'not run' security half is correct, so P2 severity is appropriate.

</details>

### `src/lib/jwt-handoff.server.ts:60`

**Comment:** *   - Tokens are short-lived (max 60s, enforced by SSO_HANDOFF_TTL_SECONDS).

**Actually:** The 60s cap is enforced by clampSsoHandoffTtl / SSO_HANDOFF_MAX_TTL_SECONDS (this file, lines 32-37, applied in signSsoHandoff line 78) — NOT by the SSO_HANDOFF_TTL_SECONDS env var, which the env schema (src/lib/env.ts line 64) accepts up to 300; any value above 60 is silently clamped down. A reader trusting the comment would think the env var is the enforcement point and that setting it to 300 yields a 300s token.

**Evidence:** src/lib/jwt-handoff.server.ts lines 32-37 (SSO_HANDOFF_MAX_TTL_SECONDS = 60, clampSsoHandoffTtl) and line 78 (`const ttl = clampSsoHandoffTtl(input.ttlSeconds)`); src/lib/env.ts line 64: `SSO_HANDOFF_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60)`.

**Suggested fix:** Change to: "- Tokens are short-lived: the requested TTL (SSO_HANDOFF_TTL_SECONDS) is clamped to SSO_HANDOFF_MAX_TTL_SECONDS (60s) by clampSsoHandoffTtl."

<details><summary>Verifier reasoning</summary>

The comment at src/lib/jwt-handoff.server.ts:60 attributes the 60s max-TTL enforcement to SSO_HANDOFF_TTL_SECONDS, but that is an env var (src/lib/env.ts:64) whose schema accepts values up to 300 and therefore cannot enforce a 60s cap. The actual enforcement is SSO_HANDOFF_MAX_TTL_SECONDS = 60 plus clampSsoHandoffTtl (jwt-handoff.server.ts:32-37), applied inside signSsoHandoff at line 78; signSsoHandoff never reads the env var. The sole caller (src/lib/sso.server.ts:92) likewise clamps the env value. Refutation attempts fail: the name in the comment exactly matches a real, different identifier (the env var), so it is not defensible as shorthand for the MAX constant; and while the env var supplies the requested TTL, the comment specifically claims it enforces the 60s maximum, which is false — SSO_HANDOFF_TTL_SECONDS=300 passes env validation and is silently clamped to 60. A reader trusting the comment would believe the env var is the enforcement point and that raising it raises the token lifetime. P2 severity is appropriate: purely a misleading comment; runtime behavior remains safe due to the clamp.

</details>

### `src/lib/observability/metrics.server.ts:20`

**Comment:** Next increments (tracked in docs/observability.md §5): request latency/status by route, DB latency, auth failures, and outbox delivery.

**Actually:** docs/observability.md §5 ("Metrics") documents what already ships; the listed next increments (request latency/status by route, DB latency, auth failures, outbox delivery) are tracked in §6 ("Roadmap — not yet shipped"), which §5 itself points to ("first increment of the metrics roadmap (§6)").

**Evidence:** docs/observability.md:75-114 (§5 describes shipped endpoint/counters only) and :116-124 (§6 bullet "Metrics — remaining surface" lists exactly the increments the comment names).

**Suggested fix:** Change "tracked in docs/observability.md §5" to "tracked in docs/observability.md §6".

<details><summary>Verifier reasoning</summary>

The comment (src/lib/observability/metrics.server.ts:19-20) says the next increments are "tracked in docs/observability.md §5", but §5 ("Metrics", docs/observability.md:75-114) documents only the shipped surface (token-guarded /api/metrics, process defaults, rate_limit_denials_total) and explicitly defers to the roadmap: "first increment of the metrics roadmap (§6) — not the full target set." The increments the comment names (request latency/status by route, DB latency, auth failures, outbox delivery) are enumerated verbatim in §6 ("Roadmap — not yet shipped", :116-124) under "Metrics — remaining surface." I attempted refutation via git history: at commit 76d280b, which introduced both the comment and this doc revision, the §5/§6 split was already exactly as it is today, so there is no historical numbering under which §5 tracked these items, and no reasonable reading under which §5 "tracks" them — it only cross-references §6. The reviewer's claim is accurate; the correct pointer is §6. Severity P2 stands: a wrong section cross-reference with no behavioral impact, and §5 links to §6 so the reader detour is minimal.

</details>

### `tests/db/organization-auth-settings.db.test.ts:6`

**Comment:** DB-BACKED integration tests for migration 0007 (`app_organization_auth_settings` — per-org signup policy) ... its values reproduce the pre-0007 hardcoded workflow ... the "no behavior change on upgrade" guarantee ... (it must never block org deletion the way in-use roles/keys do — see 0005).

**Actually:** Migration 0007 (and 0005) no longer exist: core migrations were squashed into 0001-initial-schema.sql (commit 383177b). The app_organization_auth_settings table, its partial unique index, CHECK constraints, and the single platform-default seed row are all created by 0001-initial-schema.sql (lines ~852-883), so there is no separate 0007 upgrade step; the "pre-0007 / upgrade" framing describes history that is no longer represented in the migration set. The assertions themselves still hold.

**Evidence:** src/db/migrations contains only 0001-initial-schema.sql as core; 0001-initial-schema.sql lines 852-883 create app_organization_auth_settings, the partial unique index on (organization_id is null), and the platform-default seed insert; describe/test titles also cite "0007".

**Suggested fix:** Reword header (and the "0007"/"pre-0007"/"see 0005" mentions plus describe/test titles) to reference the consolidated 0001-initial-schema.sql, e.g. "the app_organization_auth_settings table and its seeded platform default (0001-initial-schema.sql)".

<details><summary>Verifier reasoning</summary>

The comment references "migration 0007" and "see 0005", but commit 383177b consolidated core migrations 0002-0008 (including 0005-organizations-fk-on-delete.sql and 0007-organization-auth-settings.sql) into 0001-initial-schema.sql and deleted the files; follow-up commit b306c05 removed even the "Folded in from" history markers, presenting 0001 as a day-one schema. src/db/migrations now contains only 0001 as core (verified by glob), and 0001 lines 852-884 create app_organization_auth_settings, its partial unique index, CHECK constraints, and the single platform-default seed. There is no separate 0007 upgrade step, so the "pre-0007 hardcoded workflow" / "no behavior change on upgrade" framing and the "see 0005" cross-reference describe migration structure absent from the repo; the only files numbered 0005/0007 are unrelated locale email-template migrations, making the stale numbers actively misleading. The reviewer concedes (and I confirm) the test assertions themselves remain valid, so this is documentation staleness with no functional impact — P2 is the correct severity.

</details>

### `tests/db/organization-invitations.db.test.ts:11`

**Comment:** DB-BACKED integration tests for migration 0008 (`app_organization_invitations` + the `invite_only` approval mode) ... and (line 125) "0008 extends the 0007 mode CHECK: invite_only is now storable..."

**Actually:** Migrations 0007/0008 no longer exist; the invitations table, its partial unique pending index, the status CHECK, and the invite_only-extended approval-mode CHECK are all created inside the consolidated 0001-initial-schema.sql (lines ~896-967, including the drop-and-re-add of app_organization_auth_settings_signup_approval_mode_check). Behavior is unchanged; the numbered-migration references are stale.

**Evidence:** src/db/migrations contains only 0001-initial-schema.sql as core (commit 383177b squash); 0001-initial-schema.sql lines 910-967 create app_organization_invitations and re-add the approval-mode CHECK including 'invite_only'.

**Suggested fix:** Replace "migration 0008" / "0008 extends the 0007 mode CHECK" (and the "(DB-backed, 0008)" describe title) with references to 0001-initial-schema.sql, e.g. "the invitations schema in 0001-initial-schema.sql" / "the approval-mode CHECK accepts invite_only".

<details><summary>Verifier reasoning</summary>

The comment references "migration 0008" and "the 0007 mode CHECK", but neither migration exists: commit 383177b consolidated 0002-0008 into src/db/migrations/0001-initial-schema.sql (files deleted), and the follow-up commit b306c05 removed even the "Folded in from 0007/0008" history markers from the baseline. 0001-initial-schema.sql lines 896-967 now create app_organization_invitations (line 910), the partial unique pending index (line 937), and drop-and-re-add app_organization_auth_settings_signup_approval_mode_check including 'invite_only' (lines 966-967) — exactly matching the reviewer's evidence. A repo-wide grep shows the only remaining 0007/0008 references are the stale comments in tests/db/organization-invitations.db.test.ts (lines 11, 91, 125) and tests/db/organization-auth-settings.db.test.ts. The only possible defense — that the comment is an accurate historical reference — fails because the repo deliberately erased that evolution history (b306c05: "present the migration setup as day-one"), leaving the comment pointing at artifacts no reader can find. All behavioral claims in the comment (partial index semantics, status CHECK, invite_only-extended approval-mode CHECK, FK lifecycle) remain accurate, so P2 (stale reference, behavior unchanged) is the correct severity.

</details>

### `tests/db/organizations-delete.db.test.ts:8`

**Comment:** DB-BACKED integration tests for DB-1 (org DELETE foreign-key handling). These run the real ON DELETE behavior from migration 0005 against Postgres ... the 0004 append-only trigger PERMITS that exact tombstone UPDATE.

**Actually:** There are no core migrations 0004 or 0005 anymore. Commit 383177b consolidated all core migrations into a single src/db/migrations/0001-initial-schema.sql; the append-only trigger (lines ~680-777) and the app_audit_events.organization_id ON DELETE SET NULL tombstone FK (lines ~721-783) now both live in 0001-initial-schema.sql. The tested behavior itself is intact.

**Evidence:** Glob of src/db/migrations shows only 0001-initial-schema.sql as a core migration; git log shows 383177b "refactor(db): consolidate the core migrations into a single 0001-initial-schema"; 0001-initial-schema.sql contains the append-only trigger and the SET NULL tombstone sections.

**Suggested fix:** Replace "migration 0005" and "the 0004 append-only trigger" with references to the consolidated schema, e.g. "the ON DELETE behavior and append-only audit trigger defined in 0001-initial-schema.sql".

<details><summary>Verifier reasoning</summary>

The comment in tests/db/organizations-delete.db.test.ts (lines 8, 12-13) attributes the ON DELETE behavior to "migration 0005" and the append-only trigger to "the 0004 append-only trigger", but no core migrations 0004 or 0005 exist in the repo. Commit 383177b consolidated the six forward migrations (including 0004-audit-append-only.sql and 0005-organizations-fk-on-delete.sql) into src/db/migrations/0001-initial-schema.sql and deleted the standalone files; the follow-up commit b306c05 then removed even the "Folded in from 0004/0005" provenance markers, so no in-tree reading of "migration 0004/0005" resolves to anything (the only files with those numbers are locales/0004-email-templates-pt.sql and locales/0005-email-templates-zh.sql, unrelated). The tested behavior itself is fully intact in 0001-initial-schema.sql: the append-only trigger function app_audit_events_block_mutation (lines ~697-717, redefined with the tombstone exception at ~756-781) and the app_audit_events.organization_id ON DELETE SET NULL FK swap (lines ~721-800). The defect is purely a stale migration-number pointer with no behavioral impact, so P2 is the correct severity.

</details>

### `tests/e2e/admin-overview.spec.ts:5`

**Comment:** E2E — the Administrator overview dashboard (docs/admin-manager.md §8.1) renders both tiers...

**Actually:** In the current docs/admin-manager.md, §8.1 is "Users" (the users area, line 351), not the overview dashboard; the doc has no numbered section for the overview dashboard at all. §8.1 was "Overview (administrator/page.tsx)" only in the old implementation-plan version of the doc (commit a89e66f), which was replaced by the regenerated doc (commit 704b215).

**Evidence:** docs/admin-manager.md headings: "### 8.1 Users" at line 351; no heading mentions the overview dashboard; git show a89e66f:docs/admin-manager.md has "### 8.1 Overview (administrator/page.tsx)".

**Suggested fix:** Remove the stale section pointer, e.g. "E2E — the Administrator overview dashboard renders both tiers for the seeded platform admin: ..." (optionally cite docs/uat/administrator-users.md's console-overview section instead).

<details><summary>Verifier reasoning</summary>

The comment in tests/e2e/admin-overview.spec.ts cites "docs/admin-manager.md §8.1" for the Administrator overview dashboard, but in the current doc §8.1 is "Users" (line 351), which documents the user-lifecycle endpoints. A case-insensitive search of the whole doc for overview/dashboard/administrator-page/metric-card matches only "## 1. Overview" (line 35), a doc-level architecture overview of the console, not the dashboard page — so no section in the current doc covers the overview dashboard and the reference cannot be defended under any reading. Git history confirms the reviewer's account: commit a89e66f had "### 8.1 Overview (`administrator/page.tsx`)" (line 495 of that version), and commit 704b215 regenerated the docs set, renumbering the sections. The comment is a stale cross-reference to the pre-regeneration doc. P2 is appropriate: the test's substantive description matches its assertions; only the doc pointer is wrong.

</details>

### `tests/integration/administrator-api-keys-list.test.ts:8`

**Comment:** Integration tests for `GET /api/administrator/api-keys` (docs/admin-manager.md §8.12).

**Actually:** In the current docs/admin-manager.md, §8.12 is 'Email'; the API-keys area is §8.8 ('API keys', GET /api/administrator/api-keys with admin.apikeys.read).

**Evidence:** docs/admin-manager.md headings: line 457 '### 8.8 API keys', line 493 '### 8.12 Email'.

**Suggested fix:** Integration tests for `GET /api/administrator/api-keys` (docs/admin-manager.md §8.8).

<details><summary>Verifier reasoning</summary>

The comment at tests/integration/administrator-api-keys-list.test.ts:7-8 cites docs/admin-manager.md §8.12 for GET /api/administrator/api-keys. In the current docs, §8.12 (line 493) is "Email" (outbox/templates/test-send, admin.email.*), while API keys are documented in §8.8 (line 457), whose table lists `GET /api-keys` under `admin.apikeys.read` — the exact gate the test itself pins. No alternative section numbering exists in the doc under which §8.12 could refer to API keys, so the cross-reference is demonstrably stale/wrong. P2 severity is correct: a misdirecting doc pointer in a test comment, no functional impact.

</details>

### `tests/integration/administrator-audit.test.ts:8`

**Comment:** Integration tests for the audit endpoint (docs/admin-manager.md Phase 6 test plan, §8.11).

**Actually:** There is no 'Phase 6 test plan' section in docs/admin-manager.md, and the GET /api/administrator/audit endpoint itself is documented in §8.10 'Audit'; §8.11 'Audit explorer' is the RSC view over §8.10.

**Evidence:** docs/admin-manager.md:479 '### 8.10 Audit' documents `GET /api/administrator/audit` (admin.audit.read); :488 '### 8.11 Audit explorer' says 'the RSC view over §8.10'; no 'test plan' text anywhere in the doc.

**Suggested fix:** Integration tests for the audit endpoint (docs/admin-manager.md §8.10).

<details><summary>Verifier reasoning</summary>

The reviewer is correct. Current docs/admin-manager.md has '### 8.10 Audit' (line 479) documenting GET /api/administrator/audit — the exact endpoint the test file exercises via its mock of @/app/api/administrator/audit/route — and '### 8.11 Audit explorer' (line 488), which is explicitly 'the RSC view over §8.10'. A repo-wide and in-doc grep finds no 'Phase 6' or 'test plan' text in the doc (only 'Phase 7' in frontmatter and §19). Git history explains the drift without excusing it: the original plan doc (commit a89e66f) had '### 8.11 Audit', '## 17. Test plan', and '### Phase 6 — Enterprise apps & audit explorer', so the comment was accurate when written, but the doc was regenerated (704b215) and renumbered, moving Audit to §8.10 and deleting the Phase 6 test plan entirely. Under the current doc — the only reasonable referent of a live cross-reference — the comment cites a nonexistent section ('Phase 6 test plan') and the wrong section number (§8.11 names the RSC explorer, not the endpoint). No reasonable reading of the current doc makes the comment correct. P2 is the right severity: a stale docblock cross-reference with no behavioral impact.

</details>

### `tests/integration/administrator-enterprise-apps.test.ts:8`

**Comment:** Integration tests for the enterprise-apps endpoints (docs/admin-manager.md Phase 6 test plan, §8.10).

**Actually:** docs/admin-manager.md contains no 'Phase 6 test plan' section (the only phase section is §19 'Phase 7'), and §8.10 is 'Audit'; enterprise applications are documented in §8.7.

**Evidence:** rg 'Phase [4-7]' docs/admin-manager.md matches only §19 Phase 7 (line 597); headings show line 447 '### 8.7 Enterprise applications' and line 479 '### 8.10 Audit'.

**Suggested fix:** Integration tests for the enterprise-apps endpoints (docs/admin-manager.md §8.7).

<details><summary>Verifier reasoning</summary>

The comment at tests/integration/administrator-enterprise-apps.test.ts:8-9 cites "docs/admin-manager.md Phase 6 test plan, §8.10". Case-insensitive grep of docs/admin-manager.md finds zero occurrences of "Phase 6" or "test plan"; the only phase heading is "## 19. Phase 7" (line 597). §8.10 (line 479) is "Audit" (the app_audit_events read endpoint), while the enterprise-apps endpoints the tests cover are documented in "### 8.7 Enterprise applications" (line 447). No alternative reading rescues the comment — there is no test-plan section anywhere in the doc and §8.10 has no enterprise-apps content — so the citation is wrong on both the phase and the section number. P2 severity is appropriate: a misleading doc cross-reference with no functional impact.

</details>

### `tests/integration/administrator-organization-members.test.ts:8`

**Comment:** Integration tests for the organization members endpoints (docs/admin-manager.md Phase 5 test plan).

**Actually:** No 'Phase 5 test plan' exists in docs/admin-manager.md; memberships/org members are documented in §8.2–§8.3.

**Evidence:** rg 'Phase [4-7]' docs/admin-manager.md matches only §19 Phase 7; headings show line 400 '### 8.3 Memberships'.

**Suggested fix:** Integration tests for the organization members endpoints (docs/admin-manager.md §8.2–§8.3).

<details><summary>Verifier reasoning</summary>

Current docs/admin-manager.md contains no 'Phase 5' and no 'test plan': the only Phase references are line 3 (Phase 7 in frontmatter description) and line 597 '## 19. Phase 7 — impersonation, bulk actions, CSV export'. Org members are documented at '### 8.2 Organizations' (line 373) and '### 8.3 Memberships' (line 400), as the reviewer stated. The comment was accurate when written — the test file was added in commit 31b637a ('feat: implement Phase 5 organizations & memberships admin management'), and the doc at that commit had '## 17. Test plan' plus '### Phase 5 — Organizations & memberships' — but subsequent doc consolidation (704b215, 9691c64) removed both, leaving the comment a dangling cross-reference that a reader today cannot resolve. No alternative reading rescues it (docs/testing.md's 'Phase 5' concerns unrelated coverage work, and the comment explicitly names admin-manager.md). Severity P2 is correct: the substantive description of the tests (org-members endpoint contract: permission gates, envelopes, machine codes) remains accurate; only the parenthetical doc pointer is stale.

</details>

### `tests/integration/administrator-organizations.test.ts:9`

**Comment:** Integration tests for the organizations endpoints (docs/admin-manager.md Phase 5 test plan).

**Actually:** docs/admin-manager.md has no 'Phase 5' section or test plan; organizations are documented in §8.2.

**Evidence:** rg 'Phase [4-7]' docs/admin-manager.md matches only §19 Phase 7; headings show line 373 '### 8.2 Organizations'.

**Suggested fix:** Integration tests for the organizations endpoints (docs/admin-manager.md §8.2).

<details><summary>Verifier reasoning</summary>

docs/admin-manager.md currently contains no "Phase 5" and no test plan of any kind: a heading scan shows sections §1–§20 with organizations at line 373 (### 8.2 Organizations), and the only surviving phase reference is §19 "Phase 7 — impersonation, bulk actions, CSV export". A repo-wide search for "test plan" in docs/ finds nothing in admin-manager.md. Git history explains the drift: commit a89e66f originally created the doc as an implementation plan containing "### Phase 5 — Organizations & memberships" (an implementation plan, not a test plan), but commit 704b215 regenerated the docs into the current spec and removed all phases except Phase 7. Sibling tests were updated to cite current sections (administrator-phase7.test.ts cites "§19 Phase 7"), but this comment (and the same stale pointer in administrator-organization-members.test.ts and admin-orgs.test.ts) was left dangling. Under no reading of the current repo does docs/admin-manager.md contain a "Phase 5 test plan"; the comment demonstrably misstates the doc it cites. P2 severity is correct — a stale cross-reference in a test docblock with no behavioral impact.

</details>

### `tests/integration/administrator-roles.test.ts:9`

**Comment:** Integration tests for the roles endpoints (docs/admin-manager.md §5.1, §19, Phase 4 test plan).

**Actually:** In the current doc §19 is 'Phase 7 — impersonation, bulk actions, CSV export' (not roles), there is no 'Phase 4 test plan', and the roles area is documented in §8.4. Only §5.1 (error envelope) still matches.

**Evidence:** docs/admin-manager.md:597 '## 19. Phase 7 — impersonation, bulk actions, CSV export'; :407 '### 8.4 Roles'; no 'Phase 4' anywhere in the doc.

**Suggested fix:** Integration tests for the roles endpoints (docs/admin-manager.md §5.1, §8.4).

<details><summary>Verifier reasoning</summary>

The reviewer's evidence is exactly accurate against the current docs/admin-manager.md: §19 (line 597) is "Phase 7 — impersonation, bulk actions, CSV export", roles are documented in §8.4 (line 407), and "Phase 4"/"test plan" appear nowhere in the doc or anywhere else in docs/. Only §5.1 (Error envelope, line 140) still matches what the test pins. Git history shows why: before commit 704b215 regenerated the documentation set, §19 was "Phased delivery" and contained "### Phase 4 — Roles & permissions", so the comment was written against a doc version that no longer exists and was never updated. No alternative reading rescues it — no other repo file defines a "Phase 4 test plan" (the only other mentions, in src/lib/admin/roles.server.ts:7 and src/app/api/administrator/roles/[id]/members/route.ts:26, are the same stale reference), and the current §19 content is unrelated to roles endpoints. P2 is the correct severity: a stale documentation cross-reference with no functional impact.

</details>

### `tests/integration/administrator-user-actions.test.ts:8`

**Comment:** Integration tests for the Phase 3 user-mutation endpoints under `/api/administrator/users/[id]/*` (docs/admin-manager.md §5.2 + §17).

**Actually:** §5.2 in the current doc is 'CSV export' and §17 is 'Audit posture (append-only + retention)'; neither documents the user-mutation endpoints — those live in §8.1 'Users'.

**Evidence:** docs/admin-manager.md headings: :173 '### 5.2 CSV export', :550 '### 17. Audit posture', :351 '### 8.1 Users'.

**Suggested fix:** Integration tests for the user-mutation endpoints under `/api/administrator/users/[id]/*` (docs/admin-manager.md §8.1).

<details><summary>Verifier reasoning</summary>

The reviewer's evidence checks out against the current docs/admin-manager.md: line 173 is '### 5.2 CSV export' (export endpoint mechanics only), line 550 is '### 17. Audit posture (append-only + retention)' (DB trigger + retention job, not handler contracts), and line 351 '### 8.1 Users' contains the actual table documenting the /api/administrator/users/[id]/status, /ban, /unban, /password, /role, /sessions, /impersonate mutation endpoints the test exercises. Root cause: at the commit that added the test (199ce8bb), the doc's '### 5.2 Endpoints (summary)' held the full endpoint table, '## 17. Test plan' covered testing, and 'Phase 3 — Users module' named the phase — so the comment was accurate when written but the doc was later restructured and the section references rotted. No reading of the current doc saves the comment: §5.2 is unrelated to user mutations, and §17's append-only trigger is not the per-handler audit-write contract the tests pin (that's §5.3/§12 today). P2 severity is appropriate — a stale cross-reference in a test-file header comment with no behavioral impact, and the fix is trivial (point to §8.1, and optionally §12/§5.3 for the audit contract).

</details>

### `tests/integration/administrator-users-list.test.ts:8`

**Comment:** Integration tests for `GET /api/administrator/users` per docs/admin-manager.md §5.1, §5.3 and §17 (test plan).

**Actually:** §17 in the current doc is 'Audit posture (append-only + retention)' — not a test plan; the users area is documented in §8.1. §5.1 (error envelope) and §5.3 (audit helpers) remain relevant.

**Evidence:** docs/admin-manager.md:550 '### 17. Audit posture (append-only + retention)'; :351 '### 8.1 Users'; no 'test plan' section exists in the doc.

**Suggested fix:** Integration tests for `GET /api/administrator/users` per docs/admin-manager.md §5.1, §5.3 and §8.1.

<details><summary>Verifier reasoning</summary>

The comment cites "docs/admin-manager.md §5.1, §5.3 and §17 (test plan)". In the current doc, §5.1 (line 140, "Error envelope") and §5.3 (line 181, "Audit helpers") are accurate, but §17 (line 550) is "Audit posture (append-only + retention)" — a section about the DB append-only trigger and retention job, not a test plan. A case-insensitive search for "test plan"/"testing" across the whole doc finds nothing, so no reading of the comment maps to the current document. Git history explains the drift: the doc once had "## 17. Test plan" (added in a89e66f), removed when the docs were regenerated in 704b215, with the number 17 later reused for the audit-posture section. The users list endpoint is now documented in §8.1 (line 351), exactly as the reviewer stated. The comment is a stale cross-reference; P2 is the right severity since it misleads readers chasing the spec but has no functional effect.

</details>

### `tests/integration/locale-preference.test.ts:53`

**Comment:** The route only calls .json(), so a minimal Request shape is enough.

**Actually:** The route also reads request.headers on every error path: adminErrorResponse (unmocked in this suite) calls getOrCreateRequestId(request), which dereferences request.headers (src/lib/admin/request-id.server.ts:44), and the success path passes request into auditEvent for ip/user-agent extraction. The fixture works only because it also supplies `headers: new Headers()`.

**Evidence:** src/app/api/preferences/locale/route.ts:29/35/38/45 call adminErrorResponse(code, status, request); src/lib/admin/errors.server.ts:50 calls getOrCreateRequestId(request); request-id.server.ts:44 reads request.headers. Removing `headers` from the fixture per the comment would crash the 401/403/400 tests.

**Suggested fix:** The route reads .json() and request.headers (request-id + audit), so a minimal shape with both is enough.

<details><summary>Verifier reasoning</summary>

The comment "The route only calls .json(), so a minimal Request shape is enough" demonstrably misstates why the fixture works. The route (src/app/api/preferences/locale/route.ts lines 29/35/38/45/50) passes `request` into adminErrorResponse, which is NOT mocked in this suite (only auth-guard, auth-status, audit.server, and db/database are mocked). adminErrorResponse (src/lib/admin/errors.server.ts:50) calls getOrCreateRequestId(request), which dereferences request.headers (src/lib/admin/request-id.server.ts:44) and uses it as a WeakMap key at line 60 (`requestIds.set(headers, id)`). If `headers: new Headers()` were removed from the fixture as the comment implies is possible, `headers` would be undefined and WeakMap.set(undefined, id) throws TypeError ("Invalid value used as a weak map key"), crashing the 401, 403, and 400 tests. (WeakMap.get(undefined) and the optional-chained headers?.get survive; the unconditional set does not.) The comment also contradicts its own fixture, which supplies `headers: new Headers()` on the very next line — that field is load-bearing, not incidental. The only charitable reading (route.ts directly invokes only request.json()) is literally true of direct method calls but makes the comment's causal conclusion false: the minimal shape that suffices must include headers because the route hands request to unmocked helpers that read request.headers. Severity P2 is correct: it's a misleading test-file comment whose failure mode breaks loudly and diagnosably at test time.

</details>

### `tests/integration/org-scoped-admin-routes.test.ts:17`

**Comment:** ADR-0001 cross-tenant isolation suite (docs/adr/0001-three-tier-access-control.md).

**Actually:** docs/adr/ does not exist. docs/architecture.md line 239 states the standalone ADR files 'have been retired into it' — ADR-0001 now lives in docs/architecture.md under 'Access-control design decisions' (§ADR-0001 — three tiers, one boundary module).

**Evidence:** `ls docs/` shows no adr/ directory; docs/architecture.md:239-241 ('the standalone ADR files have been retired into it', '#### ADR-0001 — three tiers, one boundary module').

**Suggested fix:** ADR-0001 cross-tenant isolation suite (docs/architecture.md § Access-control design decisions, ADR-0001).

<details><summary>Verifier reasoning</summary>

The comment at tests/integration/org-scoped-admin-routes.test.ts:17 cites 'docs/adr/0001-three-tier-access-control.md', but no docs/adr/ directory exists and no file named 0001-three-tier-access-control.md exists anywhere in the repo (verified by glob over the full tree). docs/architecture.md:239 states 'the standalone ADR files have been retired into it' and line 241 contains the heading '#### ADR-0001 — three tiers, one boundary module' under 'Access-control design decisions', exactly as the reviewer described. The only defensible fragment is the 'ADR-0001' label itself, which remains a valid identifier, but the comment gives an explicit file path that is a dead reference — a demonstrable misstatement of where the document lives. Severity P2 is appropriate: stale doc pointer, no functional impact.

</details>

### `tests/security/administrator-organizations.test.ts:10`

**Comment:** Security tests for the Phase-5 organization endpoints (docs/admin-manager.md §14 + §17).

**Actually:** The current docs/admin-manager.md has no §14 at all, and its §17 is "Audit posture (append-only + retention)" — not the security-considerations/test-plan sections the comment points at. §14 "Security considerations" and §17 "Test plan" existed only in the old implementation-plan version of the doc (a89e66f), replaced by the regenerated doc (704b215).

**Evidence:** Grep of docs/admin-manager.md headings shows no "## 14"; "### 17. Audit posture (append-only + retention)" at line 550; git show a89e66f:docs/admin-manager.md has "## 14. Security considerations" and "## 17. Test plan".

**Suggested fix:** Replace the section pointers with current ones, e.g. "(docs/admin-manager.md §4 guarded request pipeline + §12 audit model)", or drop the numbered references.

<details><summary>Verifier reasoning</summary>

The current docs/admin-manager.md has no §14 heading at all (verified by heading grep), and its §17 (line 550) is "Audit posture (append-only + retention)" — about the append-only DB trigger and retention-job exception, not the security-considerations/test-plan content the comment cites. The sections the comment points at ("## 14. Security considerations", "## 17. Test plan") exist only in the old implementation-plan version at a89e66f (lines 698 and 763), whose test-plan security row matches this test file exactly. The test file was added in 31b637a, which predates the doc regeneration in 704b215 that removed/repurposed those sections — so the comment is a stale, now-dangling cross-reference. No alternate copy of the doc (build output, worktrees) has a §14, and no reasonable reading of the current doc rescues the reference. Severity P2 is appropriate: the misstatement is confined to the doc citation; the comment's substantive claims about permission gating and outcome=denied auditing accurately describe the tests.

</details>

### `tests/security/administrator-roles.test.ts:10`

**Comment:** Security tests for the Phase-4 endpoints (docs/admin-manager.md §14 + §17).

**Actually:** Same stale cross-reference: current docs/admin-manager.md contains no §14, and §17 is now "Audit posture (append-only + retention)", not the security-considerations/test-plan sections; those headings existed only in the pre-regeneration doc (a89e66f).

**Evidence:** docs/admin-manager.md heading list (no ## 14; ### 17 = Audit posture); git history of the doc shows the old "## 14. Security considerations" / "## 17. Test plan" were removed in 704b215.

**Suggested fix:** Point at the current sections (e.g. §4 guarded request pipeline + §12 audit model) or remove the numbered references.

<details><summary>Verifier reasoning</summary>

The comment cites docs/admin-manager.md §14 + §17 as the security-considerations/test-plan reference for the Phase-4 endpoint tests. The current doc has no section 14 anywhere (heading numbering jumps 12→17→13→19→20), and its §17 is "Audit posture (append-only + retention)" — about the DB append-only trigger and retention job, unrelated to these endpoint authorization tests. Grep for "Security considerations"/"Test plan" in the current doc returns nothing. The old revision a89e66f did contain "## 14. Security considerations" and "## 17. Test plan", confirming the comment points at pre-regeneration headings that no longer exist. No reasonable reading of the current doc makes the cross-reference correct, so the comment is demonstrably stale. P2 is the right severity: it is a comment-only stale doc pointer with no functional impact.

</details>

### `tests/security/administrator-users-list.test.ts:7`

**Comment:** Security tests for `/api/administrator/users` (docs/admin-manager.md §14 + §17 test plan / "security" layer).

**Actually:** Same stale cross-reference: no §14 exists in the current docs/admin-manager.md and §17 is "Audit posture", not a test plan; the cited "§14 Security considerations / §17 Test plan" structure belongs to the superseded implementation-plan version of the doc.

**Evidence:** docs/admin-manager.md heading grep (no ## 14; ### 17 = Audit posture, line 550); old headings confirmed via git show a89e66f:docs/admin-manager.md.

**Suggested fix:** Rewrite as e.g. "(docs/admin-manager.md §4 guarded request pipeline + §12 audit model)" or drop the section numbers.

<details><summary>Verifier reasoning</summary>

The current docs/admin-manager.md contains no §14 heading at all, and its only section 17 is "### 17. Audit posture (append-only + retention)" (line 550) — not a test plan. The comment's cited structure ("§14 + §17 test plan / 'security' layer") matches exactly the superseded implementation-plan version of the doc (git a89e66f: "## 14. Security considerations" and "## 17. Test plan" with a "Security (tests/security/)" layer row), which was rewritten in place and survives nowhere else in the repo. The only occurrence of "§14" in the current doc is itself a dangling internal reference (line 110), which corroborates rather than refutes the staleness. No reasonable reading of the current doc makes the cross-reference resolve. Severity P2 stands: the substantive half of the comment (security tests for /api/administrator/users, authorization/audit boundary) is accurate; only the doc section citation is stale, with no behavioral impact.

</details>

### `tests/unit/navigation-server.test.ts:7`

**Comment:** The DB-backed `loadApplicationsMenu` / `loadShellMenu` / `loadNestedAppsMenu` functions are exercised by the navigation route integration tests

**Actually:** Only loadApplicationsMenu is DB-backed (it queries app_enterprise_applications via kysely). loadShellMenu and loadNestedAppsMenu never touch the database — they filter the static DEFAULT_SHELL_MENU / DEFAULT_NESTED_MENU manifests through filterMenuByPermissions and load translation catalogs via dynamic import.

**Evidence:** src/lib/navigation.server.ts: loadApplicationsMenu (lines 69-106) is the only loader calling db.selectFrom; loadShellMenu (115-138) and loadNestedAppsMenu (148-171) build items from the module-level static arrays DEFAULT_SHELL_MENU (196-262) and DEFAULT_NESTED_MENU (264-272) plus shellTranslator, with no db access. The integration-test cross-reference itself is valid (tests/integration/navigation-menus.test.ts exists).

**Suggested fix:** Change to: "`loadApplicationsMenu` (DB-backed) plus the static-manifest `loadShellMenu` / `loadNestedAppsMenu` loaders are exercised by the navigation route integration tests"

<details><summary>Verifier reasoning</summary>

Only loadApplicationsMenu is DB-backed: it queries app_enterprise_applications via db.selectFrom (src/lib/navigation.server.ts:73-86). loadShellMenu (lines 115-138) and loadNestedAppsMenu (lines 148-171) never touch the database — they filter the module-level static manifests DEFAULT_SHELL_MENU (196-262) and DEFAULT_NESTED_MENU (264-272) through filterMenuByPermissions and resolve labels via shellTranslator (dynamic locale-catalog imports, lines 20-32). loadNestedAppsMenu's own doc comment states it 'Currently returns the static set' and that 'Real implementations would join app_enterprise_applications', and loadShellMenu's says the menu 'is built server-side from a static manifest' — the source directly contradicts the test comment's 'DB-backed' label for those two functions. No reasonable reading rescues the comment: the adjective grammatically covers all three coordinated names, and a module-level `import { db }` does not make a function that never uses it DB-backed. (Additionally, the referenced integration test tests/integration/navigation-menus.test.ts mocks all three loaders with vi.fn(), so the loaders are arguably not 'exercised' there either — a separate tests/unit/navigation-server-loaders.test.ts covers them — making the comment wrong beyond even the reviewer's claim.) Severity P2 is correct: a misleading doc comment in a test file with no runtime impact.

</details>

## Refuted candidates (kept for the record)

### `src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-detail-tabs.tsx:18`

**Claimed-wrong comment:** The Roles, Memberships, Sessions, and Audit tabs own their own data fetches so heavy reads only happen when the user opens that tab.

**Why refuted:** The reviewer's evidence is factually correct (the Groups tab exists at _user-detail-tabs.tsx lines 73/114-116 and _user-groups-panel.tsx fetches /api/administrator/users/[id]/groups at lines 57-78), but the comment is not wrong. Every claim it makes is true: Roles, Memberships, Sessions, and Audit panels each own their own client-side fetch, deferred until the tab is opened (Radix Tabs only mounts active content), and Overview renders only RSC-streamed data. The comment never asserts the list is exhaustive ("only these tabs fetch"), and the omitted Groups tab behaves identically to the listed tabs — its own docstring says its fetch-list pattern mirrors _user-sessions-panel.tsx — so the comment's described mechanism applies uniformly and misleads no one. This is a stale/incomplete enumeration (a one-word doc polish), not a misstatement of what the code does.

### `vitest.config.ts:11`

**Claimed-wrong comment:** Coverage thresholds enforce the §29.2 gates.

**Why refuted:** The reviewer conflates the §29.2 *target* with the §29.2 *gates*. Specs.md §29.2 ("Coverage gates", lines 3047-3076) explicitly states: "The long-term coverage **target** is 90% lines/statements/functions and 82% branches. The CI **gate** is implemented as a **ratchet**: thresholds are pinned just below the current measured coverage and only ever move up... The enforced values live in vitest.config.ts." Its own code sample is commented "Ratchet — pinned just below current coverage; target is 90/90/90/82." So per the spec's own definition, the §29.2 gate IS the ratchet, and the thresholds block at vitest.config.ts lines 132-137 (61/60/56/54) is exactly that enforced gate — the header comment "Coverage thresholds enforce the §29.2 gates" is accurate. The inline comment at lines 120-131 does not contradict the header: it says the §29.2 spec *target* (90/90/90/82) was never enforced, preserving the same target-vs-gate distinction. The plural "gates" is further supported by §29.2's "Additional gates" (items 1-4), which the config's exclusion comments explicitly reference (§29.2.2 pure barrel exports, §29.2.3 shadcn exemption). The comment is not merely defensible under a charitable reading — it is the correct reading of the spec.

### `src/db/seeds/seed-local.ts:78`

**Claimed-wrong comment:** Platform sign-up defaults (0007): a new member is ACTIVE once they VERIFY their email ...

**Why refuted:** The reviewer misreads "(0007)" as a file reference. In this repo, "(0007)" is the ubiquitous house-style identifier for the per-org sign-up-policy feature, originally introduced by a real migration 0007 (commit d953632, "feat(auth): runtime-configurable per-organization signup policy") and later consolidated into 0001-initial-schema.sql (commit 383177b). Roughly 50 references across specs.md, docs/architecture.md, docs/admin-manager.md, docs/auth-signup-policy.md, src/lib/auth.ts, src/lib/auth-policy.server.ts ("seeded by 0007"), src/lib/user-provisioning.server.ts, API routes, components, and tests all use "(0007)" the same way, post-consolidation. The seed comment itself explicitly and correctly attributes the platform-default row insert to 0001-initial-schema.sql (seed-local.ts lines 83-84, matching the insert at 0001-initial-schema.sql:879-884), so it makes no false claim about which file creates the row. The comment accurately describes what the code does (relaxing the fail-closed platform default to verify-then-active on the organization_id IS NULL row) and uses the feature label consistently with the rest of the codebase; it is defensible under the repo's dominant reading.

### `tests/unit/navigation-server-loaders.test.ts:5`

**Claimed-wrong comment:** DB-backed unit tests for `navigation.server.ts > loadApplicationsMenu`, `loadShellMenu`, and `loadNestedAppsMenu`. The query builder is stubbed so we can assert the envelope shape...

**Why refuted:** The reviewer's source-code observation is correct (only loadApplicationsMenu queries the DB; loadShellMenu/loadNestedAppsMenu filter static manifests in src/lib/navigation.server.ts), but the comment does not demonstrably misstate the code. Every concrete claim in the header is true: the file tests exactly those three functions, the query builder IS stubbed (lines 11-24), and the three listed assertion targets (envelope shape, SSO launch URL encoding, server-side item filtering) all correspond to real assertions. Critically, the DB stub is load-bearing for ALL tests in the file, not just loadApplicationsMenu: navigation.server.ts imports db from @/db/database at module level, and src/db/database.ts creates a real PostgreSQL pool at import time, so even the static-manifest tests cannot import the module without the vi.mock. "DB-backed unit tests ... the query builder is stubbed" is therefore a defensible description of the suite's setup — unit tests over a DB-coupled module run against a stubbed query builder — rather than a per-function claim that all three loaders execute queries. Additionally, loadNestedAppsMenu's own production docstring describes its envelope as a placeholder mirroring a future app_enterprise_applications join, so the DB-backed framing even matches stated design intent. At worst the adjective is slightly loose; it is defensible under the natural reading and misleads no one, since the very next sentence pins down the stubbed-DB relationship and the tests make the static filtering explicit.

### `tests/integration/user-app-roles.test.ts:9`

**Claimed-wrong comment:** The target user is already org-scoped by `resolveTargetUser` (covered in user-target.server tests, mocked here).

**Why refuted:** The comment makes two claims: (1) the target user is org-scoped by resolveTargetUser, and (2) that resolution is covered by tests elsewhere, so mocking it here is safe. Claim (1) is verified true: src/lib/admin/user-target.server.ts:64 embeds canAccessUser and returns 404 on an out-of-scope target. Claim (2) is defensible, and the reviewer's central evidence for rejecting it is factually wrong. The reviewer asserts "No test file exercises the real user-target.server — every reference to resolveTargetUser in tests/ mocks it." But that grep only finds suites that mock it BY NAME; at least four suites run the REAL user-target.server unmocked because they import users/[id]/* route handlers (which call resolveTargetUser) while mocking only auth-guard/auth-status/db: tests/integration/administrator-user-actions.test.ts, tests/integration/administrator-phase7.test.ts, tests/integration/administrator-role-route.test.ts, and tests/security/administrator-roles.test.ts (none contain a vi.mock of user-target.server). administrator-user-actions.test.ts explicitly pins the real module's contract — "rejects an invalid id with 400 before hitting the DB" (real isUuid path, lines 236-249) and "returns 404 when the target user does not exist" (real resolveTargetUser 404 envelope, lines 251-265) — and, since it importActual's access-scope.server (overriding only requiresSuperadminForSharedTarget), the real canAccessUser/userHasMembershipInOrg org-scoping code executes for its org-admin actor (organizationId "o-1", non-superadmin). The cross-tenant false branch of the embedded predicate is additionally pinned against a real database in tests/db/access-scope.db.test.ts:157-165, and tests/unit/admin-route-scope-invariant.test.ts pins that handlers route through resolveTargetUser. So the substance of the comment — target resolution and its org-scoping are exercised elsewhere, only stubbed in this file — matches reality; the same file even restates it accurately at lines 38-39 ("Target resolution is exercised elsewhere"). The only imprecision is the shorthand "user-target.server tests": no file literally named user-target*.test.ts exists (confirmed via glob and git history). But read as "the tests of user-target.server('s behavior)" — a natural reading — the phrase points at real, existing coverage of the real module. A comment whose code-behavior claim is correct and whose coverage pointer is accurate under a reasonable reading is not a wrong comment.

### `tests/e2e/invitations.spec.ts:5`

**Claimed-wrong comment:** End-to-end proof of the invitation flow (0008):

**Why refuted:** The reviewer's premise is factually correct (commit 383177b folded 0008-organization-invitations.sql into 0001-initial-schema.sql, so no 0008 migration file exists), but the comment does not point at a migration file — it says "the invitation flow (0008)". "(0008)" is the repo-wide feature identifier for organization invitations: the current tree contains ~45 occurrences of the exact tag, including specs.md itself (lines 56, 122, 1420, 1435, 1642, 2904, 3471, 3680), docs/architecture.md, docs/admin-manager.md, and ~30 source/test files (src/lib/auth.ts:193, src/lib/user-provisioning.server.ts:67, src/app/api/invitations/accept/route.ts:16, etc.). The consolidation commit deliberately left all of these intact, showing the project treats (0008) as the feature's canonical spec tag, not a file path. Under this dominant, clearly reasonable reading the comment is accurate: it identifies which spec'd feature the e2e test proves, and everything it describes matches the test body. Flagging this one comment would equally condemn the spec and dozens of other files; the comment is defensible, so the claim is refuted.

## Batch notes

- **lib-core:** Slice \"lib-core\": 31 top-level src/lib/*.ts + 2 src/lib/account/*.ts + 1 src/lib/forms/*.ts = 34 files, matching the expected count; none were auto-generated, so nothing was skipped. Highest-value finding is the auth.ts accountLinking comment, which describes better-auth's trustedProviders as enforcing verified-email linking when it actually waives the provider-side emailVerified check for the listed providers — verified against the installed better-auth 1.6.23 dist sources, not docs. One repo-wide observation (not per-file drift): the numbered migrations referenced as (0007)/(0008) throughout comments were squashed into the single frozen 0001-initial-schema.sql; the tags survive as design-milestone vernacular in docs/, so individual occurrences were not flagged, but anyone hunting for a literal 0007 migration file will not find one.
- **lib-admin-api:** Slice 'lib-admin-api': 24 files under src/lib/admin/** plus 13 under src/lib/api-auth/** = 37, matching the expected count. No auto-generated files found (the generated SDK lives under sdk/, outside this slice). Security/permission claims (requireAdminPermission gating, org-scope 404-vs-403 contracts, CSRF origin-guard bearer exemption, superadmin marker semantics, ban-status AUTH-1 chokepoint) were all verified against src/lib/auth-status.ts, src/lib/trusted-origins.ts, route handlers, and migrations, and found accurate. The two reported findings are documentation drift only; neither describes a code defect.
- **lib-misc:** Batch "lib-misc": glob over src/lib/docs/**, src/lib/email/**, src/lib/observability/**, src/lib/validation/** yields 29 .ts files (8 docs, 4 email, 5 observability, 12 validation), slightly under the ~34 estimate; no exclusions applied since none were auto-generated. Every file read in full; cross-file/security claims (permission scoping, token guarding, sanitize ordering, better-auth hook behavior, migration layout) were followed to their implementations. The one P1 (providers.server.ts) is a pre-D1-worker comment: trusting it would make a reader believe a single provider timeout terminally fails an email, when the row is actually retried up to 5 times.
- **api-admin:** Slice count matched exactly (50 .ts files under src/app/api/administrator/**, all route.ts handlers; none auto-generated, none skipped). All 'Caller MUST hold <perm>' claims were checked against the actual requireAdminPermission key in each handler and all matched. ADR-0001 org-scoping comments were verified against resolveOrgScope/canAccessOrg/canAccessUser semantics in src/lib/admin/access-scope.server.ts and matched in every route, including the null-scope='empty, never all' convention. The three P1s are the only comments found to contradict behavior; the two P2s are a copy-paste sentence and a stale/meaningless purpose comment.
- **api-rest:** Batch "api-rest": all 34 .ts files under src/app/api/** excluding src/app/api/administrator/** were read in full; none are auto-generated. No findings survived the verification standard — this surface's comments are unusually accurate, including all security/permission claims. One out-of-slice stale reference discovered while verifying: src/lib/api-auth/v1-guard.server.ts:39 has a JSDoc {@link requireApiAccount} but no function of that name exists anywhere in src/ (the self-service surface actually uses requireAccountUser from src/lib/account/guard.server.ts); the lib-slice auditor should pick that up. Grep output artifact note: ripgrep occasionally rendered a leading '//' as '\\' in match context (e.g. invitations.server.ts:194); verified via Read that the sources are normal '//' comments.
- **pages-admin-a:** Root cause of most P2s: docs/admin-manager.md was regenerated/renumbered in commit 704b215 (old plan numbering: §8.2 Users, §8.3 New user, §8.4 User detail, §8.5 Roles, §8.6 Role detail, §19 Phased delivery), but ~28 code comments across this slice still cite the old numbers. They are grouped into 7 findings (one per stale target section), with every affected sibling file:line enumerated in the evidence — a mechanical repo-wide fixup pass is the right remedy, likely also outside this slice. Notably, the impersonate button's refs (§19 Phase 7, §13 row actions) align with the NEW numbering and are correct. Two latent CODE bugs (not comment drift) surfaced during verification: (1) _group-roles-editor.tsx fetches roles with a bare `organization=` param the API ignores (must be `filter[organization]=`), so its catalog is unscoped server-side (finding 1 documents the comment side); (2) users/new/_new-user-form.tsx VALID_LOCALES = [en,es,fr,uk] offers only 4 of the 8 supported locales in src/config/i18n-config.ts (en,fr,es,uk,pt,zh,hi,ja) — no comment claims parity, so it is not reported as a finding. Also, two OUT-OF-SLICE route-file header comments carry the same wrong claims as in-slice findings and should be fixed together: src/app/api/administrator/users/route.ts:152-153 ('in a single transaction') and src/app/api/administrator/groups/[id]/members/route.ts:101-102 ('silently dropped' — a fully-ineligible batch actually 404s).
- **pages-admin-b:** Slice contained 40 files (prompt estimated ~41; the enumeration excludes users/, groups/, organizations/, roles/ as instructed). Dominant systemic drift: docs/admin-manager.md's §8.x area numbering was reshuffled (current: 8.1 Users, 8.3 Memberships, 8.5 Permissions, 8.7 Enterprise applications, 8.8 API keys, 8.10 Audit, 8.11 Audit explorer, 8.12 Email) while ~19 comments still cite the old numbering (overview→§8.1, permissions→§8.7, enterprise-apps→§8.10, api-keys→§8.12, memberships→§19); a single sweep fix is recommended. Note the same stale numbering also exists in files OUTSIDE this slice (e.g. src/app/api/administrator/** route headers) — worth a repo-wide pass. The P0 in _roles-using-sheet.tsx is really a code bug (dot vs bracket filter syntax); a background fix task (task_9172a6e2) was spawned. permissions/new/_new-permission-form.tsx:20 cites 'plan §8.7' — references the historical plan document rather than docs/admin-manager.md, so it was left unflagged as unverifiable.
- **pages-auth-public:** Slice batch pages-auth-public: 26 files enumerated (12 (auth), 6 (public), 2 (root), 2 [locale] top-level, 2 (secure) top-level + 1 _components, 1 global-error) — matches the expected count. Comment hygiene in this slice is very high; the single finding is the (secure)/error.tsx purpose comment, verified against both the layout code and the installed Next.js 16.2.10 renderer source rather than docs alone. The sibling (auth)/(public) error.tsx comments make no same-segment-layout claim and are accurate.
- **pages-secure-rest:** Slice: 30 files under src/app/[locale]/(secure)/app/ excluding administrator/ (account/ 16, docs/ 8, workspace/ 2, dashboard/ 1, plus app-level page.tsx, error.tsx). Every file read in full; all cross-file security/permission claims (auth-guard, auth-status shell.view baseline and superuser expansion, api-key scope grantability, self-scoped account/me API routes, docs visibility filtering and sanitize pipeline) were followed to their implementations. The many 'spec §17.x'/'§28.4'/'P2-x' references follow a repo-wide convention pointing at an external integration spec / review-finding ids and were not treated as verifiable file references; the docs/admin-manager.md §12 reference in error.tsx WAS verifiable and is stale (reported).
- **components-ui:** Batch components-ui: 57 files, all read in full. Most files are stock shadcn/ui ports with no comments at all (accordion, avatar, breadcrumb, badge, checkbox, popover, tabs, switch, etc.); comment density is concentrated in the locally modified files (sidebar, flexsidebar, dialog-manager, form, sheet, card, alert, button, select, table). No auto-generated headers found, so nothing was skipped. No P0/P1 findings: all security-adjacent claims (aria/labelling, provider mounting in the secure tree, no-auth-data claims) checked out. The three P2s are stale cross-file/usage claims and one third-party-behavior drift (AlertDialog overlay click).
- **components-rest:** Batch components-rest: 53 files (all .ts/.tsx under src/components/** excluding src/components/ui/**), all read in full; none auto-generated. No stale TODO/FIXME markers exist in this slice. Spec-section references (§10, §13, §14.1, §16.5, §17.x, §21, §25, AUTH-4, P2-n audit ids) were treated as unverifiable document citations unless they made a concrete code claim; every concrete cross-file claim (routes, guards, flags, store defaults, CSP) was opened and checked — results split between findings and confirmedCorrect.
- **core-infra:** Batch core-infra. Enumerated 42 in-scope files (the ~32 estimate excluded the 12 .sql files under src/db/migrations, which src/db/** pulls in). Recurring theme: the core migration series was recently squashed into a single 0001-initial-schema.sql — run-migrations.ts was updated but provision.ts ('0001 … 0010'), seed-local.ts ('0007'), and an in-file 'see 0005' cross-reference were not, and the squashed baseline's permission-catalog insert was never extended with the admin.groups.* keys that ADMIN_PERMISSION_CATALOG (which it claims to mirror) now contains — that one is the P0. All security-claim comments in proxy.ts, permissions/guard references, and the audit append-only trigger rationale were verified against the actual implementations and hold.
- **tests-unit-a:** Slice = tests/unit basenames a–i: 56 files (prompt estimated ~45; glob is exact, no auto-generated headers found, nothing excluded). Most comments in these files describe contracts that the tests themselves assert, so drift would fail CI; verification focused on comments making claims about production code, cross-file references, and magic values. The single surviving finding is a comment inside auth-status.extra.test.ts that names the wrong membership value and wrongly claims no explicit branch matches; the described outcome (pending_approval) is still correct, so it is P1 not P0.
- **tests-unit-b:** Slice count is 35, not the estimated ~46: tests/unit contains 92 .ts files total (flat, no subdirectories — verified with both tests/unit/*.ts and tests/unit/**/*.ts globs), and the j–z/non-letter basename filter matches 35 of them; the a–i complement holds 57, so the orchestrator's even-split estimate was off, not the glob. No skipped or auto-generated files. This slice is test code, so review focused on comments claiming production behavior; the vast majority were verified accurate against the implementation, and the only drift found is the duplicated \"DB-backed\" mischaracterization of loadShellMenu/loadNestedAppsMenu in the two navigation test headers. Notably, migration-plan.test.ts's \"single consolidated 0001-initial-schema.sql\" comment is CORRECT and supersedes older external notes claiming core migrations 0001-0009.
- **tests-component:** Batch "tests-component": Glob matched exactly 50 .tsx files under tests/component/ (no .ts files). All 50 read in full. No TODO/FIXME/HACK/XXX markers and no eslint-disable/@ts-expect-error suppressions exist anywhere in the slice. Every security/permission claim (admin.groups.delete, admin.groups.assign, admin.roles.assign, server-side org-scope forcing, invitation pre-verification, autoSignInAfterVerification, DOMPurify/foreignObject sanitization, anti-enumeration resend behavior) was traced to the production guard/hook/schema code and confirmed accurate, so zero findings are reported.
- **tests-integration:** Slice: all 42 .ts files under tests/integration/**. No P0/P1 findings — every security/permission claim checked against the production guards (auth-status.ts superuser expansion, permissions.server.ts gate, access-scope.server.ts resolveOrgScope/canAccessOrg/canAccessUser, origin-guard on SSO consume, audit.server metadata handling, seeds) held up. The dominant drift pattern is stale documentation references in test file headers: docs/admin-manager.md was restructured (phase test plans removed, sections renumbered into §8.x) and the retired docs/adr/ files were folded into docs/architecture.md, leaving eight test headers pointing at wrong or nonexistent sections. Claims that are directly asserted by the tests themselves (status codes, audit event shapes, rate-limit capacity 30, CSV header row, window-total fallback) were treated as verified by the assertions and spot-checked rather than flagged.
- **tests-misc:** Batch tests-misc: 42 files found (prompt estimated ~43; globs re-checked — tests/e2e 14 incl. helpers/admin-auth.ts, tests/security 13, tests/db 9, tests/accessibility 3, tests/setup 2, tests/helpers 1). All findings are P2 stale cross-references caused by two repo-wide refactors: (1) commit 383177b squashed core migrations 0001-0009 into a single 0001-initial-schema.sql, orphaning every 'migration 0004/0005/0007/0008' mention (all tested behavior verified present in the squashed schema, so only the references drifted); (2) commit 704b215 regenerated docs/admin-manager.md, renumbering §8.1 (Overview→Users) and removing §14 'Security considerations' / repurposing §17 (Test plan→Audit posture). No P0/P1: every security/permission/validation claim checked (origin guard, boundOrg bearer path, shell.view baseline, 60s JWT clamp, org-scoping recorders, seed credentials, CI env) matched the implementation. Borderline non-finding: tests/db/outbox-drainer.db.test.ts:92 says providers.server embeds the error body 'via await res.text()' — it actually embeds truncateBody(await res.text()) capped at 500 chars (providers.server.ts:64,94,103-105); the mechanism claim is still true and the test's Edge-B property is unaffected, so it was not reported.

## Comments confirmed correct despite looking suspicious

<details><summary>305 entries</summary>

- [lib-core] src/lib/auth.ts:90-97 — claim that better-auth honors revokeSessionsOnPasswordReset at runtime but doesn't type it: confirmed for installed v1.6.23 (dist/api/routes/password.mjs:163 deletes user sessions when the flag is set; the identifier appears in no .d.mts).
- [lib-core] src/lib/auth.ts:73-75 and src/lib/env.ts:100-106 — "/sign-in/email at 3 req / 10 s per IP": matches better-auth's default special rules (dist/api/rate-limiter/index.mjs getDefaultSpecialRules: /sign-in* window 10, max 3).
- [lib-core] src/lib/admin-status.server.ts:16-19 — "the /status route and the bulk endpoint both do" gate on admin.users.manage: confirmed (administrator/users/[id]/status/route.ts:61 and users/bulk/route.ts:116-118 via BULK_USER_ACTION_PERMISSIONS); reason max-500 claim matches statusSchema (.max(500)).
- [lib-core] src/lib/navigation.server.ts:244-261 — menu keys match the destination guards: users page.tsx checks admin.users.read (users/page.tsx:29), audit page checks admin.audit.read (audit/page.tsx:25), administrator layout checks ANY_ADMIN_PERMISSION (layout.tsx:48); every icon name used exists in menu-icons.ts MENU_ICONS.
- [lib-core] src/lib/auth-policy.server.ts:121-124 — "mode is CHECK-constrained in the DB": true; 0001-initial-schema.sql initially checks (admin_approval, auto_active) at line 858 but re-creates the constraint including invite_only at line 967.
- [lib-core] src/lib/auth-policy.server.ts:19 — "seeded by 0007": migrations were squashed into 0001-initial-schema.sql (only core migration present), but (0007)/(0008) are project-wide design-milestone tags used identically across docs/, and the platform-default row IS seeded (0001-initial-schema.sql:879); treated as vernacular, not drift.
- [lib-core] src/lib/retention.server.ts:12-14 — revokeJti opportunistic prune + "only writer" claim: confirmed in src/lib/api-auth/revocation.server.ts:13-23; pnpm db:prune / outbox:drain scripts exist in package.json.
- [lib-core] src/lib/retention.server.ts:38-41 — audit append-only trigger with app.audit_retention escape: confirmed in 0001-initial-schema.sql (B3 section, ~line 680-690).
- [lib-core] src/lib/sso.server.ts:75-77 — "route handler then issues the redirect with Referrer-Policy: no-referrer": confirmed (api/sso/launch/route.ts:61); nonce is inserted before signSsoHandoff as claimed.
- [lib-core] src/lib/auth-signup-provisioning.ts — /admin/create-user path exists in better-auth admin plugin (dist/plugins/admin/routes.mjs:130); both seeds (seed-local.ts:26, dev-init.ts:761) set the suppression flag before signUpEmail; OAuth is covered by the session.create hook in auth.ts as claimed.
- [lib-core] src/lib/auth-login-audit.server.ts:5-11 — called from session.create.after (auth.ts:282-286) and backs dailyLogins metrics system-wide + per-org via actor membership join (lib/admin/metrics.server.ts:111-133).
- [lib-core] src/lib/invitations.server.ts:17-18 — "32 base62 chars, ~190-bit" (32×log2 62≈190.5) and SHA-256 at rest via hashSecret: confirmed in lib/api-auth/api-key.ts; /en/invite matches defaultLocale="en".
- [lib-core] src/lib/account/guard.server.ts — bearer-vs-cookie CSRF split, grantedScopes===null for cookies (resolve-caller.server.ts:139), both origin-guard reasons (missing_origin/untrusted_origin) collapsing to one code, and design §10.3 reference: all confirmed.
- [lib-core] src/lib/shutdown.server.ts:62 / src/lib/process-errors.server.ts:17 — both registered from src/instrumentation.ts Node branch as claimed.
- [lib-core] src/lib/env.ts:167-174 — "Phase 1 ignores it (MDX renders as Markdown)": DOCS_ALLOW_MDX_EXECUTION is read nowhere in runtime src/ code.
- [lib-core] src/lib/utils.ts:7-8 — components.json utils alias does point to @/lib/utils.
- [lib-core] src/lib/navigation.server.ts:112-114 — loadShellMenu callers are exclusively the API route handlers (api/navigation/*).
- [lib-admin-api] src/lib/admin/origin-guard.server.ts:21 — ADMIN_TRUSTED_ORIGINS claim verified: src/lib/trusted-origins.ts:35 reads it and src/lib/auth.ts:70 passes getTrustedOrigins() to betterAuth(), so both layers do share one source.
- [lib-admin-api] src/lib/admin/roles.client.ts:9 — 'Tests pin the two implementations' verified: tests/unit/admin-roles-diff.test.ts imports diffPermissions from both roles.server and roles.client and asserts they agree.
- [lib-admin-api] src/lib/admin/rate-limit.server.ts:162 — 'a single bulk request can already touch up to 500 rows' verified: BulkUserRequest ids maxItems 500 in openapi-admin.ts and IdsRequest maxItems 500.
- [lib-admin-api] src/lib/admin/rate-limit.server.ts:170 — 'Exports are heavy (up to 100k rows)' verified: MAX_EXPORT_ROWS defaults to 100_000 in src/app/api/administrator/export/[resource]/route.ts:60.
- [lib-admin-api] src/lib/api-auth/revocation.server.ts:19 — 'This insert is the table's ONLY writer' and 'scheduled pnpm db:prune covers it too' verified: only revocation.server.ts inserts into app_revoked_tokens; retention.server.ts only prunes; package.json defines db:prune.
- [lib-admin-api] src/lib/admin/metrics.server.ts:14 — index claims verified: idx_app_users_created_at_desc, idx_app_audit_events_type_created_at, and idx_app_audit_events_created_at_desc all exist in src/db/migrations/0001-initial-schema.sql.
- [lib-admin-api] src/lib/api-auth/api-key.ts:42 — 'organization invitations, 0008' reuse claim verified: src/lib/invitations.server.ts imports randomBase62 and hashSecret from api-key.ts.
- [lib-admin-api] src/lib/api-auth/api-key.ts:12 — '~190 bits of CSPRNG entropy' verified: log2(62^32) ≈ 190.5 bits.
- [lib-admin-api] src/lib/api-auth/jwt.server.ts:28 — 'SSO_HANDOFF_JWT_SECRET (HS256, 60-second subdomain handoff)' verified: src/lib/jwt-handoff.server.ts uses HS256 and SSO_HANDOFF_MAX_TTL_SECONDS = 60.
- [lib-admin-api] src/lib/api-auth/openapi.ts:5 and src/lib/api-auth/openapi-admin.ts:3 — export-pipeline claims verified: scripts/export-openapi.ts writes docs/openapi.json and docs/openapi-admin.json; package.json wires openapi:export and sdk:admin:generate as described.
- [lib-admin-api] src/lib/admin/permissions.ts:70 — 'shell.view is IMPLIED by an active membership; getUserAccessContext grants it to every active member' verified: src/lib/auth-status.ts adds SHELL_BASELINE_PERMISSION exactly when decideSecureAccess(...) === 'allow'.
- [lib-admin-api] src/lib/admin/overview.server.ts:105 (and 130, 297) — 'global roles are SUPERADMIN-only, matching the roles list route' spot-verified: src/app/api/administrator/roles/route.ts:108 confines org admins to organization_id = their org, excluding NULL-org rows; null scope denies rather than widens.
- [lib-admin-api] src/lib/api-auth/ban-status.server.ts:16 — reference to auth-sso-session.ts verified: src/lib/auth-sso-session.ts exists and treats the banned flag as authoritative.
- [lib-admin-api] src/lib/admin/audit-helpers.server.ts:15 — 'The auditEvent JSDoc spells this out' verified: src/lib/audit.server.ts:46-48 forbids secrets/tokens/passwords in metadata.
- [lib-admin-api] src/lib/admin/auth-admin.server.ts:68 — 'A caller may override by passing data.emailVerified' verified: params.data is spread after the emailVerified:true default, so an explicit override wins.
- [lib-admin-api] src/lib/api-auth/v1-guard.server.ts:26 — 'authorization decision is identical' to requireAdminPermission verified despite the missing isSuperadmin() shortcut: getUserAccessContext expands the superuser marker to the full SUPERUSER_PERMISSIONS set, so the literal permissions.includes() check yields the same outcome; the isSuperadmin branch in permissions.server.ts is redundant belt-and-suspenders, not a behavioral difference.
- [lib-admin-api] src/lib/admin/rate-limit.server.ts:250-256 — actorIdFromRequest 'trusted client IP ... then to a constant' verified: clientIpKey (src/lib/client-ip.ts) returns `ip:<addr>` from a proxy-hop-counted XFF/x-real-ip or the constant 'anon'.
- [lib-misc] src/lib/email/templates.ts:36-41 — migration-layout claim verified: src/db/migrations/locales/ contains exactly 0000-email-templates-en.sql plus 0001-fr, 0002-es, 0003-uk, 0004-pt, 0005-zh, 0006-hi, 0007-ja, and the en file carries all four template keys; translation locales also match src/config/i18n-config.ts locales array.
- [lib-misc] src/lib/email/send.server.ts:44 & :91 — 'org-less row is SUPERADMIN-only' verified: the outbox list route (src/app/api/administrator/email/outbox/route.ts:54-63) filters ORG ADMIN to organization_id = own org (excluding NULL rows) and returns nothing for null scope; only SUPERADMIN reads unfiltered.
- [lib-misc] src/lib/observability/server.ts:13-16 — verified adminErrorResponse (src/lib/admin/errors.server.ts:51-53) and problemResponse (src/lib/api-auth/problem.ts:72-74) both call captureServerError on 5xx with a cause, tagged with request_id.
- [lib-misc] src/lib/observability/metrics.server.ts:6 — 'GET /api/metrics (token-guarded)' verified: src/app/api/metrics/route.ts requires METRICS_TOKEN bearer, constant-time compare, fails closed when unset; rateLimitDenialsTotal is incremented from src/lib/admin/rate-limit.server.ts.
- [lib-misc] src/lib/observability/sentry-shared.ts:8-10 & :37-42 — verified sentry.server.config.ts:17, sentry.edge.config.ts:16, and src/instrumentation-client.ts:23 all set enabled: Boolean(dsn); drk_ API-key prefix (src/lib/api-auth/api-key.ts:20) and drkc_/drkcsec_ OAuth credentials (tests/unit/api-oauth-clients-server.test.ts, docs/design-api-keys-and-tokens.md) are real minted shapes.
- [lib-misc] src/lib/email/outbox-worker.server.ts:18 — 'pnpm outbox:drain' verified: package.json:28 defines the script (scripts/drain-outbox.ts).
- [lib-misc] src/lib/validation/groups.ts:8-10 — verified POST /api/administrator/groups: org admin's client-supplied organizationId is ignored (own org forced), SUPERADMIN without one gets 400 organization_required (route lines 136-150).
- [lib-misc] src/lib/validation/invitations.ts:11-12 & :20 — verified: invitations route lowercases email (organizations/[id]/invitations/route.ts:141) and tokens are 32 base62 chars (invitations.server.ts TOKEN_LENGTH=32, randomBase62).
- [lib-misc] src/lib/validation/auth-policy.ts:11-14 & :46-49 — verified: tests/unit/auth-policy-validation.test.ts exists; sign-up hook stamps emailVerified: true (src/lib/auth.ts:205,221); decideInitialStatus in auth-policy.server.ts honors auto-approve domains only for verified emails (fail-closed mirror at :273).
- [lib-misc] src/lib/validation/organizations.ts:9-14 — SLUG_RE duplication claim verified: identical regex in src/lib/admin/orgs.server.ts:33.
- [lib-misc] src/lib/validation/enterprise-apps.ts:15-16 — verified src/lib/admin/enterprise-apps.server.ts is a server-only re-export shim over ./enterprise-apps.
- [lib-misc] src/lib/validation/account.ts:33-36 — 'Better Auth performs the actual change, so there is no route schema' verified: no /api/account/password route exists (only profile and preferences).
- [lib-misc] src/lib/docs/render/sanitize-schema.ts:14-17 — 'sanitize runs BEFORE slug/anchor/highlight' verified against the plugin order in pipeline.server.ts:191-197.
- [lib-misc] src/lib/email/templates.ts organization_invitation body 'expires in 7 days' — matches INVITATION_TTL_MS = 7 days in src/lib/invitations.server.ts:35.
- [lib-misc] All route paths named in the validation-module headers (POST/PATCH administrator users, permissions, api-keys, groups, organizations, roles, enterprise-apps; PUT email/templates/[id]; organizations/[id]/auth-settings; auth-settings/defaults; PATCH /api/account/profile; PUT /api/account/preferences) verified to exist under src/app/api/.
- [api-admin] src/app/api/administrator/users/[id]/sessions/route.ts:26 — '8h rolling' session bound is correct: src/lib/auth.ts sets session.expiresIn = 60*60*8 with updateAge 15 min
- [api-admin] src/app/api/administrator/organizations/[id]/invitations/[invitationId]/resend/route.ts:23 — 'fresh 7-day window' and 'expired-but-pending is revived' match invitations.server.ts INVITATION_TTL_MS = 7 days and regenerateInvitationToken's status='pending'-only guard with new expires_at
- [api-admin] src/app/api/administrator/email/templates/route.ts:19 — 'Editing a template (PUT [id]) ... is SUPERADMIN-only' confirmed: email/templates/[id]/route.ts PUT rejects non-superadmins with 403
- [api-admin] src/app/api/administrator/users/[id]/audit/route.ts:34 — 'a stricter gate than the page's own admin.users.read' confirmed: users/[userId]/page.tsx guards checkAdminPermissionServer('admin.users.read') while this route requires admin.audit.read
- [api-admin] src/app/api/administrator/metrics/route.ts:11 — 'last 7 days', SUPERADMIN vs ORG ADMIN series split, and 'login series additionally requires admin.audit.read' all match selectDashboardMetrics and DEFAULT_WINDOW_DAYS = 7
- [api-admin] src/app/api/administrator/api-keys/[id]/rotate/route.ts:22 — 'same owner, scopes, and expiry, then revokes the old key — atomically' confirmed: rotateApiKey wraps insert+revoke in one db.transaction copying app_user_id/organization_id/scopes/expires_at
- [api-admin] src/app/api/administrator/organizations/[id]/route.ts:210 — 'Audit rows do NOT reach here — their FK is ON DELETE SET NULL' confirmed: 0001-initial-schema.sql line 808 flips app_audit_events.organization_id to on delete set null
- [api-admin] src/app/api/administrator/users/bulk/route.ts:33 — 'reason required for ban' confirmed: user-actions.server.ts bulkBan returns { error: 'reason_required' } when options.reason is missing
- [api-admin] src/app/api/administrator/email/test/route.ts:20 — 'With no provider configured the email is recorded as logged' confirmed: send.server.ts sets status 'logged' and returns it when no provider is resolved
- [api-admin] src/app/api/administrator/users/route.ts:159 — 'Initial app status defaults to pending_approval' confirmed: createUserSchema initialAppStatus .optional().default('pending_approval')
- [api-admin] src/app/api/administrator/export/[resource]/route.ts:285 — 'an export requested with such a sort falls back to the resource's default order' confirmed: parseListQuery drops disallowed sort fields and substitutes defaultSort when none survive
- [api-admin] src/app/api/administrator/users/[id]/status/route.ts:78 — 'resolveTargetUser already 404s a non-superadmin without a resolvable org' confirmed: canAccessUser returns false when access.organizationId is null, so resolveTargetUser returns 404
- [api-admin] src/app/api/administrator/users/[id]/impersonate/route.ts:29 — 'cookies are delivered by Better Auth's nextCookies plugin' confirmed: src/lib/auth.ts registers nextCookies() (kept last in plugins)
- [api-rest] src/app/api/docs/asset/[...path]/route.ts:14 — 'same audience as the docs viewer' for the shell.view gate: the docs viewer (src/app/[locale]/(secure)/app/docs/layout.tsx + page.tsx) gates via requireSecureSession (active user + active membership), and shell.view is the membership baseline granted in getUserAccessContext, so the audiences are equivalent; the asset route's explicit shell.view check matches.
- [api-rest] src/app/api/invitations/accept/route.ts:34 — '~190-bit token entropy' verified: src/lib/invitations.server.ts documents/generates a 32-char base62 CSPRNG token (~190.4 bits).
- [api-rest] src/app/api/invitations/accept/route.ts:39-44 — claim that the admin CSRF gate collapses both origin-guard reasons to 'untrusted_origin' verified against src/lib/admin/permissions.server.ts:107 and origin-guard.server.ts reasons ('missing_origin' | 'untrusted_origin').
- [api-rest] src/app/api/invitations/accept/route.ts:22-27 — 'Blocked/suspended/deactivated users are refused by consumeInvitation's eligibility rule' verified: src/lib/invitations.server.ts:197-198 returns user_not_eligible unless status is active or pending_approval; email re-check and already_consumed race handling also match the route's branch comments.
- [api-rest] src/app/api/internal/outbox-drain/route.ts:20-29 — Vercel Cron declared in vercel.json (crons → /api/internal/outbox-drain) confirmed; CRON_SECRET fail-closed matches isAuthorized (returns false when unset); drainOutbox re-attempts status='pending' rows (outbox-worker.server.ts:75); '~10s each on a hung provider' matches PROVIDER_TIMEOUT_MS = 10_000 in src/lib/email/providers.server.ts.
- [api-rest] src/app/api/security/csp-report/route.ts:11-18 — 'app-wide CSP is enforcing, nonce-based, minted per request in src/proxy.ts; keeps report-uri/report-to pointed here' verified against src/proxy.ts:63-109 (nonce + strict-dynamic, report-uri /api/security/csp-report, report-to csp-endpoint).
- [api-rest] src/app/api/v1/auth/token/route.ts:31-35 — TOKEN_GLOBAL_LIMIT comment '~5 req/s sustained, 300 burst' matches { capacity: 300, refillPerSec: 5 }; MACHINE-1 comment (issuance gate evaluated against the credential's bound org, consistent with resolveCaller's use-time resolution) verified against getUserAccessContext's boundOrg path in src/lib/auth-status.ts:134-147 which never reads the active_org cookie.
- [api-rest] src/app/api/preferences/active-org/route.ts:12-23 and apply/route.ts:22-30 — 'cookie is a selector, never a grant' verified: src/lib/active-org.server.ts:17-21 (unsigned active_org cookie, membership check is the authority) and getUserAccessContext re-derives access from memberships; apply route's 'provisioning hook has already read the hint' verified against src/lib/auth.ts:331-342 (provisionUserFromAuth reads ORG_SIGNUP_HINT_COOKIE in the session-create hook).
- [api-rest] src/app/api/v1/me/api-keys/route.ts:38-43 — 'Requires the account.apikeys.manage scope (bearer) or a cookie session' verified against src/lib/account/guard.server.ts:79-82: cookie callers have grantedScopes === null and pass the scope check unconditionally; bearer credentials must carry the scope.
- [api-rest] src/app/api/v1/admin/api-keys/route.ts:12-15 and v1/me/api-keys/route.ts:20-23 — 'never returns secrets or hashes' verified: SUMMARY_COLUMNS in src/lib/api-auth/api-keys.server.ts:34-46 excludes key_hash/plaintext.
- [api-rest] src/app/api/v1/admin/* org-boundary comments (SUPERADMIN all orgs / org admin their org / null scope = deny, 404-not-403 on cross-org ids) verified against resolveOrgScope/canAccessOrg/canAccessUser in src/lib/admin/access-scope.server.ts.
- [api-rest] src/app/api/sso/consume/route.ts:69-87,131-143 — GET verifies without burning the nonce and redirects to /[locale]/sso/confirm (page exists: src/app/[locale]/(auth)/sso/confirm/page.tsx); POST burns jti before session establishment and is origin-gated; auth.api.createSsoSession exists via the custom ssoSession plugin (src/lib/auth-sso-session.ts).
- [api-rest] src/app/api/health/ready/route.ts:17-18 — 'pool's connectionTimeoutMillis bounds the check' verified: src/db/database.ts:32 sets connectionTimeoutMillis (PG_CONNECT_TIMEOUT_MS, default 5000).
- [api-rest] src/app/api/v1/jwks.json/route.ts:14-15 — 'empty key set (200) when JWT issuance is disabled' matches the API_JWT_ENABLED || !API_JWT_PRIVATE_KEY branch; env keys exist in src/lib/env.ts:115-133.
- [api-rest] src/app/api/v1/openapi.json/route.ts:10 — 'OpenAPI 3.1' verified: src/lib/api-auth/openapi.ts:57 emits openapi: "3.1.0".
- [api-rest] src/app/api/security/csp-report/route.ts:37 — MAX_BODY_BYTES comment ('a CSP report is < 2 KiB; anything larger is hostile bulk') investigated: the 64 KiB constant is intentionally larger to admit Reporting-API batches, which the header doc states explicitly ('~1.8k into 64 KiB'), so no magic-value mismatch; 'drop it unread' is colloquial for 'unparsed' (the body must be read to measure it), judged not a factual drift.
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:14 — USER_STATUSES 'the only allow-listed status filter values' matches the server's ALLOWED_STATUS set exactly (api/administrator/users/route.ts:44-50 and users/bulk/route.ts:61-67)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:49 — 'Org name(s) … server-scoped to what the caller may see' matches the correlated subquery in api/administrator/users/route.ts:109-122 (org admin sees only their own org's name)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:140-142 — 'Forward the same allow-listed filter set the list endpoint honours' is correct: bulk route re-applies the status allow-list + q exactly like the GET (bulk/route.ts:164-189)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:20-22 — 'the layout already gated the entire /administrator/* tree on any admin permission' verified: administrator/layout.tsx:48 checks ANY_ADMIN_PERMISSION and notFound()s
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:67-68 — ADR-0001 claim verified: canAccessUser (lib/admin/access-scope.server.ts:96-100) requires the target to hold a membership in the caller's org; superadmin bypasses
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/new/_new-user-form.tsx:23-25 — 'the SHARED createUserSchema (the same schema the API route enforces)' verified: api/administrator/users/route.ts imports and parses createUserSchema
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_role-picker.tsx:22-26 — 'org-boundary enforced server-side' verified (roles GET applies resolveOrgScope, route.ts:104-110); 'Mirrors organization-picker.tsx' — the component exists at administrator/_components/organization-picker.tsx
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_group-picker.tsx:22-23 — groups list 'boundary enforced server-side' verified: api/administrator/groups/route.ts:42-50 org-scopes and returns empty on null scope
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-audit-panel.tsx:8-10 — per-user audit endpoint org-scopes rows per ADR-0001 (api/administrator/users/[id]/audit/route.ts:55-61)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-sessions-panel.tsx:11-15 — endpoints exist and DELETE …/sessions/[sessionId] takes the Better Auth session token, matching the panel's use of s.token (route header confirms 'sessionId here is the Better Auth session token')
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_impersonate-button.tsx:33-40 — hard reload to /<locale>/app/dashboard matches window.location.assign in the same file; POST /users/[id]/impersonate route exists and sets cookies server-side
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/groups/new/page.tsx:12-15 and _new-group-form.tsx:24-29 — 'org admin's group is forced into their own org server-side; superadmin must choose (organization_required 400)' verified against groups POST route.ts:136-150; OrganizationPicker rendered without includeGlobal correctly has 'no Global option' (default includeGlobal=false)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor.tsx:17-18 — 'server rejects a foreign/global role (404) and a superuser-granting role for a non-superadmin (403)' verified: groups/[id]/roles route returns role_not_found 404 and forbidden 403 via the unheld-permissions guard (which subsumes the superuser check)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid.tsx:25-26 — 'server confines adds to ACTIVE members of the group's org and applies the privilege-escalation guard' verified (members route status='active' filter + AUTHZ-3 guard); only the added:0 mechanism claim is wrong (reported separately)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/roles/new/_new-role-form.tsx:29-31 — 'an org admin … a global role would be rejected with 403' verified: roles POST route.ts:216-218
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/roles/[roleId]/_role-permissions-editor.tsx:60-62,153-154 — 'capped at 200 by the server' (permissions route maxPageSize:200) and 'POST/DELETE responses both echo the resulting permission list' (both return { ok, permissions: finalKeys }) verified
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/roles/[roleId]/page.tsx:51-53 — 'a global role is SUPERADMIN-only' verified: canAccessOrg returns false for org admins when resourceOrgId is null
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/organizations/_organizations-grid.tsx:23-25 — the canonical organization_not_empty / organization_is_default (and organization_in_use) 409 codes are all really returned by the org DELETE route (via AdminError codes + FK-violation translation)
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/organizations/[orgId]/_organization-invitations-panel.tsx:43-45 — 'resend rotates the token + expiry in place — the old link dies' verified against the resend route ('Rotates a PENDING invitation's token + expiry in place')
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/organizations/page.tsx:45 and [orgId]/page.tsx:86 — the '(0007)' / '(0008)' labels remain canonical: docs/admin-manager.md §8.2 still labels the auth-settings and invitations features 0007/0008 despite the physical migrations being consolidated into 0001-initial-schema.sql
- [pages-admin-a] src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-roles-panel.tsx:23-24 — 'role assignments … scoped per ADR-0001 by the /roles endpoint' verified: users/[id]/roles route applies resolveOrgScope; app-roles POST/DELETE enforce 404-for-foreign-org and 403 escalation guards as the comment implies
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:31 — idx_app_audit_events_created_at_desc really exists in src/db/migrations/0001-initial-schema.sql:333
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:24-27 — the filter list (event_type, outcome, actor, app_user_id, organization_id, target_application_id, created_at range) exactly matches the audit route's allowedFilters
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:192-194 — `failure` is documented as a deprecated alias of `error` in docs/admin-manager.md §12 (lines 14-16 of that section)
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-selection.ts:15,27 — users/bulk route caps at MAX_BULK_IDS=500 and accepts ids: "*" exactly as described
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-toolbar.tsx:111 — the `# export_truncated:` sentinel is really appended by src/app/api/administrator/export/[resource]/route.ts:213
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/layout.tsx:32-36 — own SidebarProvider with separate cookie (administrator_sidebar_state) and keyboardShortcut={null}, matching the sidebar's header comment
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/administrator-navigation.ts:5-9 — every icon name used (home, users, shield, key-round, users-round, building-2, app-window, key-square, mail, mail-open, scroll-text) exists in the MENU_ICONS allow-list in src/components/navigation/menu-icons.ts
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page.tsx:57-59 — canAccessOrg (access-scope.server.ts:66-70) confirms a null resource org is superadmin-only and 404-on-false is the documented contract
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/organization-picker.tsx:22-28 — picker is rendered only when isSuperadmin(guard.access) (groups/new & roles/new pages) and the groups POST route ignores client organizationId for org admins ('server forces their own org')
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/api-keys/new/_new-api-key-form.tsx:29-32 — API route really returns 404 owner_not_found, 409 owner_inactive, 422 with ungrantableScopes; rotate returns { key } with 201
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/api-keys/_api-keys-grid.tsx:28 — 'status + owner filter toolbar': status select plus free-text q that ilikes owner primary_email (placeholder 'Name, prefix, or owner email'); acceptable
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/_template-edit-form.tsx:29-31 — variable values are entity-escaped at render (escapeHtml in src/lib/email/templates.ts:469-498)
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/email/page.tsx:12-15 — app_outbox is the real table (0001-initial-schema.sql:236) and 'logged' is a real status in the outbox grid/status filter
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/page.tsx:79-81 — getUserAccessContext is wrapped in React cache() (src/lib/auth-status.ts:112), so the re-read is request-cached as claimed
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/page.tsx:112-114 — admin.users.sessions is a real catalog permission and session rows do carry ipAddress (overview.server.ts:258)
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/page.tsx:120-123 — selectDashboardMetrics is shared with GET /api/administrator/metrics (route imports it), and auditEventsDaily/mostActiveOrgs are populated only in system (superadmin) scope
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid-filters.tsx:16-21 — parseListQuery drops non-allow-listed filters and every list route re-derives org scope via resolveOrgScope (ADR-0001, defined in docs/architecture.md per docs/README.md)
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/enterprise-apps/_enterprise-apps-grid.tsx:23-25 — DELETE really returns 409 application_in_use (enterprise-apps/[id]/route.ts:224)
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/permissions/_permissions-grid.tsx (409 handling) — permissions/[id] DELETE returns 409 permission_in_use as the grid expects
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/loading.tsx:9 — common.loading exists in src/messages/en.json
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx:57-58 — /api/administrator/users/[id]/audit exists and users/[userId]/_user-audit-panel.tsx reuses AdministratorAuditGrid
- [pages-admin-b] src/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-state.ts:42-45 and list-query.server.ts — '.'-separator sort format matches on both sides; §10 'URL as state' exists in docs/admin-manager.md
- [pages-auth-public] src/app/[locale]/layout.tsx:74 — CSP-nonce comment confirmed: src/proxy.ts mints a per-request nonce, sets x-nonce request header, and dev policy keeps 'unsafe-inline' (proxy.ts lines 87-115, 167-171)
- [pages-auth-public] src/app/[locale]/(secure)/layout.tsx:29-33 — 'guaranteed active with an active membership' confirmed: decideSecureAccess (src/lib/auth-status.ts:70-80) returns allow only for status=active AND membership=active; requireSecureSession redirects on every other decision
- [pages-auth-public] src/app/[locale]/(secure)/layout.tsx:62-63 — active org resolved from active_org cookie inside getUserAccessContext confirmed (src/lib/auth-status.ts:154-177, readActiveOrgId cookie path)
- [pages-auth-public] src/app/[locale]/(secure)/layout.tsx:39-45 — sidebar_state cookie written by provider (src/components/ui/sidebar.tsx:39,117) and fixed 16rem/3rem column via .sh-grid:has rule (src/styles/app-shell.css:35,92-94) both confirmed
- [pages-auth-public] src/app/[locale]/(secure)/_components/secure-sidebar.tsx:22-31 — /api/navigation/shell-menu exists, filters server-side by caller permissions (route.ts + loadShellMenu), and menu hrefs arrive locale-prefixed (src/lib/navigation.server.ts:127,160)
- [pages-auth-public] src/app/[locale]/(auth)/sso/confirm/page.tsx:8-22,75-77 — confirmed against src/app/api/sso/consume/route.ts: GET verifies without nonce burn and redirects to the interstitial; POST is checkTrustedOrigin-guarded, burns the jti, establishes the session
- [pages-auth-public] src/app/[locale]/(auth)/invite/page.tsx:14-27 — branching confirmed: findValidInvitationByToken returns null for unknown/consumed/revoked/expired (src/lib/invitations.server.ts:129-151); guest panel carries token to sign-up and returnTo back to invite; mismatch panel never receives the invited email; accept posts to /api/invitations/accept (invite-accept-form.tsx:26)
- [pages-auth-public] src/app/[locale]/(auth)/verify-email/confirmed/page.tsx:7-9 — autoSignInAfterVerification: false confirmed in src/lib/auth.ts:131 with callbackURL to verify-email/confirmed
- [pages-auth-public] src/app/[locale]/(auth)/sign-in/page.tsx:11-13 — getSafeReturnTo (src/lib/safe-return-to.ts) blocks absolute/protocol-relative/backslash URLs and auth/status pages as claimed
- [pages-auth-public] src/app/[locale]/(auth)/sign-in/[org]/page.tsx:9-15 — SignInForm pins the active org via buildActiveOrgApplyPath callbackURL and carries ?org onto the sign-up link (sign-in-form.tsx:42-43,78-79)
- [pages-auth-public] src/app/[locale]/(auth)/sign-up/page.tsx:22-25 — invitation token rides the sign-up body and invalid tokens silently render the normal form, confirmed in sign-up-form.tsx:44-99 and the page's null-fallthrough
- [pages-auth-public] src/app/[locale]/(public)/page.tsx:41-54 — HERO_SCREENSHOT_LOCALES exactly matches public/front1-{en,es,fr,hi,ja,pt,uk,zh}.avif on disk; docs/product-overview.md exists
- [pages-auth-public] src/app/[locale]/(public)/logged-out/page.tsx:7-8 — SignOutButton defaults its post-logout redirect to /{locale}/logged-out (sign-out-button.tsx:26)
- [pages-auth-public] src/app/global-error.tsx:11 — referenced (secure)/app/error.tsx exists
- [pages-auth-public] src/app/[locale]/not-found.tsx:9 — '~50 notFound() call sites' holds: 69 grep occurrences across 35 files including import lines, ≈50 real call sites; ADR-0001 404-not-403 pattern documented in docs/architecture.md
- [pages-auth-public] src/app/[locale]/(auth)/forgot-password/page.tsx:9-11 — ForgotPasswordForm passes redirectTo into authClient.requestPasswordReset so the emailed link lands on the localized /reset-password page
- [pages-auth-public] src/app/[locale]/(auth)/reset-password/page.tsx:9-11 — ResetPasswordForm shows a /forgot-password link for a missing/invalid token (reset-password-form.tsx:66-70)
- [pages-auth-public] src/app/[locale]/(auth)/pending-approval/page.tsx:8-10 — PendingApprovalPanel renders card + SignOutButton only; no secure shell or menu API calls
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/_components/permissions-card.tsx:9 — 'expanded to the full set for superusers by getUserAccessContext' confirmed: src/lib/auth-status.ts expands the bare `superuser` marker to SUPERUSER_PERMISSIONS (lines ~229-244).
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/_components/account-sidebar.tsx:28 — 'Sections require the baseline shell.view (user-level)' confirmed: all ACCOUNT_SECTIONS entries require shell.view, and auth-status.ts grants shell.view as a membership baseline (line 214-227).
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/api-keys/page.tsx:19 — 'the me create endpoint re-validates every requested scope against the same rule (ungrantableScopesForCaller)' confirmed: src/app/api/v1/me/api-keys/route.ts:80 calls ungrantableScopesForCaller; src/lib/api-auth/scopes.ts:148 implements the identical account-scopes-always/other-scopes-require-permission rule for cookie sessions.
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/api-keys/_api-keys-panel.tsx:18 — 'self-scoped, no user id, secrets surfaced exactly once' confirmed: GET/POST in api/v1/me/api-keys/route.ts key rows on the guard actor's appUserId, accept no id, and return plaintext only on create (201) with { key }; 403 body carries ungrantableScopes exactly as the panel parses.
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/security/_password-form.tsx:28 — 'changePasswordSchema adds the new/confirm match surfaced on the confirm field; the unrefined passwordFieldsSchema drives required markers' confirmed in src/lib/validation/account.ts:38-46 (.refine with path ['confirmPassword']).
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/layout.tsx:16 and docs/layout.tsx:16 — 'gates only on requireSecureSession … which the (secure) layout already guarantees' confirmed: src/app/[locale]/(secure)/layout.tsx:56 calls requireSecureSession; src/lib/auth-guard.ts:55-76 validates session + active user + active membership and redirects on failure; neither layout checks admin.*.
- [pages-secure-rest] src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:17 — layered-security claims confirmed: canViewDoc filters per-doc visibility/requires (src/lib/docs/catalog.server.ts:102), and filesystem-source getDocument returns null for unresolvable/traversal slugs (filesystem-source.server.ts:93-95) → notFound().
- [pages-secure-rest] src/app/[locale]/(secure)/app/docs/_components/docs-toc.tsx:7 — 'headings the render pipeline collected (depths 2–4)' confirmed: pipeline.server.ts:76 skips depth < 2 || > 4.
- [pages-secure-rest] src/app/[locale]/(secure)/app/docs/_components/doc-article.tsx:12 — 'HTML already through rehype-sanitize' and 'pipeline extracts ```mermaid fences before the syntax highlighter' confirmed: pipeline.server.ts plugin order rehypeSanitize (191) … rehypeMermaid (196) before rehypePrettyCode (197).
- [pages-secure-rest] src/app/[locale]/(secure)/app/workspace/layout.tsx:11 — 'nested CSS variables automatically via data-variant="nested"' confirmed: ApplicationShell passes variant="nested" and shell-grid-container.tsx:52 renders data-variant={variant}.
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/_sections.ts:26 — 'Keys used here MUST exist in that map' confirmed: circle-user, id-card, settings, shield, key-square (and file-text for docs) all present in src/components/navigation/menu-icons.ts.
- [pages-secure-rest] src/app/[locale]/(secure)/app/error.tsx:9 — 'captured to Sentry with a quotable Support ID' confirmed: src/components/observability/route-error.tsx calls Sentry.captureException and displays the event id or digest.
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/profile/_profile-form.tsx:24 — 'the same schema /api/account/profile enforces … endpoint self-scoped (no id sent)' confirmed: profile route.ts parses updateProfileSchema and writes only via actor.appUserId / auth.api.updateUser on the current session.
- [pages-secure-rest] src/app/[locale]/(secure)/app/account/preferences/_preferences-form.tsx:21 — 'the same schema /api/account/preferences enforces' confirmed: preferences route.ts PUT parses updatePreferencesSchema.
- [components-ui] src/components/ui/flexsidebar.tsx:3 — header claims the stock shadcn Sidebar forces min-h-svh on the provider wrapper, uses a fixed-position full-viewport panel, and a spacer div: verified in src/components/ui/sidebar.tsx lines 164 (min-h-svh), 280-290 (gap/spacer div), 293 (fixed inset-y-0 h-svh).
- [components-ui] src/components/ui/flexsidebar.tsx:11 — 'contains NO duplicated machinery ... live in ./sidebar' and 'overrides exactly three things': verified — sidebar.tsx exports SidebarStatic/SidebarMobileSheet/provider and flexsidebar overrides only provider sizing, desktop panel, and inset.
- [components-ui] src/components/ui/sidebar.tsx:4 — 'SINGLE SOURCE' header describing the two variants and what FlexSidebar overrides: matches flexsidebar.tsx exactly.
- [components-ui] src/components/ui/sidebar.tsx:41 — 'Widths live as global :root tokens in globals.css (--sidebar-width, --sidebar-width-icon, --sidebar-width-mobile)': verified at src/app/globals.css:26-32 inside :root.
- [components-ui] src/components/ui/sidebar.tsx:701 — SidebarMenuSkeleton 'Varied width between 50 and 90%, derived deterministically from useId': Math.abs(hash) % 41 + 50 yields 50-90 inclusive, no Math.random.
- [components-ui] src/components/ui/sidebar.tsx:73/80 — cookieName and keyboardShortcut JSDoc (own cookie per nested provider; pass null to disable shortcut): code honors both (cookie template uses cookieName; effect early-returns on falsy keyboardShortcut).
- [components-ui] src/components/ui/dialog-manager.tsx:29 — 'provider is mounted once near the top of the secure tree': verified at src/app/[locale]/(secure)/layout.tsx:100.
- [components-ui] src/components/ui/dialog-manager.tsx:48 — 'visually consistent with the existing impersonation confirmation (AlertDialog primitive)': verified — src/app/[locale]/(secure)/app/administrator/users/[userId]/_impersonate-button.tsx uses AlertDialog.
- [components-ui] src/components/ui/dialog-manager.tsx:101 — 'Monotonic instance id — keys the prompt form so a new prompt mounts with fresh input state': verified, promptSeq increments and PromptForm is keyed by state.id.
- [components-ui] src/components/ui/sheet.tsx:8 — 'Used by the application switcher and mobile sidebar drawer': verified — src/components/app-shell/application-switcher-sheet.tsx and SidebarMobileSheet in sidebar.tsx both use SheetContent.
- [components-ui] src/components/ui/alert.tsx:19 — 'used by status pages (pending, blocked) and form validation errors': verified — pending-approval-panel.tsx, blocked-account-panel.tsx, email-password-login-form.tsx, sign-up-form.tsx all render Alert.
- [components-ui] src/components/ui/dialog.tsx:49 — 'English default mirrors SheetContent': both DialogContent and SheetContent default closeLabel to "Close".
- [components-ui] src/components/ui/form.tsx:28 — isFieldRequired doc 'True when the schema's top-level field rejects undefined': code negates field.safeParse(undefined).success exactly as described.
- [components-ui] src/components/ui/form.tsx:200 — FormMessage 'Schema validation messages are validation.* keys, so localize them here': verified — zod schemas use relative keys under the validation namespace (e.g. "passwordsMismatch" in src/lib/validation/auth.ts:40) and t is scoped to "validation", so t.has(raw) matches.
- [components-ui] src/components/ui/form.tsx:23 — 'use the explicit required prop ... e.g. for .refine()-wrapped schemas': verified — a ZodEffects wrapper has no .shape, so isFieldRequired returns false and the explicit prop is indeed the escape hatch.
- [components-ui] src/components/ui/carousel.tsx:54 — 'Scroll affordances are DERIVED from the embla api via useSyncExternalStore ... no setState-in-effect': verified — canScrollPrev/Next use useSyncExternalStore subscribed to select/reInit; no mirroring effect exists.
- [components-ui] src/components/ui/required-legend.tsx:6 — legend text/decorative-asterisk claims: verified — validation.requiredLegend exists (src/messages/en.json:1440), asterisk is aria-hidden, and FormControl in form.tsx sets aria-required.
- [components-ui] src/components/ui/table.tsx:8 — containerLabel JSDoc (focusable labelled region only when passed): verified — role/aria-label/tabIndex are conditionally spread on the overflow-auto wrapper.
- [components-rest] src/components/admin/auth-policy-form.tsx:45 — STRICT_DEFAULTS does mirror FAIL_CLOSED_AUTH_POLICY (auth-policy.server.ts:67-71: verification true, admin_approval, null methods, null domains)
- [components-rest] src/components/admin/auth-policy-form.tsx:73-84 — endpoint/verb claims match: org route exports GET/PATCH/DELETE, platform defaults route exports GET/PATCH only (no DELETE, so 'the baseline row cannot be deleted' is accurate)
- [components-rest] src/components/admin/impersonation-banner-client.tsx:48-51 (P2-1) — verified correct: the DELETE route returns every error status before stopBetterAuthImpersonating runs, so on failure the session is still impersonated
- [components-rest] src/components/admin/impersonation-banner.tsx:25-28 — getImpersonatorId does accept camelCase and snake_case (auth-guard.ts:35-40) and is shared with the stop route (route.ts imports it)
- [components-rest] src/components/auth/invite-accept-form.tsx:7-16 — /api/invitations/accept exists; 403 invitation_email_mismatch is real, and unknown/expired/revoked/consumed tokens all collapse to one 404 invitation_invalid
- [components-rest] src/components/auth/email-verified-panel.tsx + verify-email-panel.tsx + email-password-sign-up-form.tsx — autoSignInAfterVerification: false and sendOnSignUp: true confirmed in src/lib/auth.ts:130-131
- [components-rest] src/components/auth/blocked-account-panel.tsx:16-18 — blocked/suspended/deactivated is exactly BLOCKED_USER_STATUSES (auth-status.ts:29)
- [components-rest] src/components/auth/social-login-buttons.tsx:31-33 — getSafeReturnTo exists (lib/safe-return-to.ts) and is applied server-side (auth-guard.ts:60)
- [components-rest] src/components/app-shell/organization-switcher.tsx:26-29 — /api/preferences/active-org validates ACTIVE membership and returns 404 for non-member orgs as an anti-enumeration choice
- [components-rest] src/components/app-shell/application-switcher-sheet.tsx:30-33 — ssoLaunchUrl really is /api/sso/launch?... (lib/navigation.server.ts:95)
- [components-rest] src/components/app-shell/mobile-sidebar-trigger.tsx:28-31 — aria-controls="navigation" matches ShellLeft's default id="navigation"
- [components-rest] src/components/app-shell/compact-mode-toggle.tsx:21-23 + shell-visibility-toggle.tsx:46-48 — store SSR defaults confirmed: density "compact", all regions visible (stores/app-shell-store.ts:22-24,49)
- [components-rest] src/components/i18n/locale-switcher.tsx:38-41 + language-menu.tsx:38-41 — /api/preferences/locale validates via isSupportedLocale and audit-logs i18n.locale.changed (route.ts:15,45-50,73-74)
- [components-rest] src/components/observability/route-error.tsx:12-15 — Sentry events are tagged request_id from x-request-id (src/instrumentation.ts:45-48), so the correlation claim holds; the eslint-disable react-hooks/set-state-in-effect justification (deps [error], one-time set) still applies
- [components-rest] src/components/theme/theme-provider.tsx:64-66 — CSP does permit inline styles: proxy.ts:101 keeps style-src 'unsafe-inline' as a documented deliberate exception
- [components-rest] src/components/api-keys/api-key-reveal.tsx:15-24 — genuinely shared by both surfaces: used from administrator api-keys grid/new-form and account api-keys panel
- [components-rest] src/components/navigation/menu-icons.ts:30-33 — DEFAULT_SHELL_MENU exists in lib/navigation.server.ts, matching the 'add here AND in DEFAULT_SHELL_MENU' instruction
- [components-rest] src/components/icons/github-icon.tsx:6-7 — lucide-react v1 brand-icon drop matches this repo's Dependabot history (GithubIcon vendored as part of taking lucide v1)
- [core-infra] src/db/migrations/run-migrations.ts:16 — 'Today that is the single 0001-initial-schema.sql' — matches the filesystem (only 0001 + better-auth-schema.sql top-level); this is the updated truth the stale provision.ts/seed-local.ts comments diverge from
- [core-infra] src/db/seeds/dev-init.ts:184 — 'Mirrors DEFAULT_WINDOW_DAYS in src/lib/admin/metrics.server.ts' — that constant exists and equals 7, matching REGISTRATION_WINDOW_DAYS
- [core-infra] src/db/seeds/dev-init.ts:550 — 'Must match LOGIN_EVENT_TYPE in src/lib/auth-login-audit.server.ts' — confirmed, both are 'auth.session.created'
- [core-infra] scripts/prune-retention.ts:13 — 'AUDIT_RETENTION_DAYS (default 365) and OUTBOX_RETENTION_DAYS (default 90)' — matches DEFAULT_AUDIT_RETENTION_DAYS=365 / DEFAULT_OUTBOX_RETENTION_DAYS=90 in src/lib/retention.server.ts
- [core-infra] src/db/migrations/locales/0000-email-templates-en.sql:3 — 'resolveTemplate returns the en row whenever a localized row is absent' — confirmed in src/lib/email/send.server.ts:61-72 (queries [locale, defaultLocale], falls back to the en row)
- [core-infra] src/db/migrations/locales/0000-email-templates-en.sql:43 — invitation body 'expires in 7 days' — matches INVITATION_TTL_MS = 7*24h in src/lib/invitations.server.ts:35
- [core-infra] src/db/database.ts:23-24 — 'the same vars are validated at boot by serverEnvSchema' — PGPOOL_MAX / PG_CONNECT_TIMEOUT_MS / PG_STATEMENT_TIMEOUT_MS / PG_IDLE_IN_TX_TIMEOUT_MS all present in src/lib/env.ts:45-48
- [core-infra] src/proxy.ts:33-60 — org-signup-hint cookie claims — ORG_SIGNUP_HINT_COOKIE exists in src/lib/scoped-auth.ts:27, docs/auth-signup-policy.md exists, and maxAge 600 matches the '10 min' comment
- [core-infra] src/proxy.ts:106 — report sink '/api/security/csp-report' — route exists at src/app/api/security/csp-report/route.ts
- [core-infra] src/db/migrations/0001-initial-schema.sql:690-693 — retention job exception claim — src/lib/retention.server.ts:46 does 'set local app.audit_retention = on' inside a transaction
- [core-infra] src/db/migrations/0001-initial-schema.sql:665-667 — outbox drainer claim — src/lib/email/outbox-worker.server.ts uses FOR UPDATE SKIP LOCKED on pending/next_attempt_at rows
- [core-infra] src/db/migrations/run-better-auth-generate.ts:15 — 'auth-schema-drift CI job' — exists at .github/workflows/ci.yml:304
- [core-infra] scripts/export-openapi.ts:17 — drift-guard test claim — tests/unit/openapi-export.test.ts and sdk/admin/ both exist
- [core-infra] scripts/drain-outbox.ts:11-14 — drainOutbox result shape {claimed,sent,retried,failed} and SKIP-LOCKED concurrency safety — match src/lib/email/outbox-worker.server.ts:54-67
- [core-infra] vitest.config.ts:62-64 — 'pnpm test drives the shards (scripts/test-shards.mjs)' and 'pnpm test:serial is the plain fallback' — package.json:32-33 confirms both scripts
- [core-infra] vitest.db.config.ts:14-16 — 'vitest.setup.ts only fills MISSING env vars (??=)' and 'the CI quality job's postgres service' — confirmed in tests/setup/vitest.setup.ts:23-27 and ci.yml quality job postgres service
- [core-infra] src/db/reset-database.ts:52-56 + package.json:25 — db:reset:reload passes --yes --reload and runReloadSteps spawns each step as a single shell command, matching the header's usage/portability claims
- [tests-unit-a] tests/unit/admin-grid-state.test.ts:65 — 'Default sort is currently re-emitted because the helper does not dedupe against the defaults' is still true: gridStateToSearchParams (use-grid-state.ts:80) unconditionally appends every sort entry.
- [tests-unit-a] tests/unit/client-ip.test.ts:11-27 — rightmost-XFF / TRUSTED_PROXY_COUNT / x-real-ip / 'anon' bucket claims all match src/lib/client-ip.ts (idx = ips.length - trustedProxyCount()).
- [tests-unit-a] tests/unit/admin-rate-limit.test.ts:9 — 'enforceRateLimit lazy-imports auditEvent on the deny path' confirmed: rate-limit.server.ts:227 dynamic import inside the deny branch.
- [tests-unit-a] tests/unit/admin-rate-limit.test.ts:119 — '60s later the audit bucket has refilled one token' matches DENIAL_AUDIT_LIMIT {capacity:1, refillPerSec:1/60} (rate-limit.server.ts:184-187).
- [tests-unit-a] tests/unit/app-shell-store.test.ts:10-12 — cross-file claim confirmed: tests/security/no-tokens-in-zustand.test.ts exists and inspects the partialize whitelist (its lines 19-44).
- [tests-unit-a] tests/unit/auth-init.test.ts:12 — cross-file claim confirmed: tests/security/account-linking-config.test.ts exists.
- [tests-unit-a] tests/unit/auth-signup-provisioning.test.ts:9-14 — 'databaseHooks.user.create.after in src/lib/auth.ts' confirmed (auth.ts:168-248, hook gates on shouldProvisionSelfSignup; OAuth handled by the session hook).
- [tests-unit-a] tests/unit/auth-policy.test.ts:306-308 — 'the sign-up hook stamps emailVerified:true without proof when an org waives verification' confirmed (auth.ts:218-221 returns {data:{emailVerified:true}} when policy.requireEmailVerification is false).
- [tests-unit-a] tests/unit/api-key.test.ts:17 — 'prefix is the tag + first 8 random chars' confirmed: DISPLAY_RANDOM_CHARS = 8 (api-key.ts:24).
- [tests-unit-a] tests/unit/csp-report-route.test.ts:84,132 — magic values confirmed: MAX_FIELD_LEN=2048, MAX_VIOLATIONS_PER_REQUEST=20, MAX_BODY_BYTES=64KiB (csp-report/route.ts:38-42).
- [tests-unit-a] tests/unit/ban-status.test.ts:8-9 — 'the module lazy-imports @/lib/auth' confirmed (ban-status.server.ts:31 awaits import inside the function).
- [tests-unit-a] tests/unit/audit-server.test.ts:37 — 'one proxy in front → rightmost XFF is real' confirmed against getClientIp with TRUSTED_PROXY_COUNT=1.
- [tests-unit-a] tests/unit/access-scope-membership.test.ts / access-scope.test.ts — three-tier scope claims (superadmin skips DB lookup, org admin exact-org-only, null-org denies) match src/lib/admin/access-scope.server.ts semantics as exercised.
- [tests-unit-a] tests/unit/auth-status-db.test.ts:313-319 — bare-superuser-marker expansion regression note matches auth-status.ts:229-245 (marker presence skips only the userIsGlobalSuperuser lookup, never the expansion).
- [tests-unit-b] tests/unit/migration-plan.test.ts:14 — "Real core is now the single consolidated 0001-initial-schema.sql" looked stale (earlier notes claimed core migrations 0001-0009), but src/db/migrations/ now contains exactly one core .sql (0001-initial-schema.sql) plus locales/0000-0007; the comment reflects the consolidation and is correct
- [tests-unit-b] tests/unit/navigation-server-loaders.test.ts:136-137 — "audit.view is a legacy/base key the audit page never checks" confirmed: administrator/audit/page.tsx guards checkAdminPermissionServer("admin.audit.read"); no page checks audit.view
- [tests-unit-b] tests/unit/navigation-server-loaders.test.ts:118-120 — Users-link/page-guard parity claim confirmed: administrator/users/page.tsx guards admin.users.read, matching the nav manifest gate in src/lib/navigation.server.ts:250
- [tests-unit-b] tests/unit/navigation-server-loaders.test.ts:91-92 — "admin.audit.read IS an admin.* catalog permission so the Administrator launcher (anyOf ANY_ADMIN_PERMISSION) surfaces" confirmed: src/lib/admin/permissions.ts includes admin.audit.read in ADMIN_PERMISSION_CATALOG and ANY_ADMIN_PERMISSION is its key map
- [tests-unit-b] tests/unit/jwt-server-branches.test.ts:24-27 — "verifyAccessToken now selects the key by kid via a local JWK Set for rotation support (P3-7)" confirmed at src/lib/api-auth/jwt.server.ts:163-173 (createLocalJWKSet over current+previous public JWKs); thumbprint-fallback kid and BETTER_AUTH_URL issuer fallback also match (lines 46-51, 138, 170)
- [tests-unit-b] tests/unit/jwt-handoff-clamp.test.ts:10 — "documented 60 second maximum" confirmed: SSO_HANDOFF_MAX_TTL_SECONDS = 60 in src/lib/jwt-handoff.server.ts:32
- [tests-unit-b] tests/unit/jwt-handoff-env.test.ts:6-8 — cross-file references to tests/security/jwt-handoff.test.ts and tests/security/jwt-handoff-jti.test.ts confirmed to exist; P3-11 full-claim boundary validation claim matches handoffClaimsSchema in src/lib/jwt-handoff.server.ts
- [tests-unit-b] tests/unit/metrics-route.test.ts:3-4 — "the rate-limit deny path lazy-imports auditEvent" confirmed: src/lib/admin/rate-limit.server.ts:227 does void import("@/lib/audit.server") on deny; "counted on all denials unlike the flood-gated denial audit" matches rateLimitDenialsTotal.inc on every deny vs DENIAL_AUDIT_LIMIT (1 per ~60s) gating the audit write
- [tests-unit-b] tests/unit/user-actions-server.test.ts:205-206 — "status actions are NOT gated here — confinement happens inside performAdminStatusChange" confirmed: performStatusAction in src/lib/admin/user-actions.server.ts passes actor.scope to performAdminStatusChange and never calls refuseSharedAccountGlobal, while ban/unban/soft_delete/restore all do (AUTHZ-2)
- [tests-unit-b] tests/unit/retention.test.ts:8 — "the audit prune sets the app.audit_retention flag B3's trigger honors" confirmed: src/lib/retention.server.ts:46 sets `set local app.audit_retention = 'on'` and src/db/migrations/0001-initial-schema.sql:704,763 triggers allow DELETE only when current_setting('app.audit_retention', true) = 'on'
- [tests-unit-b] tests/unit/shutdown-server.test.ts:56 — "10_000 // default SHUTDOWN_TIMEOUT_MS" confirmed: src/lib/shutdown.server.ts:14 defaults SHUTDOWN_TIMEOUT_MS to 10_000
- [tests-unit-b] tests/unit/openapi-export.test.ts:12-17 — "the v1 builder also serves the live /api/v1/openapi.json; the admin builder is the source for the SDK under sdk/admin/" confirmed: src/app/api/v1/openapi.json/route.ts calls the same buildOpenApiDocument, and sdk/admin/ exists with the generated client (scripts/export-openapi.ts header corroborates)
- [tests-unit-b] tests/unit/keyset-pagination.test.ts:17-18 — "These power the streaming CSV export's page walk" confirmed: applyKeyset/keysetCursorFrom are consumed by src/app/api/administrator/export/[resource]/route.ts
- [tests-unit-b] tests/unit/sso-server.test.ts:43-44 — "Single call site: createSsoHandoffRedirect looks the target app up once and passes it to loadSsoAccessContext" confirmed: src/lib/sso.server.ts:81 (single app_enterprise_applications select) and :90 (loadSsoAccessContext(betterAuthUserId, targetApp))
- [tests-unit-b] tests/unit/metrics-server.test.ts:8-9 — "the SQL itself is covered against a real database in the browser job" plausible-and-supported: tests/e2e/admin-overview.spec.ts exercises the Administrator overview dashboard (which renders these metrics) in the Playwright job against a real database
- [tests-unit-b] tests/unit/navigation-filtering.test.ts:34-36 — AND (requiredPermissions) + OR (anyOfPermissions) semantics comment confirmed against filterMenuByPermissions in src/lib/navigation.server.ts:49-60
- [tests-component] tests/component/group-components.test.tsx:10 — claim 'group routes are covered at the HTTP layer by tests/integration/groups.test.ts': that file exists
- [tests-component] tests/component/group-components.test.tsx:93 — 'No delete column when the caller lacks admin.groups.delete': groups/page.tsx:29 derives canDelete from exactly that permission key
- [tests-component] tests/component/group-components.test.tsx:193 & tests/component/organization-picker.test.tsx:32 — 'validates organizationId against the shared schema's UUID rule': src/lib/validation/groups.ts:20 and src/lib/validation/roles.ts:16 both use a UUID regex on organizationId
- [tests-component] tests/component/group-components.test.tsx:521 — 'server dropped the pick (not an active org member)': src/app/api/administrator/groups/[id]/members/route.ts:151 filters status = 'active'
- [tests-component] tests/component/organization-picker.test.tsx:8-13 — 'picker is SUPERADMIN-only; an org admin's scope is forced server-side': roles/new/page.tsx passes showOrgPicker={superadmin}, and roles/route.ts:216 rejects a non-superadmin posting null/foreign orgId; OrganizationPicker really is a Popover+cmdk Command combobox with exactly two consumers (new-role, new-group forms); ADR-0002 lives in docs/architecture.md:258
- [tests-component] tests/component/auth-policy-form.test.tsx:26-27 — 'verification-off + auto-approve-domains is a rejected combination (the security refine)': src/lib/validation/auth-policy.ts:55/69 implements exactly that refine
- [tests-component] tests/component/administrator-data-grid.test.tsx:10 — 'docs/admin-manager.md §7': §7 is 'List queries, pagination, and row actions' (the DataGrid spec)
- [tests-component] tests/component/administrator-data-grid.test.tsx:164 — "the leading option is the 'All' sentinel; selecting it removes the filter": data-grid-filters.tsx:126-130 maps ALL_VALUE to onFilterChange(name, null)
- [tests-component] tests/component/user-roles-panel.test.tsx:10 — POST/DELETE /api/administrator/users/[id]/app-roles exists (src/app/api/administrator/users/[id]/app-roles); canAssign gating matches admin.roles.assign on users/[userId]/page.tsx:75; _role-picker.tsx:78 filters out organization_id === null (global) roles
- [tests-component] tests/component/user-groups-panel.test.tsx:10 — POST/DELETE /api/administrator/users/[id]/groups exists; canManage gating matches admin.groups.assign on users/[userId]/page.tsx:76
- [tests-component] tests/component/email-password-sign-up-form.test.tsx:57-58 — 'autoSignInAfterVerification is off': src/lib/auth.ts:131 sets autoSignInAfterVerification: false
- [tests-component] tests/component/email-password-sign-up-form.test.tsx:135-136 — 'Invited sign-ups arrive pre-verified': src/lib/auth.ts:199-205 user.create hook sets emailVerified: true for a valid matching invitation token
- [tests-component] tests/component/email-password-login-form.test.tsx:77 — 'AUTH-4' identifier: real spec item (specs.md:3676, src/lib/auth.ts:80) for the email-verification sign-in gate
- [tests-component] tests/component/application-switcher-sheet.test.tsx:40-41 — 'links carry rel="nofollow noreferrer"': application-switcher-sheet.tsx:139 sets exactly that
- [tests-component] tests/component/application-shell.test.tsx:19/33 — '§31.21 unique main ids': specs.md §31 'Definition of done' item 21 says 'Root and nested mainId values are unique'; 'only one banner role' holds because the nested header sits inside the root <main> (no banner mapping)
- [tests-component] tests/component/shell-grid-container.test.tsx:32 & shell-container.test.tsx:27 — '§17.5': specs.md:2037 is '17.5 Visibility contract'
- [tests-component] tests/component/sign-in-form.test.tsx:9 — '§14.1': specs.md:1480 is '14.1 Sign-in page'; application-switcher-sheet '§25' is 'Skeleton placeholders'
- [tests-component] tests/component/navigation-menu-skeleton.test.tsx:29-33 — compact mode renders icon + one text line vs two: navigation-menu-skeleton.tsx renders the second Skeleton only when !compact
- [tests-component] tests/component/brand.test.tsx:8-12,20 — shortName is first whitespace token (src/config/brand.ts:50); 'replacing the common.appName i18n key' holds — appName no longer exists in message catalogs (only as an email-template variable)
- [tests-component] tests/component/new-user-form.test.tsx:9-10 — 'reference implementation of the RHF + Zod pattern (docs/form-validation.md)': that doc exists and names _new-user-form.tsx as the reference implementation at line 145
- [tests-component] tests/component/metric-bar-chart.test.tsx:12-13 — 'the chart is decorative (aria-hidden)': metric-bar-chart.tsx:57 wraps the Recharts SVG in aria-hidden="true"
- [tests-component] tests/component/auth-panels.test.tsx:14/37/47 — 'Title appears twice (CardTitle + AlertTitle)': blocked-account-panel.tsx:30/34 and verify-email-panel.tsx:32/36 render the same title in both
- [tests-component] tests/component/secure-sidebar.test.tsx:12 — 'derives the active item from the locale-less pathname': secure-sidebar.tsx:42 uses @/i18n/navigation usePathname and strips the locale prefix at line 103; icon allow-list is real (menu-icons getMenuIcon)
- [tests-component] tests/component/theme-provider.test.tsx:9-14 — in-house provider replacing next-themes with an innerHTML-emitted anti-flash ThemeScript: matches src/components/theme implementation (server-rendered script, provider renders no script)
- [tests-integration] tests/integration/administrator-organizations.test.ts:11 — header claims a canonical `organization_not_empty` 409 machine code even though the tests only assert `organization_in_use`; both codes are real: assertOrgEmpty throws AdminError("organization_not_empty") (src/lib/admin/orgs.server.ts:111) and the FK path returns organization_in_use (route.ts:219).
- [tests-integration] tests/integration/users-bulk-scope.test.ts:37 — 'The permission map mirrors the real module': mock BULK_USER_ACTION_PERMISSIONS is byte-for-byte identical to src/lib/admin/user-actions.server.ts:396-405.
- [tests-integration] tests/integration/org-scoped-admin-routes.test.ts:347 — 'the seeded admin.platform role holds admin.email.read WITHOUT the superuser marker': dev-init.ts:254-257 gives admin.platform shell.view + ANY_ADMIN_PERMISSION (catalog includes admin.email.read, permissions.ts:53) and no superuser.
- [tests-integration] Shared ORG_ADMIN boilerplate ('a superuser now passes every admin check by design — getUserAccessContext + the gate short-circuit') in administrator-audit/email/enterprise-apps/organization-members/roles/organizations tests: verified — auth-status.ts:242-245 expands the marker to SUPERUSER_PERMISSIONS and permissions.server.ts:135/182 short-circuit on isSuperadmin.
- [tests-integration] tests/integration/provider-bindings.test.ts:9 — 'every verb is gated by canAccessOrg(access, id)': route calls canAccessOrg at lines 53 (GET), 138 (POST), 232 (DELETE).
- [tests-integration] tests/integration/user-audit.test.ts:10-11 — 'requires admin.audit.read — stricter than the page's own admin.users.read': users/[userId]/page.tsx:35 guards on admin.users.read; the audit endpoint gates admin.audit.read.
- [tests-integration] tests/integration/docs-filesystem-source.test.ts:5-6 — 'the default root when DOCS_ROOT is unset' is the repo docs/ folder: safe-path.server.ts:103 defaults to path.resolve(process.cwd(), 'docs').
- [tests-integration] tests/integration/administrator-phase7.test.ts:193-196 — impersonation cookies delivered by Better Auth's nextCookies plugin, 'the helper omits returnHeaders': impersonateBetterAuthUser (auth-admin.server.ts:199-207) passes no returnHeaders.
- [tests-integration] tests/integration/administrator-phase7.test.ts:29-33 — getImpersonatorId stand-in 'reads session.session.impersonatedBy' matches the real helper (auth-guard.ts:31-41, including the impersonated_by fallback).
- [tests-integration] tests/integration/administrator-user-actions.test.ts:331-337 and 490-495 — 'only the metadata field is persisted as JSON by auditEvent; the request field is consumed for IP/user-agent and never serialized verbatim': audit.server.ts:88-92 stores ip_address/user_agent extracted from headers and JSON.stringify(input.metadata ?? {}) only.
- [tests-integration] tests/integration/administrator-user-actions.test.ts:443-444 — 'Better Auth ban issued first (so the user can't sign in even if the app-side update fails)': soft-delete route runs banBetterAuthUser as Step 1 (users/[id]/route.ts:211-215) before the app-side transaction (Step 2, :239+), with unban compensation.
- [tests-integration] tests/integration/sso-consume.test.ts:6-13 — GET verifies without burning the nonce, POST is 'trusted-origin-guarded': consume route POST calls checkTrustedOrigin (route.ts:147) and only POST calls consumeSsoHandoffNonce.
- [tests-integration] tests/integration/sso-launch.test.ts:31 — 'The route only reads nextUrl.searchParams and request.url': confirmed against src/app/api/sso/launch/route.ts:19-42 (request is otherwise only forwarded to mocked collaborators).
- [tests-integration] tests/integration/locale-preference.test.ts:12-13 — 'DB-state assertions are covered by the dedicated SQL integration suite': tests/db/ exists with nine *.db.test.ts suites run against the seeded test database.
- [tests-integration] tests/integration/administrator-memberships.test.ts:96 — 'organizationId null + no superuser ⇒ resolveOrgScope() === null': access-scope.server.ts:51-55 returns null exactly then.
- [tests-integration] tests/integration/permissions-catalog.test.ts:34 — '// assertPermissionNotInUse' on the app_role_permissions stub: roles.server.ts:175-181 counts app_role_permissions by permission_id; the [id] route calls it (:129).
- [tests-integration] tests/integration/permissions-catalog.test.ts:10-11 — 'Reads stay open to any admin.roles.read holder': permissions list GET gates on admin.roles.read (permissions/route.ts:33).
- [tests-integration] tests/integration/roles-mutations.test.ts:38 — '// assertRoleNotInUse' on the app_user_roles stub: roles.server.ts:130-142 counts app_user_roles (and app_group_roles); roles/[id]/route.ts:158 calls it.
- [tests-integration] tests/integration/groups.test.ts:76-80 and user-app-roles.test.ts:58-59 — mock comments that permissionKeysForRoles selects app_role_permissions and permissionKeysForGroup selects from app_group_roles: grantable-permissions.server.ts:33-46 matches.
- [tests-integration] tests/integration/api-v1-me-api-keys.test.ts:9 and api-v1-admin-oauth-clients.test.ts:8 — 'design §7': docs/design-api-keys-and-tokens.md §7 is 'Scope model & the intersection rule', matching the self-ownership/intersection claims.
- [tests-integration] tests/integration/api-v1-admin-oauth-clients.test.ts:14 — 'resolveOrgScope / userHasMembershipInOrg / ungrantableScopesForCaller run for real': the route imports all three from unmocked modules (oauth-clients/route.ts:7-8).
- [tests-integration] tests/integration/api-v1-users-status.test.ts:10 — 'canAccessUser runs for real': route imports canAccessUser from unmocked access-scope.server (status/route.ts:6, :68).
- [tests-integration] tests/integration/administrator-email.test.ts:14 ('specs.md §35') — specs.md §35 is 'Email subsystem'; and :98-99 'outbox tenant isolation lives in org-scoped-admin-routes.test.ts and email-send.test.ts' — both exist (tests/unit/email-send.test.ts:205-218 covers ADR-0001 outbox org attribution).
- [tests-integration] Spec-section references §29.6.9 (navigation-menus), §29.6.10 (sso-launch), §29.6.11 (admin-status-action), §29.6.12 (locale-preference), §29.7.5 (sso-consume): specs.md §29.6 list items 9-12 and §29.7 item 5 match exactly.
- [tests-integration] tests/integration/administrator-phase7.test.ts:8 — 'docs/admin-manager.md §19 Phase 7': §19 is 'Phase 7 — impersonation, bulk actions, CSV export' (admin-manager.md:597) — the one phase reference that is still accurate.
- [tests-integration] tests/integration/administrator-invitations.test.ts:19 — 'the lib itself in tests/unit/invitations.test.ts': that file exists; invitations-accept.test.ts's 'unit/DB-tested' claim also backed by tests/db/organization-invitations.db.test.ts.
- [tests-integration] tests/integration/navigation-menus.test.ts:11-14 — 'all three share ... 400 for invalid query': all three navigation routes have an invalid_query 400 path (applications:37, shell-menu:35, nested-apps:33).
- [tests-misc] tests/e2e/helpers/admin-auth.ts:10 — '.env.example defaults as fallback': .env.example:153-154 has SEED_ADMIN_EMAIL=admin@devresponse.local / SEED_ADMIN_PASSWORD=ChangeMe-LocalOnly-123!, and seed-local.ts:205-206 reads the same vars
- [tests-misc] tests/e2e/helpers/admin-auth.ts:19-21 — 'admin origin guard requires Origin/Referer on unsafe methods': src/lib/admin/origin-guard.server.ts rejects POST/PATCH/PUT/DELETE with neither header (missing_origin)
- [tests-misc] tests/security/jwt-handoff.test.ts:70 — 'clamps the TTL at 60 seconds': SSO_HANDOFF_MAX_TTL_SECONDS = 60 and clampSsoHandoffTtl in src/lib/jwt-handoff.server.ts:32-36
- [tests-misc] tests/db/outbox-drainer.db.test.ts:105 — '200 chars + the ellipsis': ERROR_MAX_LEN = 200 with slice+ellipsis in src/lib/email/outbox-worker.server.ts:26,50
- [tests-misc] tests/db/auth-status-groups.db.test.ts:18-19 — 'bearer path (boundOrg passed), so no active_org cookie is read': getUserAccessContext(betterAuthUserId, boundOrg?) in src/lib/auth-status.ts:112-141 skips the active_org cookie whenever boundOrg is passed; line 250's shell.view-only baseline matches the membership-baseline grant
- [tests-misc] tests/e2e/machine-credentials.spec.ts:12-14 — 'CI sets both in the browser job': .github/workflows/ci.yml browser job sets API_JWT_ENABLED=1 (line 137) and generates the signing key per run (comment at 134-136)
- [tests-misc] tests/e2e/sso-handoff.spec.ts:13-19 — CI browser job sets SSO_HANDOFF_APPLICATION_ID=portal / SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app (ci.yml:125-126) and /api/sso/consume reads exactly those env vars (src/app/api/sso/consume/route.ts:34-51)
- [tests-misc] tests/e2e/admin-users-grid.spec.ts:7 — 'org-name correlated subquery': the users list route still builds organization_names via a correlated scalar subquery (src/app/api/administrator/users/route.ts:102-134)
- [tests-misc] tests/security/export-org-scope.test.ts:211-215 — 'cap is operator-tunable via ADMIN_EXPORT_MAX_ROWS ... read at module load': src/app/api/administrator/export/[resource]/route.ts:58-60 (default 100k, module-scope const)
- [tests-misc] tests/e2e/anonymous-redirect.spec.ts:30-36 — org-scoped sign-in branding + social login '(§14.1)': specs.md §14.1 (line 1484) documents /sign-in/<org> branding, unknown-org silent fallback, and social buttons
- [tests-misc] tests/e2e/create-permission.spec.ts:16-17 — 'chromium/mobile run sequentially against the same database': playwright.config.ts has workers:1, fullyParallel:false, projects chromium+mobile
- [tests-misc] tests/e2e/sidebar-collapse.spec.ts:43 — 'provider persists state in a cookie': src/components/ui/sidebar.tsx SIDEBAR_COOKIE_NAME='sidebar_state', document.cookie write at line 117
- [tests-misc] tests/e2e/email-outbox.spec.ts:10-13 — 'forgot-password triggers Better Auth's sendResetPassword': src/lib/auth.ts:104 defines sendResetPassword
- [tests-misc] tests/e2e/admin-permission-denied.spec.ts:5-8 — '404 indistinguishability (docs/admin-manager.md §6.2)': §6.2 '404, not 403, on out-of-scope resources' exists at docs/admin-manager.md:285
- [tests-misc] spec section citations §29.7.1-11, §29.8.1/2/9, §29.9.1-4, §35 across the security/e2e/accessibility suites all match specs.md (29.7 at line 3148, 29.8 at 3164, 29.9 at 3179, ## 35 Email subsystem at 3619)
- [tests-misc] tests/db/access-scope.db.test.ts:16-22 — 'excluded from pnpm test, driven by pnpm test:db (vitest.db.config.ts)': package.json test:db uses vitest.db.config.ts, which exists; tests/integration/* exists and Proxy-mocks the DB
- [tests-misc] tests/security/safe-return-to.test.ts:7 — 'unit tests under tests/unit/safe-return-to.test.ts cover the happy path': that file exists
- [tests-misc] tests/db/auth-status-groups.db.test.ts:8-9 — 'mock's own comment admits only the LEFT builder's .execute() runs': the referenced mock comment exists verbatim in tests/unit/auth-status-db.test.ts:51-53 (though it is a unit test, not tests/integration)

</details>
