# Get Started — Developer Onboarding Guide

Welcome to **devresponsekit**. This guide is written for a mid‑level
developer joining the project. It walks you through the source layout,
the authentication boundary, the routing model, and the UI composition
patterns (control composition, props drilling, and nested application
shells) so that you can land your first change with confidence.

> **Just want to stand up an instance?** For a linear install → configure →
> deploy runbook — from a fresh `git clone` to a deployed instance — follow
> [setup-guide.md](setup-guide.md) first, then return here for the
> architecture orientation. (The condensed local setup is also in §8 below.)

> File paths, exports, and commands referenced below correspond to real
> artifacts in this repository. When in doubt, follow the citations and
> read the source — it is the ultimate source of truth.

---

## Table of contents

1. [What this app is](#1-what-this-app-is)
2. [Tech stack at a glance](#2-tech-stack-at-a-glance)
3. [Source code layout](#3-source-code-layout)
4. [Authentication](#4-authentication)
   - 4.1 [Better Auth server instance](#41-better-auth-server-instance)
   - 4.2 [The two-layer access boundary](#42-the-two-layer-access-boundary)
   - 4.3 [Session lifecycle and provisioning](#43-session-lifecycle-and-provisioning)
   - 4.4 [Client-side auth helpers](#44-client-side-auth-helpers)
   - 4.5 [Outbound email](#45-outbound-email)
   - 4.6 [Machine authentication (`/api/v1`)](#46-machine-authentication-apiv1)
5. [Routing](#5-routing)
   - 5.1 [Localized App Router tree](#51-localized-app-router-tree)
   - 5.2 [Route regions: secure / auth / public](#52-route-regions-secure--auth--public)
   - 5.3 [The `proxy.ts` edge layer](#53-the-proxyts-edge-layer)
   - 5.4 [API routes](#54-api-routes)
6. [UI patterns](#6-ui-patterns)
   - 6.1 [Control composition](#61-control-composition)
   - 6.2 [Props drilling — when and why](#62-props-drilling--when-and-why)
   - 6.3 [Nested application shells](#63-nested-application-shells)
   - 6.4 [Server vs client component boundaries](#64-server-vs-client-component-boundaries)
7. [State, i18n, and data](#7-state-i18n-and-data)
8. [Local setup and common commands](#8-local-setup-and-common-commands)
9. [Where to look next](#9-where-to-look-next)

---

## 1. What this app is

`devresponsekit` is an **enterprise Next.js 16 “Holy Grail” application
shell** with first‑class authentication, internationalization, and a
nestable shell layout. Unauthenticated visitors land on a **localized
marketing landing page** at `/[locale]` (the public home — hero, feature
highlights, and a call to action to the GitHub repository, fully
translated via the `public` message namespace). The authenticated product
surface lives behind `/[locale]/app/*` and is composed of top‑level
applications — Dashboard,
Account (self-service), Workspace, an in-app Docs viewer, and
Administrator — inside a single shell that you can extend with new
sub‑applications. Supporting subsystems include outbound email
(outbox-first, Resend/Mailgun), cross-subdomain SSO handoff, an in-app
Markdown documentation reader (see `docs/docs-viewer.md`), and a
versioned **machine API** (`/api/v1`)
authenticated by API keys or JWT bearer tokens (see
`docs/api-and-cli-guide.md`).

The defining architectural choices are:

- **Server components by default**, with thin client components at
  interaction boundaries.
- A **single proxy + per‑layout server guard** model for auth — no
  duplicated checks scattered across pages.
- A **composable shell** (`ShellContainer` at the root, `ApplicationShell`
  for nested workspaces) that uses controlled visibility props so layouts
  remain deterministic and testable.

---

## 2. Tech stack at a glance

| Concern              | Choice                                             |
| -------------------- | -------------------------------------------------- |
| Framework            | Next.js 16 (App Router, React 19)                  |
| Language             | TypeScript 5.9 (strict)                            |
| Auth                 | Better Auth 1.6.9 with the `admin`, `ssoSession`, and `nextCookies` plugins |
| Machine API          | API keys + Ed25519 JWT (`jose`), JWKS, OAuth clients (`src/lib/api-auth/`) |
| Database             | PostgreSQL via Kysely (no ORM); `pg` Pool          |
| i18n                 | `next-intl` (locale always in URL)                 |
| Styling              | Tailwind CSS v4 + Radix UI primitives              |
| Client state         | Zustand (`src/stores/app-shell-store.ts`)          |
| Validation           | Zod                                                |
| Tests                | Vitest (unit/component/integration/security), Playwright (e2e/a11y) |
| Package manager      | `pnpm` (`pnpm@10.33.2`)                            |

See `package.json` for exact versions. Do **not** add Prisma, Drizzle,
React Query, Redux, or another router — those choices are intentional.

---

## 3. Source code layout

```
src/
├── app/                          Next.js App Router tree
│   ├── (root)/                   Bare "/" → default-locale redirect (own minimal root layout)
│   ├── api/                      Route handlers (auth, account, administrator, navigation, sso, preferences, v1)
│   └── [locale]/
│       ├── layout.tsx            Root layout: <html lang> + theme + NextIntlClientProvider
│       ├── (public)/             Localized marketing landing page (/[locale]) + about / docs / logged-out
│       ├── (auth)/               sign-in, sign-up, forgot-password, reset-password, status pages
│       └── (secure)/             Authenticated product surface
│           ├── layout.tsx        Server-side auth boundary + root shell
│           ├── _components/      Route-private client components
│           └── app/
│               ├── dashboard/    Landing workspace
│               ├── account/      Self-service account (profile, preferences, security, api-keys)
│               ├── workspace/    Nested ApplicationShell example
│               ├── docs/         In-app Markdown docs viewer (+ /[...slug])
│               └── administrator/  Admin console (users, roles, permissions, orgs, memberships, apps, api-keys, audit, email)
│
├── components/
│   ├── admin/                    Admin console client widgets
│   ├── api-keys/                 API-key issue/rotate dialogs (shared admin + account)
│   ├── app-shell/                ShellContainer, ApplicationShell, regions
│   ├── auth/                     Sign-in/up forms, sign-out, panels
│   ├── i18n/                     LocaleLink, LocaleSwitcher
│   ├── navigation/               Menu types + API client
│   ├── observability/            Web Vitals reporter + client error boundary
│   ├── theme/                    Theme provider + toggle
│   └── ui/                       Radix-based design system primitives
│
├── config/
│   ├── i18n-config.ts            Supported locales, default locale
│   └── route-regions.ts          classifyRoute() — single source of truth
│
├── db/                           Kysely instance, numbered migrations, seeds
├── hooks/                        Shared client hooks
├── i18n/                         next-intl routing & request config
├── lib/                          auth, guards, env, audit, jwt-handoff, + subsystem folders:
│   ├── admin/                    admin permission guard, list-query, status, roles helpers
│   ├── account/                  self-service account guard + helpers
│   ├── api-auth/                 machine-API auth: API keys, JWT/JWKS, scopes, OAuth clients
│   ├── docs/                     in-app docs reader: source, frontmatter, sanitize-first render pipeline
│   ├── email/                    outbox-first sender, Resend/Mailgun providers, templates
│   └── observability/            Sentry scrubbing + Web Vitals helpers
├── messages/                     Locale JSON message catalogs
├── stores/                       Zustand stores (client only)
├── styles/                       Tailwind layers, design tokens
├── proxy.ts                      Edge proxy (locale + cookie redirect)
├── instrumentation.ts           Server/edge bootstrap + onRequestError → Sentry
└── instrumentation-client.ts    Client Sentry init (Web Vitals, masked replay)
```

> The `sentry.server.config.ts` / `sentry.edge.config.ts` files also live
> at the `src/` root; observability is opt-in (see
> [observability.md](observability.md)).

A few conventions to internalize early:

- **Route groups in parentheses** (`(public)`, `(auth)`, `(secure)`) do
  not affect the URL — they only group layouts.
- **`_components/`** folders are route‑private; never import from another
  route’s `_components/`. Promote it to `src/components/...` first.
- **`*.server.ts`** files start with `import "server-only"` and must
  never be reached from a client component (ESLint will catch you).
- **Barrel files** are used sparingly. The notable one is
  `src/components/app-shell/index.ts` — import shell pieces from there.

---

## 4. Authentication

### 4.1 Better Auth server instance

The single Better Auth instance lives at `src/lib/auth.ts`. It is wired
to PostgreSQL through the `pg` Pool and configured for:

- email + password, including password reset (`sendResetPassword`
  renders and records the email through the outbox — see §4.5),
- Google, Microsoft (Entra ID, multi‑tenant), and GitHub social logins,
- account linking only when the verified email matches,
- 8‑hour rolling sessions, refreshed every 15 minutes of activity,
- plugins, in order: `admin()` (ban/impersonation), `ssoSession()`
  (a server-only endpoint that establishes the consumer session on SSO
  handoff — never mounted on HTTP), and `nextCookies()` (must stay last).

It exports both `auth` (the server API) and an `AuthSession` type alias.
Anything server‑side that needs a **browser session** reads it through
`auth.api.getSession({ headers })` — that is the only supported path for
cookie auth. Machine clients are different: the `/api/v1` surface
authenticates with API keys or JWT bearer tokens, resolved separately by
`src/lib/api-auth/` (see §4.6 and §5.4).

### 4.2 The two-layer access boundary

Authentication uses **two cooperating layers** — keep them straight in
your head because they have very different responsibilities.

1. **Edge proxy (`src/proxy.ts`)** — runs before any layout. It does a
   cheap cookie sniff (`getSessionCookie` from `better-auth/cookies`) on
   localized secure paths and redirects to `/<locale>/sign-in?returnTo=…`
   when no session cookie is present. It performs **no DB calls** and is
   **not** the authorization boundary. Its job is to prevent the
   authenticated shell from flashing for logged‑out users and to wire up
   `next-intl` locale routing.

2. **Server-side guard (`src/lib/auth-guard.ts → requireSecureSession`)** —
   called from `src/app/[locale]/(secure)/layout.tsx`. This is the
   **real authorization boundary**. It:
   1. resolves the session from request headers,
   2. loads the application user’s access context
      (`getUserAccessContext`),
   3. applies the pure decision function `decideSecureAccess` over user
      + membership status, and
   4. **redirects** (never returns a falsy value) to `sign-in`,
      `pending-approval`, or `blocked` for any failure.

By the time JSX in `(secure)/layout.tsx` renders, the user is guaranteed
to be `active` with an `active` organization membership — pages
downstream may rely on that invariant.

> **Mid‑level pitfall:** never re‑implement the cookie check inside a
> page. If you need session data inside a server component, call
> `getCurrentSession()` from `@/lib/auth-guard`. If you need
> *authorization*, you are inside the secure tree already — use the
> `access` context the layout produced (passed via props) rather than
> re‑querying.

### 4.3 Session lifecycle and provisioning

Better Auth manages the `user` / `session` / `account` tables. The
**application** has its own `app_users` and membership tables (see
`src/db/schema/`). `getUserAccessContext` joins those and returns:

```
{ appUserId, primaryEmail, status, organizationId,
  membershipStatus, preferredLocale, permissions }
```

If a Better Auth user has not yet been provisioned into `app_users`
(the gap between sign‑up and the first call to
`src/lib/user-provisioning.server.ts`), the helper returns a synthetic
`pending_approval` context. Treat any non‑`active` status as a hard
block — `decideSecureAccess` already encodes that rule; do not bypass it.

For cross‑application handoff (single sign‑on into satellite apps), the
short‑lived JWT mint lives in `src/lib/jwt-handoff.server.ts` and is
exposed under `/api/sso/*`. It requires `SSO_HANDOFF_ISSUER`,
`SSO_HANDOFF_JWT_SECRET`, and `SSO_HANDOFF_AUDIENCE_PREFIX` env vars (all
validated at boot). `/api/sso/consume` verifies the token, consumes its
one‑time `jti` nonce, and then establishes a real Better Auth session for
the verified subject through the server‑only `ssoSession` plugin,
forwarding the signed session cookie on the dashboard redirect — so a
launched user lands signed in. See
[setup-sso-multi-app.md](setup-sso-multi-app.md) for the full flow.

### 4.6 Machine authentication (`/api/v1`)

Browser users authenticate with a session cookie; **machine clients**
(CLIs, scripts, service integrations) authenticate against the versioned
`/api/v1` surface with a bearer credential instead:

- an **API key** — `Authorization: Bearer drk_…` (stored only as a
  SHA-256 hash in `app_api_keys`), or
- an **Ed25519 JWT access token** minted at `POST /api/v1/auth/token`
  (public key published at `GET /api/v1/jwks.json`).

The caller is resolved by `src/lib/api-auth/resolve-caller.server.ts`
(order: API key → JWT → session cookie) and each route is gated by
`src/lib/api-auth/v1-guard.server.ts`. A credential's effective authority
is its **scopes ∩ its owner's permissions**, so it can never exceed the
human/service that owns it. Both paths are **disabled by default**
(`API_KEYS_ENABLED` / `API_JWT_ENABLED`). Full guide:
[api-and-cli-guide.md](api-and-cli-guide.md) and
[design-api-keys-and-tokens.md](design-api-keys-and-tokens.md).

### 4.4 Client-side auth helpers

- `src/lib/auth-client.ts` — Better Auth browser client; use it for
  sign‑in/sign‑up forms in `src/components/auth/*`, the password-reset
  request/complete forms, and self-service password change + session
  management in the Account app.
- `src/components/auth/sign-out-button.tsx` — the canonical sign‑out
  control rendered in the secure top bar.

Client components must never read sessions directly from cookies — they
either receive what they need as props (preferred) or call an API route.

### 4.5 Outbound email

Email is **outbox-first**: every message is rendered and recorded in
`app_outbox` *before* any delivery attempt, so the outbox is a complete
record regardless of whether a provider is configured. The sender
(`src/lib/email/send.server.ts`) resolves an editable template
(`app_email_templates`, falling back to the code defaults in
`src/lib/email/templates.ts`), inserts the outbox row, then delegates
delivery to a pluggable provider (`src/lib/email/providers.server.ts` —
Resend or Mailgun, selected by `EMAIL_PROVIDER`). With no provider set
(local dev and CI), rows stay `logged` and nothing is sent. Delivery
failures are recorded, never thrown. Administrators inspect the outbox
and edit templates under `/app/administrator/email`
(`admin.email.read` / `admin.email.manage`). See
[setup-email.md](setup-email.md) for the full integration guide.

---

## 5. Routing

### 5.1 Localized App Router tree

Every browser URL is locale‑prefixed (`/en/...`, `/fr/...`). The locale
prefix is **always** present (`localePrefix: "always"` in
`src/i18n/routing.ts`) so shareable enterprise URLs are unambiguous.

`src/app/[locale]/layout.tsx` is responsible for:

- validating the locale segment (`hasLocale` → `notFound()`),
- calling `setRequestLocale(locale)` for static rendering support,
- loading messages and providing them via `NextIntlClientProvider` to
  every descendant — public, auth, and secure.

`generateStaticParams` pre‑renders the locale segment for every
supported locale at build time.

### 5.2 Route regions: secure / auth / public

`src/config/route-regions.ts` is the **single source of truth** for
classifying a pathname:

| Region   | Match                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| `secure` | `/[locale]/app/*`                                                                         |
| `auth`   | `/[locale]/{sign-in,sign-up,forgot-password,reset-password,pending-approval,blocked}`     |
| `public` | Everything else, including the locale root and any unknown locale (so it cannot be secure)|

(The machine API `/api/v1/*` is **not** classified here — it is not
localized and not session-gated; it has its own bearer-credential guard.)

It exports `classifyRoute`, plus three convenience predicates
(`isLocalizedSecurePath`, `isLocalizedAuthPath`, `isLocalizedPublicPath`).
`src/proxy.ts`, route guards, navigation helpers, and tests all consume
this module — **do not inline path checks** anywhere else. If a new
auth‑shell page is added, extend `AUTH_PATH_SEGMENTS` here and the rest
of the system follows.

### 5.3 The `proxy.ts` edge layer

A few things to know about `src/proxy.ts`:

- It is named **`proxy.ts`** per Next.js 16. Only the `proxy` export is
  allowed — defining a `middleware` alias in the same file is forbidden
  by Next.js 16 and will fail the build.
- Its `config.matcher` excludes `api`, `_next/static`, `_next/image`,
  the favicon, and any path containing a `.`. API auth is enforced by
  the route handlers themselves (and by Better Auth).
- `/favicon.png` is served as a static file from `public/` and declared in
  the root metadata, so favicon requests never enter the localized App
  Router tree.
- It composes two responsibilities in order: (1) cookie‑gated redirect
  for secure paths, (2) `next-intl` locale routing.
- The `[locale]` segment exports `dynamicParams = false`, so requests for
  unsupported locale-like paths (including dotted asset paths such as
  `/favicon.png`) return a static 404 instead of falling through to
  runtime rendering.

### 5.4 API routes

Route handlers live under `src/app/api/`:

- `auth/` — Better Auth catch‑all handler.
- `navigation/` — server‑filtered shell menus consumed by
  `SecureSidebar` (see §6.3). Per the menu‑filter rule, client components
  **never** import a menu manifest directly — they always go through this
  API so role/permission filtering happens server‑side.
- `sso/` — short‑lived JWT mint for cross‑app handoff (`launch`) and the
  consumer endpoint that burns the nonce and establishes the session
  (`consume`).
- `account/` — self-service account endpoints (`profile`, `preferences`),
  guarded by `requireAccountUser` and **strictly self-scoped** to the
  session user (no id is accepted from the client).
- `administrator/` — the guarded admin REST API (users, roles,
  permissions, orgs, enterprise apps, audit, email, CSV export).
- `preferences/` — the user's locale preference.
- `docs/` — auth-gated image-asset streaming for the in-app docs viewer
  (`docs/asset/[...path]`); requires a session + active membership +
  `shell.view`. See [docs-viewer.md](docs-viewer.md).
- `v1/` — the versioned **machine API** (see §4.6). A bearer-auth (API
  key or JWT) REST surface: `me`, `users`, `audit-events`, `auth/token`,
  `jwks.json`, `openapi.json`, and admin sub-routes for `api-keys` /
  `oauth-clients`. Errors are `application/problem+json`.

Each handler is responsible for its own auth check; the proxy does not
gate them (its `config.matcher` excludes `/api/*`).

---

## 6. UI patterns

### 6.1 Control composition

The shell is built from many small, single‑purpose pieces — each one
takes a `ReactNode` slot and renders it in a known position. A consumer
**composes** controls into the shell rather than passing a deep config
object. Concretely, the public surface of `src/components/app-shell/`
(see `index.ts`) gives you region wrappers (`ShellHeader`, `ShellLeft`,
`ShellMain`, `ShellRight`, `ShellFooter`), the root `ShellContainer`,
the nested `ApplicationShell`, and supporting controls like
`ShellVisibilityToggle`, `MobileSidebarTrigger`, `CompactModeToggle`,
`ShellSkipLinks`, and `ApplicationSwitcherSheet`.

A typical secure layout composes them like this (from
`src/app/[locale]/(secure)/layout.tsx`):

```tsx
<ShellContainer
  ariaLabel="DevResponse Enterprise Application"
  branding={
    <TopShellBar>
      <span className="text-sm font-semibold">DevResponse</span>
      <div className="ml-auto flex items-center gap-2">
        <ApplicationSwitcherSheet locale={safeLocale} />
        <LocaleSwitcher current={safeLocale} persistAuthenticated />
        <SignOutButton locale={safeLocale} />
      </div>
    </TopShellBar>
  }
  left={<SecureSidebar locale={safeLocale} permissions={access.permissions} />}
>
  {children}
</ShellContainer>
```

Two principles to absorb:

1. **Slots over flags.** Visual variants are expressed by the *content*
   you pass into `branding`, `left`, `right`, `footer`, etc. The only
   booleans on the shell are `leftVisible` / `rightVisible` /
   `footerVisible` — controlled by the parent so tests are deterministic.
2. **One brand bar, ever.** `TopShellBar` lives at root depth only.
   Nested shells (§6.3) must **not** render a second one.

### 6.2 Props drilling — when and why

This codebase **deliberately drills props** for a small, well‑defined
class of values rather than using React Context for everything. The rule:

- **Drill** values that the layout has already authoritatively resolved,
  whose source of truth is the request — `locale`, `access.permissions`,
  the resolved `session.user.id`, the `safeLocale` after validation.
  Drilling preserves the server boundary: server components compute
  these values and hand them to client components as plain serializable
  props.
- **Use Context** for genuinely cross‑cutting client concerns, e.g.
  `ShellDepthProvider` (so nested shells know their depth without the
  caller specifying it) and `NextIntlClientProvider` (so any descendant
  can call `useTranslations`).
- **Use Zustand** (`src/stores/app-shell-store.ts`) for ephemeral *UI*
  state shared across unrelated components — the canonical case is
  region visibility toggled from the header.

The reason for this discipline: secure layouts already do the
authorization work once. Re‑reading the session in deep components
would re‑hit the database and risk drift between “what the layout
allowed” and “what the page believes.” Passing `permissions` and
`locale` down keeps everyone consistent and makes components trivially
testable with `renderWithIntl(<Foo permissions={[…]} locale="en" />)`.

A practical example from the secure tree:

```
SecureLayout (server)
  └─ requireSecureSession() → { session, access }
     └─ <SecureSidebar locale={safeLocale}
                       permissions={access.permissions} />   // client
```

`SecureSidebar` then uses `permissions` only as a quick gate (skip the
fetch if empty) and otherwise calls `/api/navigation/shell-menu`, which
re‑filters server‑side using the *real* session — defense in depth.

### 6.3 Nested application shells

The shell composes recursively. The root shell is `ShellContainer`
(`src/components/app-shell/shell-container.tsx`) which wraps a
`ShellGridContainer` with `variant="root"` and a depth of `0`. It also
installs a `ShellDepthProvider` so descendants can ask “what depth am I
at?”.

Inside `ShellMain`, a route can mount an `ApplicationShell`
(`src/components/app-shell/application-shell.tsx`) — a **client
component** because it must read the depth context to compute
`depth + 1`. It re‑uses `ShellGridContainer` with `variant="nested"`
which switches the CSS variables to nested dimensions
(`data-variant="nested"`).

The canonical example is the workspace
(`src/app/[locale]/(secure)/app/workspace/layout.tsx`):

```tsx
export default function WorkspaceLayout({ children }) {
  return (
    <ApplicationShell ariaLabel="Workspace shell" left={<WorkspaceSidebar />}>
      {children}
    </ApplicationShell>
  );
}
```

Rules of nesting:

- The nested `ApplicationShell` must **not** render `TopShellBar` —
  only the root brand bar exists.
- Nested shells get their own `left` / `right` / `footer` slots that are
  scoped to that workspace.
- The root shell is **viewport‑bounded** (`h-screen` via
  `CompactDensityWrapper`); each region owns its own scrolling. Don’t
  add page‑level scroll containers that fight the shell.

This composition is what lets us add a new sub‑application (e.g. a
“Reports” app with its own sidebar and footer) without touching the
secure layout — you simply create a new folder under
`src/app/[locale]/(secure)/app/<your-app>/` with a `layout.tsx` that
mounts an `ApplicationShell`.

### 6.4 Server vs client component boundaries

Quick reference for new contributors:

| Component                     | Kind   | Why                                          |
| ----------------------------- | ------ | -------------------------------------------- |
| `(secure)/layout.tsx`         | Server | Uses `headers()`, DB; produces `access`      |
| `ShellContainer`              | Server | Pure layout; safe in any tree                |
| `ApplicationShell`            | Client | Reads `useShellDepth()`                      |
| `SecureSidebar`               | Client | `useState`, `useEffect`, fetch               |
| `LocaleSwitcher`              | Client | Router push, persisted preference            |
| Sign‑in / sign‑up forms       | Client | Form state, `auth-client` calls              |

When in doubt, default to **server**. Add `"use client"` only when the
component owns hooks, browser APIs, or event handlers it cannot proxy
through a child.

---

## 7. State, i18n, and data

- **i18n.** Always render text through `useTranslations("namespace")`
  (client) or `getTranslations` (server). Message catalogs live in
  `src/messages/<locale>.json`. Use `LocaleLink` / `LocaleSwitcher` for
  navigation so the locale prefix is preserved.
- **Client UI state.** Use `src/stores/app-shell-store.ts`. Keep stores
  small and serializable; do not persist auth identity in client state.
- **Server data.** Reach the database through Kysely (`src/db/database.ts`).
  Server‑only modules end with `.server.ts` and start with
  `import "server-only"`. Never import them from a client component.
- **Validation.** Use Zod schemas at every trust boundary (route handlers,
  server actions, env parsing in `src/lib/env.ts`).

---

## 8. Local setup and common commands

Prerequisites: Node 22+, `pnpm@10`, Docker (for Postgres).

```bash
pnpm install
cp .env.example .env            # used by Next.js and the pnpm db:* scripts

pnpm db:up                      # start pgvector/pgvector:pg17 on localhost:5444
pnpm db:auth:migrate            # Better Auth (vendor) schema
pnpm db:app:migrate             # the complete application schema (single 0001-initial-schema.sql)
pnpm db:seed                    # local seed data (baseline roles, apps, admin user)

pnpm dev                        # next dev on http://localhost:3000
```

The default local admin created by `pnpm db:seed` is
`admin@devresponse.local` / `ChangeMe-LocalOnly-123!` unless you override
`SEED_ADMIN_EMAIL` or `SEED_ADMIN_PASSWORD` in `.env`.

For multi-organization testing, the optional `pnpm db:seed:dev` loads three
organizations with seven accounts each (superuser / org admin / five users) —
see [setup-guide.md](setup-guide.md#optional-load-multi-organization-test-data).

If `pnpm db:seed` fails with `relation "user" does not exist`, Better Auth's
vendor tables were not created yet. Run `pnpm db:auth:migrate` before
`pnpm db:seed`.

To wipe the database and rebuild it from a blank slate — the quickest way to
re-test initial setup — run **`pnpm db:reset:reload`**. It drops every table
(app, Better Auth, and the migration ledger), then re-runs the auth + app
migrations and the seed in one step. The rebuild is orchestrated in-process, so
it works the same in cmd, PowerShell, and bash. It refuses non-local
`DATABASE_URL` hosts and a bare `pnpm db:reset` is a no-op dry run — see
[setup-guide.md → Resetting the database](setup-guide.md#resetting-the-database).

`pnpm db:up` maps the container's internal Postgres port `5432` to host
port `5444`, matching the default `DATABASE_URL` in [`.env.example`](../.env.example).

Quality gates (run these before opening a PR):

```bash
pnpm typecheck
pnpm lint
pnpm format:check

pnpm test:unit
pnpm test:component
pnpm test:integration
pnpm test:security
# optional, slower:
pnpm test:e2e
pnpm test:a11y
```

`pnpm build` / server boot requires the env vars validated by
`src/lib/env.ts`: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`DATABASE_URL`, `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_JWT_SECRET`, and
`SSO_HANDOFF_AUDIENCE_PREFIX`. (The build phase substitutes placeholders,
so a missing var surfaces as a terse Zod error at real server start.) If
you enable a provider/feature, its companion secret becomes required too
(`EMAIL_PROVIDER=resend` → `RESEND_API_KEY`; `API_JWT_ENABLED` →
`API_JWT_PRIVATE_KEY`).

---

## 9. Where to look next

- `specs.md` — the full product/architecture specification, with
  numbered sections (e.g. §4.4 app‑shell, §17.1 nesting, §28.4 density)
  that are referenced by inline comments throughout the codebase.
- `docs/setup-better-auth.md` — deep dive on schema, migrations,
  social provider configuration, and deployment.
- `docs/setup-email.md` — outbound email + provider integration.
- `docs/setup-sso-multi-app.md` — cross-subdomain SSO across two or
  more apps.
- `docs/api-and-cli-guide.md` and `docs/design-api-keys-and-tokens.md` —
  the `/api/v1` machine API (API keys, JWT, OAuth clients).
- `src/components/app-shell/index.ts` — the shell barrel; the fastest
  way to discover what is composable.
- `src/config/route-regions.ts` and `src/proxy.ts` — start here when
  changing anything about routing or auth gating.
- `tests/helpers/render-with-intl.tsx` — the helper you’ll use for
  every component test.

When you’re ready to make your first change, pick a small bug or
copy tweak inside a single route, write a Vitest component test next
to it, and follow the existing patterns. Welcome aboard.
