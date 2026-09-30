# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

As of `1.0.0`, [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
applies, and three surfaces are versioned with distinct guarantees:

- **The package / application shell** — semver on tagged releases.
- **The machine API (`/api/v1`)** — the `v1` path is the compatibility
  contract; breaking changes ship under a new version prefix.
- **The admin SDK** (`sdk/admin/`) — regenerated from the OpenAPI spec; tracks
  the admin API surface.

## [Unreleased]

### Operator actions

For a deployment running 2.0.0.

1. **Grant `admin.orgs.manage` where `admin.orgs.update` managed people.**
   An organization's members, invitations and provider bindings now need
   `admin.orgs.manage`, and `admin.orgs.update` keeps only its settings
   (F-69). The seeded `admin.platform` role holds both. A custom role, API
   key or OAuth client with `.update` and not `.manage` loses those writes
   and the membership half of a confined user create, and a pending
   invitation sent through such a role is voided when someone accepts it.
   Before the deploy, list them read-only and add `admin.orgs.manage` where
   people management was meant:

   ```sql
   select coalesce(o.slug, '(global)') as org, r.key from app_roles r
   left join app_organizations o on o.id = r.organization_id
   join app_role_permissions rp on rp.role_id = r.id
   join app_permissions p on p.id = rp.permission_id and p.key = 'admin.orgs.update'
   where not exists (
     select 1 from app_role_permissions rp2
     join app_permissions p2 on p2.id = rp2.permission_id
     where rp2.role_id = r.id and p2.key = 'admin.orgs.manage');
   select 'api_key' as kind, id, name, scopes from app_api_keys
   where status = 'active' and 'admin.orgs.update' = any(scopes)
     and not (scopes && array['admin.orgs.manage', 'admin.orgs.*', 'admin.*', '*'])
   union all
   select 'oauth_client', id, name, scopes from app_oauth_clients
   where status = 'active' and 'admin.orgs.update' = any(scopes)
     and not (scopes && array['admin.orgs.manage', 'admin.orgs.*', 'admin.*', '*']);
   ```

2. **Repository settings.** From
   [SECURITY.md → Repository security settings](SECURITY.md#repository-security-settings),
   require actions pinned to a full-length commit SHA, and restrict the
   `production` environment's deployment branches to `main`, adding required
   reviewers with its first secret (I-09).
3. **The old help screenshots.** Until F-89 the walkthrough's admin and
   account screenshots, taken on the live demo, showed the operator's real
   email addresses, public IP address and an active, non-expiring API key
   (named "test api", owned by the operator) with its prefix, also quoted in
   `help/42-admin-api-keys.md`. They are recaptured from synthetic data, but
   the old files stay in the public repository's history (added in #346,
   retaken in #347). Revoke that key on the demo if it is still active, and
   decide whether to purge the old `help/screenshots/*.png` from history.
4. **Apply migration `0008` before the deploy.** Follow
   [docs/deployment.md → Migration 0008](docs/deployment.md#migration-0008)
   (F-151): a read-only preflight that the migrating role can write Better
   Auth's tables and owns the audit table, the apply, and the checks. `0008`
   is a required core migration, so until it is in the ledger
   `GET /api/health/ready` answers `503 schema_behind`. Vercel runs no
   migrations: apply it by hand, before the merge that needs it
   ([docs/deployment.md §1.1](docs/deployment.md#11-the-live-path-vercel-git-integration--hand-applied-migrations)).

### Security fixes the satellite forks must port

Kit fixes since 2.0.0 whose files the `devresponseapps` forks carry, on top
of 2.0.0's list below. Each entry names what to carry over.

- **F-82.** The handoff session's lifetime: the token `createSsoSession`
  mints (`src/lib/auth-sso-session.ts`, which now takes the `applicationId`
  the consume route passes), the rule in `src/lib/session-lifetime.ts`, and
  `SSO_SESSION_LIFETIME_HOURS` in `src/lib/env.ts`; the forks' `auth-guard.ts`
  and `rejectClosedAuthEndpoints` pass `getServerEnv()` to
  `isSessionPastLifetime`. Until a fork carries them, its handoff sessions
  still roll forever, and disabling its app on the kit signs no one out,
  because the kit finds a handoff session by its token.

### Added

- **Data-subject export and erasure (F-151).** A user downloads their own
  data as JSON from Account → Overview (`GET /api/account/export`); an
  administrator holding the new `admin.users.export` permission downloads a
  user's from the detail page. A superadmin erases a soft-deleted user's
  personal data with `POST /api/administrator/users/[id]/erase`, which runs
  the `SECURITY DEFINER` function `app_users_pseudonymise` from migration
  `0008`: addresses become a pseudonym, sessions and sign-in methods go, and
  the audit trail keeps every row. See operator action 4 and
  [docs/admin-manager.md → Data export and erasure](docs/admin-manager.md#data-export-and-erasure-f-151).
- **Atomic dual-list saves and edit-conflict detection in the administrator
  API (F-38, F-39).** `PATCH /roles/[id]/permissions` and
  `PATCH /groups/[id]/roles` take `{ add, remove }` and apply both sides in
  one transaction, after running every guard on both. The organization, role
  and group detail GETs answer an `ETag` (a hash of the fields their PATCH can
  change, so no migration), and their PATCH takes an optional `If-Match` and
  answers `412 precondition_failed` for a stale one. The existing POST and
  DELETE, and a PATCH without `If-Match`, work as before. The admin SDK is
  regenerated: it gains `updateRolePermissions`, `updateGroupRoles` and an
  `ifMatch` parameter, and picks up the export and erase operations (F-151).

### Changed

- **Organization permissions.** `admin.orgs.manage` gates an organization's
  members, invitations and provider bindings, as the catalog always said,
  and `admin.orgs.update` only its settings: the record and its sign-up
  policy. Both used to be `admin.orgs.update`, and `admin.orgs.manage`
  gated nothing (F-69). The membership permission a confined creator needs
  to create a user (#480, #486) is now `admin.users.update` or
  `admin.orgs.manage`, not `admin.orgs.update`. A test now fails when a
  catalog key reaches no guard. See operator action 1.
- **Enterprise-app names.** App ids and SSO audiences are global names, so an
  organization admin (or a credential bound to one organization) registers
  its org's app only under the org's slug, as `<org-slug>.<name>` with an
  audience ending in an id under the slug (`devresponse-app:acme.crm`), and
  moves an audience only within it. Any other name is a superadmin's to register
  (`403`, audited). An org admin could claim `crm` before the superadmin
  registering the real satellite, who then got `409` (I-01). Existing apps
  keep their names.
- **Administrator API contract.** A repeated `filter[…]` on an administrator
  list or CSV export matches any of its values, as the admin spec and SDK
  declare; most lists used to drop it and answer every row. `POST
  /organizations` also returns `key` (the slug), and a revoke that happens
  answers `alreadyRevoked: false`, the shapes the spec declares (F-74).
- **Runtime.** `/api/metrics` runs on `@prometheus-io/client`, the successor
  to the deprecated `prom-client`: the same metric names and exposition, with
  event-loop utilization added to the defaults (F-113). The `dompurify` and
  `postcss` override floors are raised to their declared versions, so
  DOMPurify resolves 3.4.16. Sentry 11.1 (`@sentry/nextjs`, superseding
  #485): spans stream and no transaction event is sent, so the scrubber reads
  the streamed span shape, drops the user attributes the SDK copies onto
  every span, handles header values sent as arrays and fails closed if it
  throws. The streaming lifecycle is pinned, so `SENTRY_TRACE_LIFECYCLE=static`
  cannot switch span scrubbing off, and the root span's name is scrubbed from
  each envelope's trace header too; the new `queues` collection category is
  closed (R11).
- **HTTP plumbing in `src/lib/http/`.** The route wrappers, request-id
  correlation, the first-party and `/api/v1` error envelopes, the origin guard
  and the three rate limiters moved out of `src/lib/admin/`,
  `src/lib/api-auth/problem.ts` and `src/lib/route-handler.server.ts` into
  `src/lib/http/`, with no behaviour change and no shim at the old paths
  (I-13). Import and mock them by the new paths. A branch or satellite fork
  that ports a kit file applies the same rewrite
  ([Architecture §8.1](docs/architecture.md#81-how-it-moved)).

### Security

- A session an SSO handoff opens ends `SSO_SESSION_LIFETIME_HOURS` (default
  8) after the handoff, however active, so a user blocked on the primary, or
  whose app was disabled there, goes back through a launch that refuses them.
  It used to roll forever, and the satellite docs' "8 h revocation lag" did not
  hold for anyone still using the app. Disabling or deleting an enterprise app
  now also ends the handoff sessions for it that the primary's database holds
  (a satellite on that database) and expires its handoffs in flight; the audit
  row counts them in `metadata.endedSsoSessions` (F-82). A satellite fork gets
  both only once it ports the change (the fork-port list above).
- The optional Actions deploy installs its Vercel CLI from `vercel-cli/`'s
  lockfile, the audited tree `drk-deploy` runs, instead of an unlocked global
  `vercel@54` (I-09).
- The administrator-console help pages are listed only to a viewer holding
  the permission of the screen each documents, the screenshots that showed
  real accounts, IP addresses and an API key are recaptured from synthetic
  seed data, and `help/capture.mjs` refuses a target not confirmed synthetic
  (`CAPTURE_SYNTHETIC_DATA=1`) (F-89).

### Fixed

- **Administrator console.** The role **Permissions** and group **Roles**
  editors save through the one atomic PATCH. They sent a POST and then a
  DELETE, so when the removal was refused (a key the admin does not hold, the
  last superadmin) the addition stayed live for every holder of the role or
  member of the group; now a refused save changes nothing (F-38). The
  organization, role and group **Settings** forms send the record's ETag, so
  a save made over someone else's newer save (another admin, another tab) is
  refused with a named message and the page reloads, keeping the admin's
  edits, instead of silently overwriting it (F-39). The admin OpenAPI names
  the `409` codes the organization PATCH (`last_superadmin`,
  `organization_is_default`, `slug_taken`) and the invitation create and
  resend (`organization_not_active`) answer (F-09).
- **Enterprise apps.** An organization admin can create an app from
  **Administrator → Enterprise apps → New application**. The form sent no
  `organization_id`, so every create was a global app, which the API refuses
  to an org admin (`403`). It now sends the admin's active organization,
  prefills the id with `<org-slug>.`, says under the id and SSO audience that
  names go under the slug (I-01), and shows a name outside it on its field
  rather than as "You don't have permission to view this page", on the
  settings form's audience too. A superadmin picks Global, the default, or an
  organization. The API is unchanged: an omitted `organization_id` is still a
  global app (R14).
- **Email.** Invitations and the test email are written in the recipient's
  language when the recipient belongs to the mail's organization, else in
  the sending admin's, and an invitation's link opens in the same language,
  not always `/en` (F-102).

## [2.0.0] - 2026-09-30

Everything merged to `main` since 1.0.0 (#178 through #488). That is the
organization sign-up and invitation model, four more locales, the MCP agent
gateway, satellite apps and the `drk-deploy` CLI, and the remediation of two
reviews: the 2026-09-04 source review (cited as `review #n`) and the
2026-09-22 full review (cited as `F-`, `I-`, `A-` and `M-` ids). Of the
latter, the Critical and the Highs shipped in #471 and #472, the 46 Mediums in
#473, the created-user enrolment follow-ups in #480 and #486, and the Lows and
advisories that need no operator decision in #488.

This is the first tagged release, `v2.0.0`; 1.0.0 was never tagged. It is a
major version because it breaks what a 1.0.0 deployment or client relied on:
it removes the HS256 SSO handoff and `SSO_HANDOFF_JWT_SECRET` that 1.0.0
satellites used (#398), removes three environment variables, and refuses
input 1.0.0 accepted (see **Changed** and **Removed**). The `/api/v1` path
stays the compatibility contract: its changes bring the code in line with the
published OpenAPI document, so there is no new API prefix. Production already
runs this release, since every merge to `main` deploys.

### Operator actions

For a database or deployment last updated before this release. Each step
says when it applies; most must be done before the deploy.

1. **Apply migration `0007` before the deploy.** Follow
   [docs/deployment.md → Migration 0007](docs/deployment.md#migration-0007):
   a read-only preflight (duplicate global role keys, a second default
   organization), optional concurrent index builds for a large audit or
   outbox table, the apply, the checks, and a second provider-token scrub
   after the deploy. `0007` is a required core migration, so until it is in
   the ledger `GET /api/health/ready` answers `503 schema_behind`. Vercel runs
   no migrations: apply every migration by hand, before the merge that needs
   it ([docs/deployment.md §1.1](docs/deployment.md#11-the-live-path-vercel-git-integration--hand-applied-migrations)).
   A database behind `main` also needs `0002` to `0006` (`pnpm db:app:migrate`
   applies them in order; `0005` lists and refuses rows that break its new
   constraints) and two Better Auth changes, the `user.emailVerificationWaived`
   column (#399) and the `rateLimit` table (#412), from
   `pnpm db:auth:migrate`. A database migrated only to 1.0.0's own files
   cannot be brought forward by the runner alone: #287 folded the migrations
   added after 1.0.0 (the organizations' foreign-key actions, per-organization
   sign-up settings, organization invitations) into the frozen `0001`, which
   the runner skips on a database that already ledgers it. Provision such a
   database fresh (`pnpm db:provision`) or apply the missing DDL by hand.
2. **Check the environment against the boot rules first.** A value that
   fails one stops the server at boot, and readiness answers `config_invalid`
   (F-26). Rules added since 1.0.0:
   - `SHUTDOWN_TIMEOUT_MS` and `ADMIN_EXPORT_MAX_ROWS` are positive integers
     or unset; `0`, `-1` and `10s` used to be absorbed silently (F-109).
   - `SSO_HANDOFF_PRIVATE_KEY` is set only on the issuer: with a key present,
     the origin of `SSO_HANDOFF_ISSUER` must equal that of `BETTER_AUTH_URL`
     (F-80). A Preview deployment with its own `BETTER_AUTH_URL` must not
     carry the production key.
   - Origin-valued variables are exact origins, `COOKIE_DOMAIN` must cover
     the host, and the JWT and handoff keys must import (F-22).
   - A production deployment with an email provider needs a real
     `EMAIL_FROM`, not the placeholder or a reserved domain (F-27).
   - `SSO_ALLOWED_ORIGIN_SUFFIXES` entries must be registrable domains; left
     unset in production, no enterprise-app origin can be registered (#392).
   - `CLIENT_IP_SOURCE`, when set, must parse (F-17). Leaving it unset in
     production off Vercel logs a warning at boot.
   - `API_JWT_ISSUER` must be unset or equal `BETTER_AUTH_URL` while
     `MCP_ENABLED` is on (#422).
   - `DB_MIGRATE_LOCK_TIMEOUT_MS` and `DB_MIGRATE_STATEMENT_TIMEOUT_MS`
     (defaults 5 s and 10 min) stop the migration runners when malformed
     (F-94).
3. **Retention now runs on the daily cron.** The `outbox-drain` tick prunes
   after it drains (F-96), so from the first tick after the deploy it deletes
   audit rows older than `AUDIT_RETENTION_DAYS` (365; values 1 to 29 act as
   30) and terminal outbox rows older than `OUTBOX_RETENTION_DAYS` (90), fails
   `pending` outbox rows older than `OUTBOX_MAX_PENDING_DAYS` (7), and deletes
   SSO handoff nonces expired over an hour ago (F-84). Set a window, or `0`
   to disable it, before deploying if a default does not fit. A long backlog
   is worked off in batches over several daily ticks (a 45 s budget per
   tick). The tick needs `CRON_SECRET`; on a host without Vercel Cron,
   schedule `pnpm db:prune`.
4. **Re-store `drk-deploy`'s secrets as `sensitive`, once.** `env:sync` now
   writes secrets `sensitive` and never to Development (F-138), but it
   rewrites nothing already on a project. Copy each value somewhere safe
   first, since a `sensitive` value cannot be read back, and keep the kit's
   `BETTER_AUTH_SECRET`: every Option C satellite needs it. Public values go
   the other way: stored `sensitive`, the preflight cannot check them and
   refuses, so re-store those as plain (F-46). The steps are in
   [vercel-cli/README.md → Upgrading](vercel-cli/README.md#upgrading). Also
   rebuild the CLI after a pull, since a `dist/` older than its source is
   now refused (I-14).
5. **A fleet older than #398: move SSO handoffs to an Ed25519 key.** The
   fleet-wide HS256 `SSO_HANDOFF_JWT_SECRET` is gone. The issuer signs with
   `SSO_HANDOFF_PRIVATE_KEY` and publishes `/api/sso/jwks.json`; every
   consumer verifies against the JWKS of `SSO_HANDOFF_ISSUER`. The token no
   longer carries `organizationId`, `appUserId` or `roles`. Upgrade the
   issuer and every satellite together.
6. **Flag one default organization.** The default is the organization with
   `is_default`, not the slug `default`, and provisioning never creates one:
   with none flagged, a sign-up that no invitation, sign-in hint or domain
   binding places is refused (F-40). `SEED_DEFAULT_ORGANIZATION_SLUG` is gone.
   `0007` now makes a second flag impossible (M-02).
7. **One-off checks, read-only.** Organizations that GitHub sign-ins created
   before F-52 have a dotted slug
   ([docs/auth-signup-policy.md §4](docs/auth-signup-policy.md#4-which-organization-governs-a-sign-up)
   has the query). An enterprise-app row naming the primary itself is now
   refused on create and update but not removed (F-83,
   [docs/admin-manager.md §8.7](docs/admin-manager.md#87-enterprise-applications)). Revoke the pending
   invitations of an administrator banned for cause before lifting the ban,
   because an invitation nobody has tried to use yet works again once the ban
   is gone (F-149).
8. **Refresh API clients.** Regenerate them from `docs/openapi.json`, and
   read the wire changes under **Changed** below.
9. **Repository settings.** Turn on Dependabot security updates, a setting
   no file can change
   ([SECURITY.md → Repository security settings](SECURITY.md#repository-security-settings),
   F-28), and make the `Deploy CLI (drk-deploy)` job a required check
   ([docs/testing.md §9](docs/testing.md#9-ci-workflows-and-required-checks),
   F-45).

### Security fixes the satellite forks must port

The `devresponseapps` forks (app-standalone, app-handoff, app-shared) copy
the kit's source and share its database, its SSO trust and, under Option C,
its session. A kit fix reaches them only when it is ported. This list covers
the fixes under **Security** below whose files the forks carry, checked
against `devresponseapps` at 7c07131, where all three forks lack every code
fix below. Fixes that live only in surfaces the forks do not mount (the
administrator console and its routes, `/api/v1`, `/api/mcp`, the token
endpoint) are left out until they do. Each entry names what to carry over.

- **MACHINE-2 (#443).** A machine credential bound to an organization
  reaches only that organization, even when its owner is a superadmin. Carry
  over the `orgBound` marker that `getUserAccessContext` sets
  (`src/lib/auth-status.ts`; without it the cap never fires),
  `hasCrossOrgReach` in `src/lib/admin/access-scope.server.ts`, the switch
  from `isSuperadmin` to it at each call site #443 changed, and its
  `ownerOutranksActor` bound on the four on-behalf paths. The forks'
  `resolve-caller.server.ts` already passes the bound organization. They
  mount no administrator or v1 route, so this matters there once they do.
- **F-03 (#472).** The `emailVerificationWaived` marker (a Better Auth
  additional user field meaning "verified without mailbox proof", set by the
  sign-up waiver and by an admin or machine-API creation without cross-org
  reach, cleared by a completed password reset) and the link gate
  (`validateUserInfoForLinking`, wired as Better Auth `user.validateUserInfo`)
  that refuses a provider link into a marked account:
  `src/lib/auth-verification-waiver.ts` and `src/lib/auth.ts`. A fork that
  writes the shared `user` table without the marker creates accounts the
  kit treats as mailbox-proven.
- **F-06, F-10, F-20, F-21 and F-55: the Better Auth configuration.** Every
  fork serves sign-up, sign-in and password reset on `/api/auth/*` against
  the shared `user` table. Carry over `disabledPaths` (`AUTH_DISABLED_PATHS`
  in `src/lib/auth-admin-surface.ts`: account linking, provider-token
  readers and the password oracle answer 404, F-06); the `onPasswordReset`
  hook in `src/lib/auth.ts` with `src/lib/impersonation-sessions.server.ts`
  and `src/lib/api-auth/credential-eviction.server.ts`, and the `after` hook
  in `src/lib/auth-session-sweep.ts` (a reset through a fork ends the
  account's own sessions but leaves its API keys and OAuth clients working
  against the kit, and signing out other sessions leaves the ones the user
  opened as someone else, F-10); `src/lib/auth-response-floor.ts` and
  `src/lib/email/defer-send.server.ts` (sign-up and reset answers that do not
  reveal an account, F-20); `src/lib/auth-user-name.ts` and
  `src/lib/user-name.ts` (names bounded, no control or bidirectional
  characters, F-21); and `src/lib/auth-sign-in-attempts.ts` (the per-account
  sign-in budget, F-55).
- **F-150.** The account hooks in `src/lib/auth-provider-tokens.ts`, for a
  fork that runs social sign-in on the shared `account` table (Option C):
  without them it keeps storing provider tokens the kit scrubs.
- **F-54, F-08, F-06, F-07 and F-65**, for a fork whose Better Auth serves
  the kit's session (Option C). `src/lib/session-lifetime.ts` and
  `rejectClosedAuthEndpoints` (`src/lib/auth-admin-surface.ts`, Better
  Auth's `hooks.before` in `src/lib/auth.ts`): an over-age session, or an
  impersonated one over an hour old, is refused on `/api/auth/*`, not only
  by the app's guards, and an impersonated session reaches only
  `IMPERSONATION_ALLOWED_PATHS` there (F-06). Also the human impersonator on the
  audit rows such a session writes (`src/lib/audit.server.ts`, F-07), and
  the account overview confined to the impersonator's reach
  (`app/account/_data.server.ts`, F-65).
- **F-52.** `src/lib/provider-organization-resolver.ts` and
  `src/lib/user-provisioning.server.ts`: the forks' copies still create an
  organization in the shared table, with a dotted slug, for a GitHub
  sign-in's verified email domain, instead of placing it only through the
  curated email-domain binding.
- **F-149.** The inviter's standing re-checked on acceptance, in
  `src/lib/invitations.server.ts`, `src/app/api/invitations/accept/route.ts`
  and the sign-up placement in `src/lib/user-provisioning.server.ts`: the
  forks accept the kit's invitations.
- **F-100.** `src/lib/email/outbox-worker.server.ts` with
  `src/lib/invitations.server.ts`: a fork's drain claims every pending row
  for its provider in the shared `app_outbox`, the kit's invitation mail
  included, and still delivers one whose invitation has died.
- **F-16 and F-17 (#473, #397).** Client-IP normalization, per-/64 IPv6
  limiter keys, and `CLIENT_IP_SOURCE`: `src/lib/client-ip.ts`,
  `src/lib/client-ip-source.ts` and `src/lib/forwarded-hops.ts`. The forks'
  own `client-ip.ts` keys their limiters and the IPs they write to the shared
  audit table. Carry over the `/api/auth/:path*` matcher in `src/proxy.ts`
  too (#397): the forks' proxy skips `/api/auth/*`, so the `x-drk-client-ip`
  header their Better Auth reads the client IP from arrives as the client
  sent it.
- **F-19 and F-15 (#473).** SSO consume and a signed-out launch draw from
  the shared per-IP bucket (`src/lib/admin/rate-limit-shared.server.ts`,
  table `0006`), not a per-process one, and a refusal decided before the
  token verifies, or a signed-out launch, is logged and counted
  (`src/lib/observability/pre-auth-refusal.server.ts`) rather than written
  to the shared append-only audit table, as the forks' copies of both routes
  still do.
- **F-80.** `assertSsoHandoffSignerIsIssuer` in
  `src/lib/jwt-handoff.server.ts`, the file the forks copy byte for byte,
  and its boot call in `src/instrumentation.ts`: a deployment holding the
  signing key but not the issuer's origin refuses to sign and to boot. A
  consumer without a key is unaffected.
- **F-81.** The `ctx.request` refusal in `src/lib/auth-sso-session.ts`: the
  forks' `sso-session/create`, which mints a session for any `userId`, still
  relies only on the vendor's `SERVER_ONLY` flag.
- **F-85 and F-78.** The consume route reports a nonce miss as a replay, an
  expiry or an unknown nonce (`src/lib/sso.server.ts`), sends a browser's
  failure to the confirm page, and caps the confirm form at 16 KiB before
  reading it (`src/lib/bounded-body.ts`).
- **F-105, F-18, I-17 and F-106.** The per-user bucket on
  `/api/preferences/active-org/apply` (each switch writes a row to the shared
  audit table, F-105); the per-IP bucket taken before the global floor on
  `/api/security/csp-report` (`src/lib/admin/rate-limit-tiered.server.ts`,
  F-18); `src/lib/safe-return-to.ts` (dot segments, controls and encoded
  separators, I-17); and the `src/proxy.ts` matcher entries for dotted paths
  under `/:locale/sign-in/` (F-106) and `/:locale/app/` (#425), which the
  forks serve with no CSP.
- **F-23.** The transaction and span scrubbers in
  `src/lib/observability/sentry-shared.ts` and `src/sentry.*.config.ts`: the
  forks scrub only error events, so a password-reset token in a URL path can
  reach Sentry.
- **F-86, F-87 and I-18: the docs viewer.** `src/lib/docs/frontmatter.ts`
  (YAML-only engines, so a `---js` block is never evaluated; a bad
  `visibility` or `requires` hides the doc instead of publishing it), and
  `getViewableDocument` in `src/lib/docs/catalog.server.ts` with
  `src/lib/docs/source/filesystem-source.server.ts` and the
  `app/docs/[...slug]` page (the entry actually read is authorized, not only
  the cached one). Every fork mounts the viewer under `app/docs` and
  `api/docs`.
- **F-24 (#473), docs.** Option A or B contains a satellite only with a
  database role that has no privileges on the primary's schema AND a host
  outside `COOKIE_DOMAIN`; a fork doc that claims containment without both
  conditions is wrong
  ([docs/integration-satellite-apps.md §1.1](docs/integration-satellite-apps.md#11-when-a-or-b-is-actually-contained)).

Keep the forks' `next` level with the kit's as well: they pin 16.3.5, and the
kit moved to 16.3.6 in #481.

### Added

- **Organization sign-up and invitations.** Email verification at sign-up
  (#257); a per-organization sign-up policy (admin approval,
  auto-activation, method allow-lists, auto-approved email domains) with an
  Authentication tab (#268 to #270); organization
  invitations and invite-only mode (#271 to #274, #281); organization-scoped
  sign-in at `/sign-in/<org>` and `?org=`, honoured by social sign-ups too
  (#294, #295); an email-verified confirmation screen, and auto-activation of
  verified users in the default organization (#289). See
  [docs/auth-signup-policy.md](docs/auth-signup-policy.md).
- **Locales.** Portuguese, Simplified Chinese, Hindi and Japanese (#223,
  #225 to #227), for eight in all. Localized email templates are an optional
  migration pass (`DB_MIGRATE_LOCALES`); the English base always applies
  (#253, #284 to #286).
- **MCP agent gateway** (#300, #308, #310 to #313, #413): a bearer-only
  Streamable HTTP endpoint at `/api/mcp` with OAuth discovery metadata,
  gated RFC 7591 self-registration, a tool surface generated from the v1
  OpenAPI document, and an Agents console with approval, scopes, revocation
  and a reaper for stale registrations. Off unless `MCP_ENABLED`.
- **Satellite apps.** The three reference satellites in the seed, kept out of
  production bootstraps (#357, #358), a true-subdomain local rig with
  `COOKIE_DOMAIN` (#351 to #356), confirmation before a handoff is consumed
  (#196), and the launch intent carried across sign-in (#464). See
  [docs/integration-satellite-apps.md](docs/integration-satellite-apps.md).
- **`drk-deploy`** (`vercel-cli/`, #432, #463): deploys the kit or a
  satellite to Vercel in the safe order (migrate, build, promote, probe,
  roll back on a failed probe) from an operator's machine.
- **Operations.** Prometheus metrics at `/api/metrics` behind
  `METRICS_TOKEN` (#221); Postgres-backed rate-limit buckets for the pre-auth
  floors and Better Auth's limiter (migration `0006`, #412, #414); an opt-in
  absolute session lifetime, `SESSION_ABSOLUTE_LIFETIME_HOURS` (#424); a
  previous-key slot for zero-downtime JWT and handoff key rotation (#203,
  #398); readiness that checks the environment and Better Auth's schema
  (F-26); `CLIENT_IP_SOURCE` (F-17); the outbox delivery-outcome counter
  (F-27); one-command provisioning, `pnpm db:provision`, and support for
  transaction-pooling endpoints (#244, #245).
- **Console and shell.** An editable Roles tab on the user detail (#248),
  group member management (#250), email-template filters (#349), a
  superadmin audit-events chart (#232), the Help screenshot walkthrough
  (#346 to #348), and a single-source brand identity (#237).
- **Tests and tooling.** The UAT story set (#255, #256), property and fuzz
  tests (#338), Stryker mutation testing on the security core (#340, I-11),
  per-file coverage floors on every route file (#334, F-42, F-125), and a
  DB-backed suite that refuses a non-local database (F-44).

### Changed

- **Wire changes a v1 client may notice.** Each brings the code in line with
  the published OpenAPI document or refuses input it used to ignore:
  - `/api/v1/me*` errors are `application/problem+json`, like the rest of v1,
    and `If-Match` on `POST /api/v1/users/{id}/status` is a real
    compare-and-swap (#419).
  - List endpoints answer `400` for an unknown filter, sort or enum value, a
    comma-joined enum, or a repeated `page`, `pageSize` or `q` (F-34); a
    page past 1,000,000 or a malformed id filter is `400` too (F-63).
  - Every 429 is a problem with the bucket's own `Retry-After` (F-130); a
    refused bearer token gets RFC 6750's `error="invalid_token"` (I-04).
  - The public endpoints cap their bodies before authenticating and answer
    `413`: the token endpoint and the SSO confirm form at 16 KiB, MCP
    registration at 64 KiB, `/api/mcp` at 1 MiB (F-78).
  - A narrowed OAuth client's or agent's outstanding JWTs lose the removed
    scopes on their next request (F-71), and the per-credential mutation
    limit is keyed on the source credential, not each token (F-73).
- **Wire changes on the first-party API.** Every first-party JSON error (the
  administrator, account, navigation and preference routes, SSO launch and
  consume) carries `{ error, message, requestId }` (F-129; additive for a
  client that reads `error`), and every administrator, account, v1, SSO and
  MCP response carries `x-request-id`, a thrown 500 included (F-29, A-12).
  The admin sessions list returns session ids,
  never tokens, and `DELETE …/sessions/{sessionId}` takes that id (#418).
  `/api` responses default to `Cache-Control: private, no-store` (I-07). A
  browser's failed SSO consume lands on the confirm page with a localized
  reason, and an expired handoff reports `token_expired`, not
  `token_already_used` (F-85).
- **MCP.** `tools/list` offers only the tools the credential's scopes can
  call, a `null` request id is refused, and every `tools/call` is
  rate-limited per credential (I-04, F-76).
- **Topology.** Several instances (Vercel functions) are a supported
  topology: the pre-auth floors and the admin mail budgets share one budget
  in Postgres, and only the per-actor abuse guard stays per process (#412,
  F-64, F-107). This supersedes 1.0.0's single-instance note.
- **Runtime.** Node 24 in CI, the Docker image and `engines` (`24.x`, #401,
  F-25); Next 16.3.6, Better Auth 1.7.6, React 19.3, Zod 4.6 and Mermaid 12
  (#433, #437, #451, #481).
- **Migrations.** The core migrations are consolidated into the frozen
  `0001` (#287); forward files `0002` to `0007` follow. The runner holds an
  advisory lock, checksums the ledger (#411) and runs every file under
  `lock_timeout` and `statement_timeout` (F-94).
- **Accounts.** Social sign-in is identity-only: no provider tokens are
  stored, and Microsoft asks only for `openid profile email` (F-150). Block
  and suspend end the user's sessions (F-147). A soft-delete revokes the
  user's API keys and OAuth clients, and only restore undoes it (F-57, I-19);
  restore hands each membership back for its organization to approve again
  (F-152). An organization's status gates its members (F-09).
- **Created users.** A confined creator (an organization admin, or any API
  key or JWT) enrols the user it creates in its own organization. It needs a
  membership permission (`admin.users.update` or `admin.orgs.update`) to
  create one at all, and `admin.users.manage` as well to create an active
  one, and an address whose domain is bound to another organization is
  refused (#480, #486).
- **Formatting.** Dates and numbers follow the viewer's saved time zone,
  date format, number format and language (F-37).

### Removed

- The HS256 SSO handoff and `SSO_HANDOFF_JWT_SECRET` (#398).
- `SEED_DEFAULT_ORGANIZATION_SLUG` (F-40) and `DOCS_ALLOW_MDX_EXECUTION`,
  which did nothing (I-06).
- Docs frontmatter in anything but YAML: a `---js` block is no longer
  evaluated, and the doc is hidden (F-86).
- The unused nested-apps menu route, the unmounted shell store and its
  toggles (I-02, I-10), and the `zustand`, `date-fns`,
  `@radix-ui/react-icons` and `next-themes` dependencies (I-10, #228).

### Security

#### Credentials and authorization

- Every credential issuance (API key, OAuth client, on-behalf key,
  rotation) is bounded at one chokepoint by the issuer's live authority, and
  a bearer caller of `/api/v1/me*` is confined to its tenant (F-01, #471);
  on-behalf issuance needs the scope and the permission (F-05, #318).
- A bound machine credential reaches only its organization (MACHINE-2,
  #443). JWTs die with the key or client they were minted from, their TTL is
  capped by the key's expiry, and MCP tokens carry an RFC 8707 audience
  (#407). A banned principal cannot mint at the token endpoint (#189). An
  OAuth secret rotates only while the client is active (F-72).
- Conferral and revocation guards: a role, group or invitation never grants
  what the actor lacks (#320, #382, F-11), and every grant asks one
  eligibility rule (F-154); removing a membership removes that
  organization's grants (F-12); revocations cannot strip the last superadmin
  who can sign in, bans included (#444, F-56, F-128). An admin cannot act on
  an account that outranks them (#383, F-61), and the account-wide actions
  on a user shared with another tenant are superadmin-only (F-60, F-61).
- Better Auth-backed admin actions from bearer callers run behind the app's
  guards (F-13, F-14); Better Auth's admin plugin endpoints are closed to raw
  HTTP (review #3); RSC pages are gated to the authority of their API
  (#425); the console offers only actions whose guards the viewer passes
  (F-66, F-67), and the privilege guards inside its handlers write a denied
  audit row when they refuse (F-58).
- An organization admin's test email goes only to their own address, and
  admin-sent mail is budgeted per organization in Postgres (F-64).
  Approving an agent's service account needs `admin.clients.manage` on every
  path (F-77).

#### Sign-in, sessions and impersonation

- No provider account links into an account without mailbox proof (F-03,
  #305, #399), and only a superadmin may bind an email domain to an
  organization (F-04). GitHub sign-ins place only through that binding and
  never create an organization (F-52).
- Sign-up and password-reset answers no longer reveal whether an account
  exists (F-20); failed email sign-ins are logged and limited per account,
  10 per 15 minutes (F-55); names are bounded and may not carry control or
  bidirectional characters (F-21).
- A password reset or an admin-set password ends every session, API key and
  OAuth client of the account (F-10); over-age sessions are refused on
  Better Auth's own endpoints too (F-54).
- Impersonation: never from an impersonated session (F-02), confined to the
  impersonator's tenancy (#319, #445), limited to an allow-list of Better
  Auth endpoints (F-06), attributed to the human impersonator (F-07), ended
  when the impersonator is banned, signs out everywhere or has a password
  replaced, and capped at one hour (F-08), refused for
  a target the shell would not admit (F-148), with the account overview
  confined to the impersonator's reach (F-65).
- Accepting an invitation re-checks the inviter's standing and voids the
  invitation of an inviter who lost it (F-149).

#### SSO and MCP

- Handoffs are signed with an Ed25519 key only the issuer holds (#398,
  F-80); the enterprise-app origin allow-list is checked against the Public
  Suffix List and fails closed (#392); the primary cannot be registered as
  its own target (F-83); `sso-session/create` refuses any HTTP call (F-81);
  impersonated launches are refused and consume is bound to its app (#384);
  consume and a signed-out launch share a per-IP bucket (F-19).
- MCP tool arguments are validated against their schemas, JSON-RPC and
  Streamable HTTP are enforced, a revoked agent cannot be changed, and tool
  output is fenced as untrusted (#422); `/api/mcp` has a per-IP floor
  (F-78); the registration reaper works in batches and audits each expiry
  (F-75, F-79); the Agents console shows an agent's provenance (I-03).

#### HTTP, data and supply chain

- A per-request nonce CSP is enforced (#208); dotted sign-in paths get the
  proxy's headers (F-106); `returnTo` refuses dot segments, controls and
  encoded separators (I-17); the organization-apply link is throttled
  (F-105).
- The client IP is normalized and IPv6 limited per /64 (F-16, F-17, #397);
  each per-IP bucket is checked before its global floor (F-18); pre-auth
  refusals are logged and counted rather than written to the audit table
  (F-15).
- One-time tokens are redacted from outbox rows (#386, migration `0003`);
  a queued invitation email is dropped once its invitation dies (F-100);
  Sentry transactions, spans and Session Replay are scrubbed (#396, F-23);
  the docs viewer never evaluates frontmatter, fails closed on a bad field,
  and authorizes the document it renders (F-86, F-87, I-18).
- Next 16.3.5 for two critical unauthenticated RCE advisories,
  GHSA-2xp9-vwfh-vxw4 and GHSA-p293-qw3h-jr36 (#433); the 2026-09 dependency
  sweep and an npm-free runtime image (#385); a 24-hour release cooldown
  and a hash-pinned pnpm (#426); a scheduled dependency audit covering both
  lockfiles (#402, F-28); digest-pinned base images with a Trivy scan
  (#218), and a CI job that boots the image it scans (F-108).
- `drk-deploy` keeps secrets off argv and out of child processes, stores
  them `sensitive`, and refuses an incomplete environment listing instead of
  regenerating live secrets (F-138, F-139, F-142, F-143).

### Fixed

- **Data integrity.** Sign-up provisioning, invitation acceptance and
  sign-in activation are atomic and converge on concurrent duplicates
  (F-95); role and permission deletes lock before they count (F-97);
  unique and foreign-key violations are recognised by SQLSTATE (F-132);
  revoked credentials no longer block an organization delete, and a launched
  enterprise app deletes with its nonces (F-98, F-84); the export pages on
  full-precision cursors (F-31); the audit and outbox searches use an index
  for every arm (F-93, migration `0007`).
- **Email.** A transient provider failure is retried inline, the drain
  leases rows so a message is not sent twice, and an undelivered invitation
  is reported (F-99, F-101, F-104); token lifetimes live in one place
  (F-103); a taken email is `409` (F-30).
- **Audit.** Every admin audit row names its tenant (F-32), and a page
  error's Support ID can be found in the logs without Sentry (F-110).
- **Console.** Pickers search the server (F-41), settings tabs send only
  changed fields (F-39), dual-list editors re-read after each save (F-38),
  bulk select-all acts on every match or none and never on the caller
  (F-62, F-114), statuses, the Agents console and invitation refusals are
  translated (F-116, F-118, F-156), tab edits survive a tab switch (F-158),
  and a banned sign-in says so (F-153).
- **Shell and accessibility.** One breakpoint for the sidebar (F-36);
  switching language keeps the query string (F-35); an organization switch
  reloads org-scoped views (F-68); the deep link survives a dead session
  (F-70); the shadcn primitives' Tailwind 3 classes compile under Tailwind 4
  (F-119); dialogs, warnings, the sidebar and the grid are more accessible
  (F-117, F-120 to F-122); each route group gets only the messages it reads
  (F-123).
- **Docs viewer.** Relative links resolve from the document's own folder,
  heading and footnote ids no longer collide with the shell's (F-90, F-91),
  and the docs and help functions ship only their content, not the working
  tree (F-88).
- **Operations.** Graceful shutdown hands SIGTERM to Next's drain (#404);
  the retention prune and the MCP reaper work in bounded batches under a
  time budget (F-96, F-75); the session's organization resolves from an
  active membership first (F-33).

## [1.0.0] - 2026-06-18

The first stable release. Closes the 1.0 blockers and the full second-pass
hardening review (`PRODUCTION-READINESS-1.0.md`,
`PRODUCTION-READINESS-1.0-REVIEW-2.md`). Highlights:

### Added

- CI security scanning: CodeQL (`javascript-typescript`) and gitleaks secret
  scanning with SARIF upload; `pnpm audit` promoted to a hard gate.
- `/api/health` (liveness) and `/api/health/ready` (readiness, `select 1`)
  endpoints; a `HEALTHCHECK` wiring readiness into the container image.
- Always-on structured (pino) server logging carrying `request_id`.
- Graceful SIGTERM/SIGINT shutdown that drains the PostgreSQL pool.
- Forward database-migration convention (`0002+`) atop the frozen `0001`
  baseline; index on `app_sso_handoff_nonces.expires_at`.
- Administrator user-detail Roles and Audit tabs; Organization column on the
  Roles grid.
- System-wide form validation (React Hook Form + Zod): required-field markers,
  error-border highlighting, shared client/server schemas, accessibility.
- Governance docs: `SECURITY.md`, `CONTRIBUTING.md`, this changelog;
  `engines` / `.nvmrc`; `LICENSE` (MIT).
- CSP violation report sink (`/api/security/csp-report`); OpenAPI
  `/users/{id}/roles` + `/audit` endpoints with a regenerated admin SDK and an
  SDK-drift CI gate.
- Email outbox retry worker with exponential backoff (`pnpm outbox:drain`) and
  data-retention pruning (`pnpm db:prune`: expired token revocations + audit /
  outbox windows).
- Committed Better Auth identity-schema snapshot with a drift CI gate.
- DB-backed integration test tier (`pnpm test:db`) plus end-to-end coverage of
  the SSO handoff and client-credentials machine flows.
- Markdown link checker; Dependabot with SHA-pinned GitHub Actions and
  digest-pinned tool images.
- Process-level `unhandledRejection` / `uncaughtException` handlers
  (log + Sentry + controlled exit).

### Fixed

- Authorization (ADR-0001): org-scoped user lifecycle for non-superadmins;
  ban now revokes API keys/JWTs; bearer credentials bound to their minted org;
  role/group conferral can never grant a permission the actor lacks
  (including group-membership self-escalation); superadmin can impersonate org
  admins.
- App-shell double scrollbar at narrow widths; duplicate `banner` and bogus
  `application` ARIA landmarks.
- Email provider HTTP calls now time out instead of hanging the request.
- Bumped `undici` (and `kysely` / `better-auth`) to clear advisories.

### Security

- `app_audit_events` is now append-only — a database trigger blocks
  UPDATE/DELETE outside the explicit retention job, making the audit log
  tamper-evident.
- Server-side 5xx errors are captured to Sentry, tagged with the `request_id`
  that correlates the structured log, the audit row, and the Sentry issue.

### Changed

- Documented single-instance as the supported 1.0 deployment topology (the
  abuse-guard rate limiter is in-process; a shared backend is post-1.0).
- Documented the `pnpm audit` GHSA allowlist — per-advisory package,
  reachability rationale, and review date — in `SECURITY.md`.

> Older history predates this changelog; see the git log and the
> `PRODUCTION-READINESS-1.0*.md` reviews.
