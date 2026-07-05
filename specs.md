> **⚠️ HISTORICAL — original pre-build specification (V9).** Retained for reference and for the `specs.md §N` citations in source comments. NOT maintained; it describes the greenfield build plan and may not reflect the shipped 1.0 system. For current documentation see [docs/](docs/README.md) and [CHANGELOG.md](CHANGELOG.md).

# Enterprise Next.js 16 Holy Grail Application Shell — Development Specification V9

**Document status:** final standalone implementation specification.  
**Implementation mode:** greenfield repository.  
**Target stack:** React 19, Next.js 16 App Router, TypeScript, Tailwind CSS 4, shadcn/ui, Radix primitives, lucide-react, Zustand, Better Auth, PostgreSQL, Kysely, Docker Compose, `next-intl`, `jose`, Zod, Vitest, Testing Library, Playwright, axe.

---

## 1. Primary objective

Build a production-grade enterprise frontend application framework from scratch.

The application must include:

1. A nestable, CSS Grid-based Holy Grail application shell with an extra sticky `TopShellBar`.
2. Better Auth authentication with email/password and social login.
3. Social providers: Google, Microsoft, and GitHub.
4. PostgreSQL persistence with Kysely for application tables and a Kysely-compatible Better Auth database integration.
5. Multitenant organization assignment from provider organization data, with a `default` organization fallback.
6. App-managed roles, memberships, and permissions in application tables.
7. Local-only sign-out per subdomain.
8. Secure cross-subdomain app switching through short-lived JWT handoff.
9. Locale-aware browser routing and translated UI using `next-intl`.
10. Compact shadcn UI density for secure enterprise pages.
11. API-driven navigation menus with skeleton placeholders.
12. Strict automated test coverage across unit, component, route integration, security, E2E, and accessibility layers.
13. Mandatory source-code documentation through JSDoc-style component comments and meaningful inline comments.

This specification must be treated as the first and only source of truth. It is not a migration guide.

---

## 2. Locked implementation decisions

These decisions are final.

| Area | Decision |
|---|---|
| Repository | Create a new repo from scratch. |
| Framework | Next.js 16 App Router with React 19 and TypeScript. |
| Styling | Tailwind CSS 4 and shadcn/ui. |
| Component source | Use shadcn/ui components only for shell/auth application UI primitives. |
| Database | PostgreSQL. |
| Database query layer | Kysely. |
| Authentication | Better Auth. |
| Better Auth database integration | Use the current Kysely-compatible Better Auth adapter pattern. Do not use Prisma or Drizzle. |
| Auth methods | Email/password plus social login. |
| Social providers | Google, Microsoft, GitHub. |
| Self-registration | Mandatory. |
| Account linking | Link accounts by matching verified email only. |
| Google | Allow Google accounts; do not restrict to a Google Workspace domain. |
| Microsoft | Allow Microsoft Entra ID multi-tenant work/school accounts. |
| GitHub | Do not restrict by GitHub organization/team membership. |
| New user status | New non-seed users start as `pending_approval`. |
| Admin approval | Required before secure app access. |
| Session duration | 8-hour rolling session, 15-minute update interval, no remember-me option. |
| Route protection | Use both `proxy.ts` and `[locale]/(secure)/layout.tsx`. |
| Post-login redirect | Use safe localized `returnTo` captured before sign-in. |
| Post-logout redirect | Redirect to localized branded logged-out page. |
| Sign-out scope | Local-only per subdomain. |
| SSO switching | `/api/sso/launch` generates a short-lived, one-time-use JWT handoff. |
| Domains | Production examples use `devresponse.com`; primary production app host is `app.devresponse.com`. Development uses `localhost`. |
| Roles | Roles live in app-managed Kysely tables, not Better Auth core tables. |
| MFA | Not included in this version. |
| UI density | Secure enterprise app defaults to compact mode. Public/auth screens default to comfortable mode. |
| App status | Pending, blocked, suspended, and deactivated statuses must be enforced. |
| Menu APIs | API menu routes return JSON status codes only. They never redirect. |
| Seeds | Include local seed users, organizations, roles, permissions, apps, and translations. |
| Tests | Full test suite is required and coverage-gated. |
| i18n | Locale-aware browser routes, localized auth/shell labels, locale switcher, and localized formatting are required. |

---

## 3. Key implementation assumptions

The implementation LLM must not ask follow-up questions for the items below. Use these defaults.

### 3.1 Default locale and supported locales

```ts
export const locales = ["en", "fr", "es", "uk", "pt", "zh", "hi", "ja"] as const;
export const defaultLocale = "en" as const;
```

### 3.2 Browser route model

All browser pages are localized:

```text
/en
/en/sign-in
/en/app/dashboard
/fr/app/workspace
```

API routes are not localized:

```text
/api/auth/[...all]
/api/navigation/applications
/api/sso/launch
```

API routes that return user-facing labels may accept `locale` as a query parameter:

```text
/api/navigation/applications?locale=en
```

### 3.3 Secure app path

The secure application lives under the localized `/app` route:

```text
/[locale]/app/*
```

### 3.4 Organization assignment

On first sign-in/sign-up, assign the user to an organization using provider organization data when available. If not available, assign to the `default` organization.

### 3.5 Admin approval

New non-seed accounts authenticate successfully but cannot access secure routes until approved. They are redirected to:

```text
/[locale]/pending-approval
```

### 3.6 Blocked account handling

Blocked, suspended, and deactivated users are redirected to:

```text
/[locale]/blocked
```

Sensitive API routes return `403` for authenticated users who are blocked, suspended, deactivated, or unauthorized.

### 3.7 SSO handoff

The handoff token is JWT-based, one-time-use, maximum 60 seconds, and transmitted only through a server-controlled redirect. The target app must consume the token immediately and redirect to a clean URL.

### 3.8 Compact mode

Secure app surfaces use compact density by default. Form-heavy secure pages may locally opt into comfortable density when precision matters.

### 3.9 Testing database

Use a dedicated integration-test database or isolated schema. Recommended default:

```bash
DATABASE_TEST_URL="postgresql://devresponse:devresponse@localhost:5444/devresponse_db_test?schema=public"
```

---

## 4. Naming, file, and import conventions

### 4.1 React component names

React component names remain PascalCase.

Required public component names:

```text
TopShellBar
ShellContainer
ApplicationShell
ShellGridContainer
ShellHeader
ShellLeft
ShellMain
ShellRight
ShellFooter
ShellSkipLinks
ShellDepthProvider
ShellVisibilityToggle
MobileSidebarTrigger
ApplicationSwitcherSheet
NavigationMenuSkeleton
SignInForm
SignUpForm
SocialLoginButtons
EmailPasswordLoginForm
EmailPasswordSignUpForm
BlockedAccountPanel
PendingApprovalPanel
LoggedOutPanel
LocaleSwitcher
LanguageMenu
LocaleLink
CompactModeToggle
SignOutButton
```

### 4.2 File names

All source file names must be lowercase and separated by hyphens.

Good:

```text
shell-container.tsx
application-shell.tsx
shell-grid-container.tsx
top-shell-bar.tsx
application-switcher-sheet.tsx
navigation-menu-skeleton.tsx
sign-in-form.tsx
social-login-buttons.tsx
email-password-login-form.tsx
locale-switcher.tsx
compact-mode-toggle.tsx
app-shell-store.ts
auth-client.ts
provider-organization-resolver.ts
safe-return-to.ts
```

Forbidden:

```text
ShellContainer.tsx
ApplicationShell.tsx
TopShellBar.tsx
appShell.store.ts
authClient.ts
```

### 4.3 Imports

Use named exports and lower-case hyphenated paths.

```tsx
import { ShellContainer } from "@/components/app-shell";
import { TopShellBar } from "@/components/app-shell/top-shell-bar";
import { SignInForm } from "@/components/auth/sign-in-form";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
```

Default exports are allowed only where Next.js requires them:

```text
page.tsx
layout.tsx
loading.tsx
error.tsx
not-found.tsx
route.ts
```

### 4.4 Barrel exports

Create `src/components/app-shell/index.ts`:

```tsx
export { ApplicationShell } from "./application-shell";
export { ApplicationSwitcherSheet } from "./application-switcher-sheet";
export { CompactModeToggle } from "./compact-mode-toggle";
export { MobileSidebarTrigger } from "./mobile-sidebar-trigger";
export { NavigationMenuSkeleton } from "./navigation-menu-skeleton";
export { ShellContainer } from "./shell-container";
export { ShellDepthProvider, useShellDepth } from "./shell-depth-provider";
export { ShellFooter } from "./shell-footer";
export { ShellGridContainer } from "./shell-grid-container";
export { ShellHeader } from "./shell-header";
export { ShellLeft } from "./shell-left";
export { ShellMain } from "./shell-main";
export { ShellRight } from "./shell-right";
export { ShellSkipLinks } from "./shell-skip-links";
export { ShellVisibilityToggle } from "./shell-visibility-toggle";
export { TopShellBar } from "./top-shell-bar";

export type {
  ApplicationShellProps,
  EnterpriseApplicationMenuItem,
  NavigationMenuItem,
  NavigationMenuResponse,
  ShellContainerProps,
  ShellControlledVisibilityProps,
  ShellGridContainerProps,
  ShellRegion,
  ShellVisibilityScope,
} from "./shell-types";
```

---

## 5. Source-code documentation standard

Source documentation is required. The implementation is incomplete without it.

### 5.1 Component-level JSDoc

Every exported React component must have a JSDoc block immediately above the component.

The comment must explain:

1. Component purpose.
2. Server Component or Client Component expectation.
3. Main behavioral props.
4. Layout assumptions.
5. Accessibility assumptions.
6. Security, i18n, or loading-state assumptions when relevant.

Example:

```tsx
/**
 * ShellContainer
 *
 * Root application shell for public or secure route layouts.
 * Server-compatible by default. The parent controls region visibility
 * through explicit props so tests and route layouts remain deterministic.
 * The root frame is viewport-bounded; child regions own internal scrolling.
 */
export function ShellContainer(props: ShellContainerProps) {
  // Parent-controlled visibility prevents hidden local state inside shell regions.
}
```

### 5.2 Inline comments inside components

Inline comments must appear at decision points, including:

1. Conditional rendering of public/auth/secure UI.
2. Parent-controlled visibility logic.
3. Bounded scroll container setup.
4. Skeleton loading states.
5. Error and retry states.
6. Accessibility landmarks and focus handling.
7. i18n message usage.
8. SSO launch links and other security-sensitive URLs.

Comments must explain intent, not restate syntax.

Good:

```tsx
// Use a stable skeleton height so the sidebar does not shift when the API menu resolves.
return <SidebarMenuSkeleton />;
```

Bad:

```tsx
// Return sidebar skeleton.
return <SidebarMenuSkeleton />;
```

### 5.3 Route handler documentation

Every Route Handler must include a JSDoc block explaining:

1. The route purpose.
2. Authentication requirements.
3. Authorization behavior.
4. Response status codes.
5. Cache behavior.
6. Audit behavior.
7. Token/cookie/JWT safety assumptions.

Example:

```tsx
/**
 * GET /api/navigation/applications
 *
 * Secure MENU #1 endpoint for the application switcher.
 * Returns SSO launch URLs only; never returns tokens.
 * API routes return JSON status codes and must not redirect.
 */
export async function GET(request: NextRequest) {
  // Validate session here because API routes are independent security boundaries.
}
```

### 5.4 Store and hook documentation

Zustand stores and custom hooks must document:

1. Which state is safe to persist.
2. Which state must never be persisted.
3. Hydration behavior.
4. Why the state belongs on the client.

### 5.5 Security-sensitive documentation

Functions that handle auth, authorization, JWTs, nonces, return URLs, cookies, session checks, provider profiles, or menu filtering must include comments describing the threat or contract being protected.

### 5.6 Comment quality gates

1. No component may be merged without component-level JSDoc.
2. No Route Handler may be merged without status-code and auth-boundary comments.
3. No security-sensitive helper may be merged without a threat/contract comment.
4. `TODO` comments are forbidden unless labelled with a concrete follow-up scope such as `TODO(v2-auth-hardening): ...`.
5. Comments must not include secrets, tokens, private URLs, or environment values.
6. Stale comments are treated as defects.

---

## 6. Project structure

Claude must create this structure from scratch.

```text
src/
  proxy.ts

  app/
    globals.css
    layout.tsx

    api/
      auth/[...all]/route.ts
      navigation/
        applications/route.ts
        nested-apps/route.ts
        shell-menu/route.ts
      sso/
        launch/route.ts
        consume/route.ts
      admin/
        users/[user-id]/approve/route.ts
        users/[user-id]/block/route.ts
        users/[user-id]/suspend/route.ts
        users/[user-id]/reactivate/route.ts
      preferences/
        locale/route.ts

    [locale]/
      layout.tsx
      (public)/
        layout.tsx
        page.tsx
        about/page.tsx
        docs/page.tsx
        logged-out/page.tsx
      (auth)/
        layout.tsx
        sign-in/page.tsx
        sign-up/page.tsx
        forgot-password/page.tsx
        pending-approval/page.tsx
        blocked/page.tsx
      (secure)/
        layout.tsx
        app/
          layout.tsx
          dashboard/page.tsx
          dashboard/loading.tsx
          dashboard/error.tsx
          workspace/
            layout.tsx
            page.tsx
            loading.tsx
            settings/page.tsx
          admin/
            users/page.tsx
            audit/page.tsx

  components/
    app-shell/
      application-shell.tsx
      application-switcher-sheet.tsx
      compact-mode-toggle.tsx
      mobile-sidebar-trigger.tsx
      navigation-menu-skeleton.tsx
      shell-container.tsx
      shell-depth-provider.tsx
      shell-footer.tsx
      shell-grid-container.tsx
      shell-header.tsx
      shell-left.tsx
      shell-main.tsx
      shell-right.tsx
      shell-skip-links.tsx
      shell-visibility-toggle.tsx
      top-shell-bar.tsx
      index.ts
      shell-constants.ts
      shell-helpers.ts
      shell-types.ts

    auth/
      auth-error-alert.tsx
      blocked-account-panel.tsx
      email-password-login-form.tsx
      email-password-sign-up-form.tsx
      logged-out-panel.tsx
      pending-approval-panel.tsx
      sign-in-form.tsx
      sign-out-button.tsx
      sign-up-form.tsx
      social-login-buttons.tsx

    i18n/
      language-menu.tsx
      locale-link.tsx
      locale-switcher.tsx
      localized-date.tsx
      localized-number.tsx

    navigation/
      breadcrumbs.tsx
      global-footer.tsx
      inspector-panel.tsx
      primary-sidebar.tsx
      secondary-sidebar.tsx
      user-menu.tsx
      website-navbar.tsx
      workspace-footer.tsx
      workspace-inspector.tsx
      workspace-navbar.tsx
      workspace-sidebar.tsx
      menu-types.ts
      navigation-api-client.ts

    providers/
      app-providers.tsx
      theme-provider.tsx
      zustand-provider.tsx

    ui/
      alert.tsx
      avatar.tsx
      badge.tsx
      breadcrumb.tsx
      button.tsx
      card.tsx
      command.tsx
      dropdown-menu.tsx
      input.tsx
      label.tsx
      scroll-area.tsx
      select.tsx
      separator.tsx
      sheet.tsx
      skeleton.tsx
      tooltip.tsx

  config/
    app-config.ts
    i18n-config.ts
    route-regions.ts
    shell-config.ts

  db/
    database.ts
    migrations/
      0001-initial-schema.sql   # complete app schema — all app_* tables
      run-migrations.ts
    seeds/
      seed-local.ts
    schema/
      app-schema.ts
      auth-schema-notes.md
      generated.ts

  i18n/
    navigation.ts
    request.ts
    routing.ts

  lib/
    auth.ts
    auth-client.ts
    auth-guard.ts
    auth-status.ts
    audit.server.ts
    cn.ts
    env.ts
    invariant.ts
    jwt-handoff.server.ts
    locale.ts
    navigation.server.ts
    provider-organization-resolver.ts
    safe-return-to.ts
    sso.server.ts
    user-provisioning.server.ts

  messages/
    en.json
    fr.json
    es.json
    uk.json

  stores/
    app-shell-store.ts
    app-ui-store.ts

  styles/
    app-shell.css
    compact-mode.css

  tests/
    setup/
      vitest.setup.ts
      playwright.setup.ts
    helpers/
      auth-test-client.ts
      db-test-utils.ts
      test-data-factories.ts
      render-with-providers.tsx
    unit/
      safe-return-to.test.ts
      provider-organization-resolver.test.ts
      shell-helpers.test.ts
      locale.test.ts
      compact-density.test.ts
    component/
      shell-container.test.tsx
      application-shell.test.tsx
      shell-visibility-toggle.test.tsx
      application-switcher-sheet.test.tsx
      auth-forms.test.tsx
      navigation-skeletons.test.tsx
      locale-switcher.test.tsx
    integration/
      auth.email-password.test.ts
      auth.social-callback.test.ts
      auth.protected-routes.test.ts
      navigation-api.test.ts
      sso-launch.test.ts
      account-status.test.ts
      i18n-routing.test.ts
      compact-mode.test.ts
      admin-user-status-api.test.ts
      audit-events.test.ts
    security/
      return-to-open-redirect.test.ts
      sso-jwt-handoff.test.ts
      menu-api-leakage.test.ts
      account-linking-verified-email.test.ts
      zustand-persistence-safety.test.ts
    e2e/
      auth-flow.spec.ts
      secure-shell.spec.ts
      app-switcher.spec.ts
      i18n-navigation.spec.ts
      responsive-shell.spec.ts
    accessibility/
      auth-pages.a11y.spec.ts
      secure-shell.a11y.spec.ts
      app-switcher.a11y.spec.ts
```

---

## 7. Package and tooling plan

Use `pnpm`.

### 7.1 Runtime dependencies

```bash
pnpm add next react react-dom typescript
pnpm add better-auth @better-auth/kysely-adapter pg kysely kysely-codegen jose zod
pnpm add next-intl
pnpm add clsx tailwind-merge class-variance-authority lucide-react zustand next-themes
pnpm add @radix-ui/react-slot @radix-ui/react-icons
pnpm add -D @types/pg tsx dotenv
```

If Better Auth exposes its Kysely adapter through a different package or import path in the installed version, use the official installed API while preserving the Kysely-based integration.

### 7.2 shadcn/ui setup

Initialize shadcn/ui and add only the components required by this specification.

```bash
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add alert avatar badge breadcrumb button card command dropdown-menu input label scroll-area select separator sheet skeleton tooltip
```

### 7.3 Test dependencies

```bash
pnpm add -D vitest @vitest/coverage-v8 @vitejs/plugin-react vite-tsconfig-paths jsdom supertest undici msw
pnpm add -D @testing-library/react @testing-library/jest-dom @testing-library/user-event
pnpm add -D @playwright/test axe-core @axe-core/playwright
pnpm add -D eslint eslint-config-next prettier prettier-plugin-tailwindcss
```

### 7.4 Required scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:auth:migrate": "tsx src/db/migrations/run-better-auth-migrate.ts",
    "db:auth:generate": "tsx src/db/migrations/run-better-auth-generate.ts",
    "db:app:migrate": "tsx src/db/migrations/run-migrations.ts",
    "db:seed": "tsx --conditions=react-server src/db/seeds/seed-local.ts",
    "db:codegen": "kysely-codegen --out-file src/db/schema/generated.ts",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:component": "vitest run tests/component",
    "test:integration": "vitest run tests/integration",
    "test:security": "vitest run tests/security",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test --config=playwright.config.ts tests/e2e",
    "test:a11y": "playwright test --config=playwright.config.ts tests/accessibility",
    "test:all": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:coverage && pnpm test:e2e && pnpm test:a11y"
  }
}
```

### 7.5 Vitest configuration

Create `vitest.config.ts`.

```ts
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup/vitest.setup.ts"],
    globals: true,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/component/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.ts",
      "tests/security/**/*.test.ts"
    ],
    exclude: ["tests/e2e/**", "tests/accessibility/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 82
      }
    }
  }
});
```

### 7.6 Playwright configuration

Create `playwright.config.ts`.

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } }
  ]
});
```

---

## 8. Environment variables

Create `.env.example`.

```bash
# Application
NODE_ENV=development
NEXT_PUBLIC_APP_NAME="DevResponse Enterprise"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_PRIMARY_HOST="localhost"
NEXT_PUBLIC_PRODUCTION_HOST="app.devresponse.com"
NEXT_PUBLIC_DEFAULT_LOCALE="en"
NEXT_PUBLIC_SUPPORTED_LOCALES="en,fr,es,uk,pt,zh,hi,ja"

# Better Auth
BETTER_AUTH_SECRET="replace-with-strong-random-secret"
BETTER_AUTH_URL="http://localhost:3000"

# PostgreSQL
DATABASE_URL="postgresql://devresponse:devresponse@localhost:5444/devresponse_db?schema=public"
DATABASE_TEST_URL="postgresql://devresponse:devresponse@localhost:5444/devresponse_db_test?schema=public"

# Google social login
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# Microsoft social login
MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""

# GitHub social login
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

# Internal JWT handoff for subdomain SSO. ISSUER + AUDIENCE_PREFIX +
# JWT_SECRET are REQUIRED; APPLICATION_ID is optional at boot but the
# SSO consumer returns 500 without it, so set it per deployment.
SSO_HANDOFF_ISSUER="https://app.devresponse.com"
SSO_HANDOFF_AUDIENCE_PREFIX="devresponse-app"
SSO_HANDOFF_APPLICATION_ID="portal"
SSO_HANDOFF_JWT_SECRET="replace-with-separate-strong-secret"
# Accepted up to 300; the signer clamps the effective token TTL to 60s.
SSO_HANDOFF_TTL_SECONDS=60

# Extra trusted origins for the admin mutation/origin guard (comma-sep).
ADMIN_TRUSTED_ORIGINS="https://app.devresponse.com"

# Outbound email (§35). Unset EMAIL_PROVIDER = no delivery (rows logged).
# EMAIL_PROVIDER="resend"            # "resend" | "mailgun"
EMAIL_FROM="DevResponse <no-reply@localhost>"
# RESEND_API_KEY=""                  # required when EMAIL_PROVIDER=resend
# MAILGUN_API_KEY=""                 # required when EMAIL_PROVIDER=mailgun
# MAILGUN_DOMAIN=""                  # required when EMAIL_PROVIDER=mailgun
# MAILGUN_BASE_URL="https://api.mailgun.net"

# Machine API (§37). Both paths ship DARK (disabled) by default.
# API_KEYS_ENABLED="1"
# API_KEY_ENV_TAG="live"             # "live" | "test" (stamped into drk_<tag>_…)
# API_KEY_DEFAULT_TTL_DAYS=""
# API_JWT_ENABLED="1"                # requires API_JWT_PRIVATE_KEY at boot
# API_JWT_ISSUER=""                  # defaults to BETTER_AUTH_URL
# API_JWT_AUDIENCE="devresponse-api"
# API_JWT_PRIVATE_KEY=""             # Ed25519 private JWK (JSON string)
# API_JWT_KID=""                     # optional; defaults to JWK thumbprint
# API_JWT_ACCESS_TTL_SECONDS="900"   # <= 3600

# Test/CI only — disables Better Auth's rate limiter. Never in production.
# AUTH_RATE_LIMIT_DISABLED="1"

# Local seed user
SEED_ADMIN_EMAIL="admin@devresponse.local"
SEED_ADMIN_PASSWORD="ChangeMe-LocalOnly-123!"
SEED_DEFAULT_ORGANIZATION_SLUG="default"
```

`.env.example` is the authoritative list and `src/lib/env.ts` is the
validator. Boot fails if a selected provider/feature is missing its
companion secret — `EMAIL_PROVIDER=resend` needs `RESEND_API_KEY`,
`EMAIL_PROVIDER=mailgun` needs `MAILGUN_API_KEY` + `MAILGUN_DOMAIN`, and
`API_JWT_ENABLED` needs `API_JWT_PRIVATE_KEY`.

Production values:

```bash
NEXT_PUBLIC_APP_URL="https://app.devresponse.com"
BETTER_AUTH_URL="https://app.devresponse.com"
NEXT_PUBLIC_PRIMARY_HOST="app.devresponse.com"
```

Provider redirect URLs:

```text
Local Google:          http://localhost:3000/api/auth/callback/google
Production Google:     https://app.devresponse.com/api/auth/callback/google

Local Microsoft:       http://localhost:3000/api/auth/callback/microsoft
Production Microsoft:  https://app.devresponse.com/api/auth/callback/microsoft

Local GitHub:          http://localhost:3000/api/auth/callback/github
Production GitHub:     https://app.devresponse.com/api/auth/callback/github
```

Browser route examples:

```text
Local sign-in:               http://localhost:3000/en/sign-in
Production sign-in:          https://app.devresponse.com/en/sign-in
Local secure dashboard:      http://localhost:3000/en/app/dashboard
Production secure dashboard: https://app.devresponse.com/en/app/dashboard
```

---

## 9. Local PostgreSQL

Create `docker-compose.yml`.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: devresponse
      POSTGRES_PASSWORD: devresponse
      POSTGRES_DB: devresponse_db
    ports:
      - "5444:5432"
    volumes:
      - postgres17-data:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U devresponse -d devresponse_db"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres17-data:
```

---

## 10. Database architecture

### 10.1 Separation of concerns

Better Auth owns its core auth tables.

Application data lives in separate Kysely-managed tables:

```text
app_organizations
app_provider_organizations
app_users
app_organization_memberships
app_roles
app_permissions
app_role_permissions
app_user_roles
app_enterprise_applications
app_sso_handoff_nonces
app_audit_events
app_user_locale_preferences
app_email_templates           # §35 email — editable templates
app_outbox                    # §35 email — outbox-first delivery log
app_api_keys                  # §37 machine API — API keys (SHA-256 hash only)
app_oauth_clients             # §37 machine API — OAuth client-credentials principals
app_revoked_tokens            # §37 machine API — JWT (jti) revocation list
app_schema_migrations         # migration ledger written by run-migrations.ts
```

All of these tables (including the machine-API credential tables
`app_api_keys` / `app_oauth_clients` / `app_revoked_tokens`, see §37) are
created by the single `0001-initial-schema.sql`; `app_schema_migrations`
is created by the runner itself.

Roles, permissions, organization memberships, app access, and account status are application concerns. Do not store them inside Better Auth core tables.

### 10.2 Kysely database connection

Create `src/db/database.ts`.

```tsx
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { AppDatabase } from "./schema/app-schema";

/**
 * Shared PostgreSQL pool and Kysely instance.
 *
 * Application tables use Kysely directly. Better Auth must use a
 * Kysely-compatible adapter so auth storage and app storage share
 * the same database without introducing Prisma or Drizzle.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = new Kysely<AppDatabase>({
  dialect: new PostgresDialect({ pool }),
});

export const pgPool = pool;
```

### 10.3 Application core schema

The **entire** application schema is a single consolidated setup script,
`src/db/migrations/0001-initial-schema.sql` — one file, one setup
process. It provisions every `app_*` table, index, and baseline row for a
first-time setup, folding in the administrator indexes, audit
`request_id`, soft-delete columns, the permission catalog + superuser
provisioning, the email tables, **and** the machine-API credential tables
(`app_api_keys`, `app_oauth_clients`, `app_revoked_tokens`) and the four
`admin.apikeys.*` / `admin.clients.*` permissions (see §37). The core-table
DDL below is the heart of that file. There are no other application
migration files and no further application migrations are required.

The runner `src/db/migrations/run-migrations.ts` stays multi-file capable
(it applies every `NNNN-*.sql` in lexical order and records applied
filenames in `app_schema_migrations`, so each runs at most once), so a
future schema change can be appended as a new file if ever needed.

```sql
create extension if not exists "pgcrypto";

create table if not exists app_organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_provider_organizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id),
  provider text not null,
  provider_organization_key text not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique(provider, provider_organization_key)
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  better_auth_user_id text not null unique,
  primary_email text not null,
  display_name text,
  status text not null default 'pending_approval',
  status_reason text,
  preferred_locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app_organizations(id),
  app_user_id uuid not null references app_users(id),
  status text not null default 'pending_approval',
  source_provider text,
  provider_organization_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, app_user_id)
);

create table if not exists app_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references app_organizations(id),
  key text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique(organization_id, key)
);

create table if not exists app_permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text
);

create table if not exists app_role_permissions (
  role_id uuid not null references app_roles(id),
  permission_id uuid not null references app_permissions(id),
  primary key(role_id, permission_id)
);

create table if not exists app_user_roles (
  app_user_id uuid not null references app_users(id),
  organization_id uuid not null references app_organizations(id),
  role_id uuid not null references app_roles(id),
  created_at timestamptz not null default now(),
  primary key(app_user_id, organization_id, role_id)
);

create table if not exists app_enterprise_applications (
  id text primary key,
  organization_id uuid references app_organizations(id),
  label text not null,
  description text,
  origin text not null,
  subdomain text not null,
  sso_audience text not null,
  status text not null default 'available',
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists app_sso_handoff_nonces (
  jti text primary key,
  app_user_id uuid not null references app_users(id),
  target_application_id text not null references app_enterprise_applications(id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  outcome text not null,
  actor_better_auth_user_id text,
  app_user_id uuid references app_users(id),
  organization_id uuid references app_organizations(id),
  target_application_id text,
  provider text,
  email text,
  ip_address inet,
  user_agent text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists app_user_locale_preferences (
  app_user_id uuid primary key references app_users(id),
  locale text not null default 'en',
  time_zone text,
  date_format text,
  number_format_locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_app_audit_events_type_created_at
  on app_audit_events(event_type, created_at desc);

create index if not exists idx_app_users_status
  on app_users(status);

create index if not exists idx_app_memberships_status
  on app_organization_memberships(status);
```

### 10.4 Status values

```ts
export type AppUserStatus =
  | "active"
  | "pending_approval"
  | "blocked"
  | "suspended"
  | "deactivated";

export type MembershipStatus =
  | "active"
  | "pending_approval"
  | "blocked"
  | "suspended";
```

Rules:

1. `active` users can access secure routes only when they have at least one active organization membership.
2. `pending_approval` users can authenticate but cannot access secure routes.
3. `blocked`, `suspended`, and `deactivated` users cannot access secure routes.
4. Sensitive API routes return `403` for authenticated users who lack access.
5. Menu APIs return `401` for unauthenticated users and `403` for authenticated unauthorized users.

---

## 11. Better Auth configuration

### 11.1 Auth instance

Create `src/lib/auth.ts`.

```tsx
import { betterAuth } from "better-auth";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { db } from "@/db/database";

/**
 * Better Auth server instance.
 *
 * The adapter must remain Kysely-based so the project has one database
 * abstraction and does not introduce Prisma or Drizzle.
 */
export const auth = betterAuth({
  database: createKyselyAdapter(db, { type: "postgres" }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,

  trustedOrigins: [
    "http://localhost:3000",
    "https://app.devresponse.com",
  ],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
      tenantId: "organizations",
      authority: "https://login.microsoftonline.com",
      prompt: "select_account",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "microsoft", "github"],
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
    },
  },

  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 15,
  },
});
```

The implementation must verify exact Better Auth option names against installed package types. Preserve the required behavior even if the API shape changes.

### 11.2 Auth API route

Create `src/app/api/auth/[...all]/route.ts`.

```tsx
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * Better Auth catch-all route.
 *
 * Better Auth owns provider callbacks, email/password auth, sessions,
 * account linking, and verification flows under this route.
 */
export const { GET, POST } = toNextJsHandler(auth);
```

### 11.3 Auth client

Create `src/lib/auth-client.ts`.

```tsx
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client.
 *
 * Do not persist tokens in client stores. Better Auth manages session
 * cookies through its client/server route integration.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
});
```

### 11.4 Server session helper

Create `src/lib/auth-guard.ts`.

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserAccessContext } from "@/lib/auth-status";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Reads the Better Auth session from incoming request headers.
 */
export async function getCurrentSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

/**
 * Enforces secure app access for localized browser routes.
 *
 * proxy.ts only performs early cookie-based redirects. This function is
 * the real server-side access boundary for account status and app roles.
 */
export async function requireSecureSession(locale: string, returnTo?: string) {
  const session = await getCurrentSession();

  if (!session) {
    const params = new URLSearchParams();
    params.set("returnTo", getSafeReturnTo(returnTo, locale));
    redirect(`/${locale}/sign-in?${params.toString()}`);
  }

  const access = await getUserAccessContext(session.user.id);

  if (access.status === "pending_approval") {
    redirect(`/${locale}/pending-approval`);
  }

  if (["blocked", "suspended", "deactivated"].includes(access.status)) {
    redirect(`/${locale}/blocked?reason=${encodeURIComponent(access.status)}`);
  }

  return { session, access };
}
```

---

## 12. Provider organization assignment

Create `src/lib/provider-organization-resolver.ts`.

```tsx
export interface ProviderOrganizationInput {
  provider: "google" | "microsoft" | "github" | "email";
  email: string;
  emailVerified: boolean;
  profile?: Record<string, unknown>;
  account?: Record<string, unknown>;
}

export interface ProviderOrganizationResolution {
  provider: string;
  providerOrganizationKey: string;
  displayName: string;
  confidence: "high" | "medium" | "fallback";
}

/**
 * Resolves an application organization from provider metadata.
 *
 * Provider data is inconsistent across identity providers. This function
 * produces a deterministic organization key while keeping secure access
 * blocked until admin approval occurs.
 */
export function resolveProviderOrganization(
  input: ProviderOrganizationInput,
): ProviderOrganizationResolution {
  const emailDomain = input.email.split("@")[1]?.toLowerCase() ?? "unknown";

  if (input.provider === "microsoft") {
    const tenantId =
      readString(input.profile?.tid) ??
      readString(input.account?.tenantId) ??
      readString(input.account?.tid);

    if (tenantId) {
      return {
        provider: "microsoft",
        providerOrganizationKey: tenantId,
        displayName: `Microsoft Entra tenant ${tenantId}`,
        confidence: "high",
      };
    }
  }

  if (input.provider === "google") {
    const hostedDomain = readString(input.profile?.hd);

    if (hostedDomain) {
      return {
        provider: "google",
        providerOrganizationKey: hostedDomain.toLowerCase(),
        displayName: hostedDomain.toLowerCase(),
        confidence: "high",
      };
    }
  }

  if (input.provider === "github" && input.emailVerified) {
    return {
      provider: "github",
      providerOrganizationKey: emailDomain,
      displayName: emailDomain,
      confidence: "medium",
    };
  }

  return {
    provider: input.provider,
    providerOrganizationKey: "default",
    displayName: "Default Organization",
    confidence: "fallback",
  };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
```

Rules:

1. Google accounts are allowed. If Google returns `hd`, use it; otherwise fallback to `default`.
2. Microsoft uses tenant ID when available and supports multi-tenant work/school accounts.
3. GitHub does not query or enforce organization/team membership.
4. Email/password users start in `default`.
5. Account linking by email requires verified email.
6. Unverified or missing email creates pending approval state and grants no secure access.

---

## 13. User provisioning and approval

Create `src/lib/user-provisioning.server.ts`.

Responsibilities:

1. Create or update `app_users`.
2. Resolve organization.
3. Create organization membership.
4. Set user and membership status to `pending_approval` for non-seed users.
5. Preserve blocked/suspended/deactivated statuses.
6. Store preferred locale when available.
7. Audit provisioning and account-linking events.
8. Never grant secure access from client-side state.

Admin routes (status transitions live in the Administrator app; the
former `/api/admin/users/*` endpoints were removed because they
bypassed the hardened guard pipeline — see `docs/admin-manager.md` §5):

```text
POST /api/administrator/users/[user-id]/status   { action: approve | block | suspend | reactivate }
POST /api/administrator/users/bulk               { action, ids | "*" }
```

Admin route rules:

1. Require active session.
2. Require `admin.users.manage` permission via `requireAdminPermission`
   (origin guard, rate limit, request-id correlation included).
3. Return JSON only.
4. Audit success and failure.
5. Never expose raw Better Auth internals in response bodies.
6. Both routes share the `performAdminStatusChange` mutation core so
   single and bulk transitions emit identical audit events.

Pending and blocked browser pages:

```text
/[locale]/pending-approval
/[locale]/blocked
```

Requirements:

1. Use shadcn `Card`, `Button`, and `Alert`.
2. Translate all labels.
3. Do not render secure navigation.
4. Provide local sign-out button.
5. Do not reveal admin-only operational details.

---

## 14. Auth UI

### 14.1 Sign-in page

`src/app/[locale]/(auth)/sign-in/page.tsx` renders `SignInForm`.

`SignInForm` must include:

1. Email/password form.
2. Google, Microsoft, and GitHub social buttons shown at the same time.
3. Safe localized `returnTo`.
4. shadcn-only UI components.
5. Translated labels and error messages.
6. Link to localized sign-up page.
7. Comfortable density by default.

### 14.2 Social login buttons

Create `src/components/auth/social-login-buttons.tsx`.

```tsx
"use client";

import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export interface SocialLoginButtonsProps {
  returnTo: string;
}

/**
 * SocialLoginButtons
 *
 * Client component that starts OAuth sign-in with Better Auth.
 * The callbackURL must be a sanitized localized browser path.
 */
export function SocialLoginButtons({ returnTo }: SocialLoginButtonsProps) {
  async function signIn(provider: "google" | "microsoft" | "github") {
    // Better Auth owns the provider redirect and callback route.
    await authClient.signIn.social({
      provider,
      callbackURL: returnTo,
    });
  }

  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" onClick={() => signIn("google")}>
        Continue with Google
      </Button>
      <Button type="button" variant="outline" onClick={() => signIn("microsoft")}>
        Continue with Microsoft
      </Button>
      <Button type="button" variant="outline" onClick={() => signIn("github")}>
        <Github className="mr-2 size-4" aria-hidden="true" />
        Continue with GitHub
      </Button>
    </div>
  );
}
```

### 14.3 Email/password login

Create `src/components/auth/email-password-login-form.tsx`.

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export interface EmailPasswordLoginFormProps {
  returnTo: string;
}

/**
 * EmailPasswordLoginForm
 *
 * Client component for Better Auth email/password sign-in.
 * It does not store credentials outside component state.
 */
export function EmailPasswordLoginForm({ returnTo }: EmailPasswordLoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL: returnTo,
    });

    setPending(false);

    if (result.error) {
      setError(result.error.message ?? "Unable to sign in.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
```

### 14.4 Sign-up

Self-registration is mandatory.

Sign-up must:

1. Allow email/password registration.
2. Allow social registration through Google, Microsoft, and GitHub.
3. Provision app user and membership records.
4. Assign user to provider organization or `default`.
5. Require admin approval for all non-seed users.
6. Redirect to localized `/pending-approval` when approval is required.

---

## 15. Internationalization

### 15.1 Library and route model

Use `next-intl`.

Rules:

1. All browser routes include `[locale]`.
2. API routes do not include locale.
3. Unknown locale returns `notFound()`.
4. Shell, navigation, auth, status pages, errors, and logged-out page must be translated.
5. API menu routes accept `locale` query parameter.
6. Authenticated locale preference can be stored in `app_user_locale_preferences`.
7. Unauthenticated locale preference can use locale route segment and cookie.
8. Use `Intl` or `next-intl` for date, number, and currency formatting.
9. Do not build translated sentences by unsafe string concatenation.

### 15.2 Config

Create `src/config/i18n-config.ts`.

```tsx
export const locales = ["en", "fr", "es", "uk", "pt", "zh", "hi", "ja"] as const;
export const defaultLocale = "en" as const;

export type Locale = (typeof locales)[number];

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
```

Create `src/i18n/routing.ts`.

```tsx
import { defineRouting } from "next-intl/routing";
import { defaultLocale, locales } from "@/config/i18n-config";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "always",
});
```

Create `src/i18n/navigation.ts`.

```tsx
import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
```

Create `src/i18n/request.ts`.

```tsx
import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
```

### 15.3 Next config

Create `next.config.ts`.

```tsx
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig = {
  reactStrictMode: true,
};

export default withNextIntl(nextConfig);
```

### 15.4 Localized layout

Create `src/app/[locale]/layout.tsx`.

```tsx
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/config/i18n-config";

/**
 * LocaleLayout
 *
 * Validates the locale segment and provides translated messages
 * to all localized public, auth, and secure browser routes.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages}>
      <div data-locale={locale satisfies Locale}>{children}</div>
    </NextIntlClientProvider>
  );
}
```

### 15.5 Localized links

Use `Link` from `src/i18n/navigation.ts` for localized browser routes.

Use normal anchors for API routes and external URLs:

```tsx
<a href="/api/sso/launch?applicationId=enterprise-admin&locale=en">Admin</a>
```

### 15.6 Locale switcher

Create `src/components/i18n/locale-switcher.tsx`.

Requirements:

1. Use shadcn `Select` or `DropdownMenu`.
2. Preserve safe path and query.
3. Switch only the locale segment.
4. Never switch API routes.
5. Store authenticated user preference through `/api/preferences/locale`.
6. Use compact spacing when rendered inside secure shell.
7. Audit locale preference changes as `i18n.locale.changed`.

### 15.7 Minimum message keys

Each message file must include at least:

```json
{
  "app": {
    "name": "DevResponse Enterprise Platform"
  },
  "auth": {
    "signIn": "Sign in",
    "signUp": "Sign up",
    "email": "Email",
    "password": "Password",
    "continueWithGoogle": "Continue with Google",
    "continueWithMicrosoft": "Continue with Microsoft",
    "continueWithGitHub": "Continue with GitHub",
    "pendingApproval": "Pending approval",
    "blocked": "Account unavailable",
    "loggedOut": "You have signed out"
  },
  "shell": {
    "skipToMain": "Skip to main content",
    "apps": "Apps",
    "switchApplication": "Switch application",
    "loadingNavigation": "Loading navigation",
    "showLeft": "Show left panel",
    "hideLeft": "Hide left panel",
    "showRight": "Show right panel",
    "hideRight": "Hide right panel",
    "showFooter": "Show footer",
    "hideFooter": "Hide footer"
  },
  "navigation": {
    "dashboard": "Dashboard",
    "workspace": "Workspace",
    "admin": "Admin",
    "audit": "Audit"
  }
}
```

---

## 16. Compact shadcn UI density

### 16.1 Requirement

The secure enterprise shell defaults to compact mode. Public and auth pages default to comfortable mode.

Compact mode must increase information density without removing visible labels, keyboard access, focus rings, or readable typography.

### 16.2 Density state

```ts
export type UiDensity = "compact" | "comfortable";
```

Defaults:

```ts
secureAppDensity = "compact";
publicDensity = "comfortable";
authDensity = "comfortable";
```

Zustand may persist density preference. It must not persist tokens, roles as authority, permissions as authority, sessions, or SSO handoff data.

### 16.3 Compact CSS

Create `src/styles/compact-mode.css`.

```css
:root {
  --ui-density: comfortable;
  --ui-control-h: 2.5rem;
  --ui-control-h-sm: 2.25rem;
  --ui-control-h-xs: 2rem;
  --ui-field-px: 0.75rem;
  --ui-gap: 0.75rem;
  --ui-panel-p: 1rem;
  --ui-font-sm: 0.875rem;
  --ui-font-xs: 0.75rem;
  --ui-icon: 1rem;
}

[data-density="compact"] {
  --ui-density: compact;
  --ui-control-h: 2rem;
  --ui-control-h-sm: 1.875rem;
  --ui-control-h-xs: 1.75rem;
  --ui-field-px: 0.5rem;
  --ui-gap: 0.5rem;
  --ui-panel-p: 0.75rem;
  --ui-font-sm: 0.8125rem;
  --ui-font-xs: 0.72rem;
  --ui-icon: 0.875rem;
}

[data-density="compact"] .density-control {
  min-height: var(--ui-control-h);
  height: var(--ui-control-h);
  padding-left: var(--ui-field-px);
  padding-right: var(--ui-field-px);
  font-size: var(--ui-font-sm);
}

[data-density="compact"] .density-panel {
  padding: var(--ui-panel-p);
}

[data-density="compact"] .density-list-item {
  min-height: var(--ui-control-h);
  padding: 0.375rem 0.5rem;
  font-size: var(--ui-font-sm);
}
```

Import in `src/app/globals.css`:

```css
@import "tailwindcss";
@import "../styles/app-shell.css";
@import "../styles/compact-mode.css";
```

### 16.4 Usage

Secure layout:

```tsx
<div data-density="compact" className="h-full min-h-0">
  <ShellContainer>{children}</ShellContainer>
</div>
```

Public/auth layout:

```tsx
<div data-density="comfortable">{children}</div>
```

### 16.5 Compact UI rules

1. Use `size="sm"` on secure shell buttons when appropriate.
2. Use `density-control`, `density-panel`, and `density-list-item` to opt in.
3. Do not globally shrink shadcn components across public/auth routes.
4. List rows in secure navigation should be compact but keyboard focusable.
5. Primary touch targets should remain at least 36px in compact mode.
6. Form-heavy secure screens may locally use comfortable density.

---

## 17. App shell architecture

### 17.1 Shell components

The shell consists of:

```text
TopShellBar
ShellContainer
ShellGridContainer
ShellHeader
ShellLeft
ShellMain
ShellRight
ShellFooter
ApplicationShell
ShellSkipLinks
ShellDepthProvider
ShellVisibilityToggle
```

`ShellContainer` is the root shell. `ApplicationShell` is a nested shell inside `ShellMain`.

Do not render a second `TopShellBar` inside `ApplicationShell`.

### 17.2 Canonical shell variables

```css
:root {
  --sh-brand-h: 3rem;
  --sh-head-h: 3.5rem;
  --sh-foot-h: 3rem;
  --sh-left-w: 16rem;
  --sh-right-w: 20rem;
  --sh-mobile-side-h: 12rem;
  --sh-tablet-side-h: 16rem;
  --sh-gap: 0rem;
  --sh-z-brand: 50;
  --sh-z-head: 40;
}
```

Nested shell overrides:

```css
.sh-grid[data-variant="nested"] {
  --sh-head-h: 3rem;
  --sh-foot-h: 2.5rem;
  --sh-left-w: 14rem;
  --sh-right-w: 18rem;
}
```

### 17.3 Canonical shell classes

Use only these classes for shell structure:

```text
.sh-root
.sh-brand
.sh-grid
.sh-head
.sh-left
.sh-main
.sh-right
.sh-foot
.sh-scroll
.sh-fill
.sh-skip
```

### 17.4 Full-height and scroll contract

1. Secure shell uses bounded viewport layout.
2. Public pages may use normal document scrolling.
3. `html`, `body`, `.sh-root`, `.sh-grid`, `.sh-main`, `.sh-left`, `.sh-right`, and scroll wrappers must use `min-height: 0` where relevant.
4. `.sh-main` and `.sh-scroll` use `overflow: auto` and `scrollbar-gutter: stable`.
5. Long content must not resize grid rows or columns.
6. Footer is visible by default and hidden only by `footerVisible={false}` or `footerMode="hidden"`.
7. Sidebars are drawer-mode by default on secure mobile layouts.

### 17.5 Visibility contract

Visibility is controlled by the parent component.

```tsx
<ShellContainer
  branding={<TopShellBar />}
  header={<WebsiteNavbar />}
  left={<PrimarySidebar />}
  right={<InspectorPanel />}
  footer={<GlobalFooter />}
  leftVisible={visibility.leftVisible}
  rightVisible={visibility.rightVisible}
  footerVisible={visibility.footerVisible}
>
  {children}
</ShellContainer>
```

Rendering rules:

```tsx
const hasLeft = Boolean(left) && leftMode !== "hidden" && leftVisible;
const hasRight = Boolean(right) && rightMode !== "hidden" && rightVisible;
const hasFooter = Boolean(footer) && footerMode !== "hidden" && footerVisible;
```

Defaults:

```tsx
leftVisible = true;
rightVisible = true;
footerVisible = true;
```

Shell regions must not own local visibility state.

### 17.6 Type contracts

Create `src/components/app-shell/shell-types.ts`.

```tsx
import type { ReactNode } from "react";

export type ShellVariant = "root" | "nested";
export type ShellDensity = "comfortable" | "compact";
export type ShellSidebarMode = "static" | "drawer" | "hidden";
export type ShellFooterMode = "visible" | "hidden";
export type ShellLayout = "header-first" | "sidebar-first";
export type ShellRegion = "left" | "right" | "footer";
export type ShellVisibilityScope = "root" | "workspace";

export interface ShellSlotProps {
  children?: ReactNode;
  className?: string;
}

export interface ShellControlledVisibilityProps {
  leftVisible?: boolean;
  rightVisible?: boolean;
  footerVisible?: boolean;
}

export interface ShellGridContainerProps extends ShellControlledVisibilityProps {
  variant: ShellVariant;
  depth: number;
  layout?: ShellLayout;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  density?: ShellDensity;
  leftMode?: ShellSidebarMode;
  rightMode?: ShellSidebarMode;
  footerMode?: ShellFooterMode;
  ariaLabel?: string;
  mainId?: string;
}

export interface ShellContainerProps extends ShellControlledVisibilityProps {
  branding?: ReactNode;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  ariaLabel?: string;
  mainId?: string;
}

export interface ApplicationShellProps extends ShellControlledVisibilityProps {
  layout?: ShellLayout;
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  ariaLabel?: string;
  mainId?: string;
}
```

### 17.7 Layout arrangements

The grid supports two region arrangements, selected per shell instance
via the `layout` prop on `ApplicationShell` / `ShellGridContainer` and
emitted as a `data-layout` attribute on `.sh-grid`:

1. `header-first` (default — classic Holy Grail): the header spans the
   full width; left/right regions start below it.

   ```text
   header header header
   left   main   right
   footer footer footer
   ```

2. `sidebar-first`: the left region owns column 1 for ALL rows; the
   header sits adjacent to it, spanning only the content columns.

   ```text
   left header header
   left main   right
   left footer footer
   ```

Rules:

1. Columns and rows are identical between arrangements — only
   `grid-template-areas` changes. The fixed sidebar width tokens, the
   FlexSidebar icon-collapse rule, the visibility flags
   (`data-left-hidden` etc.), and the mobile collapse therefore apply
   unchanged to both.
2. The root shell stays `header-first` (its brand bar renders above
   the grid, outside it).
3. The Administrator workspace uses `sidebar-first`: its menubar
   header is adjacent to the full-height admin sidebar.

---

## 18. Zustand state

Create `src/stores/app-shell-store.ts`.

Rules:

1. Zustand stores shell UI preferences only.
2. Safe to persist: left/right/footer visibility, density, drawer state.
3. Never persist: access tokens, refresh tokens, SSO handoff JWTs, roles as authority, permission decisions, user secrets, auth sessions.
4. Shell still receives explicit props from parent components.

```tsx
"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  ShellRegion,
  ShellVisibilityScope,
} from "@/components/app-shell/shell-types";

type RegionVisibilityState = {
  leftVisible: boolean;
  rightVisible: boolean;
  footerVisible: boolean;
};

type AppShellState = {
  visibility: Record<ShellVisibilityScope, RegionVisibilityState>;
  density: "compact" | "comfortable";
  setRegionVisible: (
    scope: ShellVisibilityScope,
    region: ShellRegion,
    visible: boolean,
  ) => void;
  toggleRegion: (scope: ShellVisibilityScope, region: ShellRegion) => void;
  setDensity: (density: "compact" | "comfortable") => void;
  resetScope: (scope: ShellVisibilityScope) => void;
};

const defaultVisibility: Record<ShellVisibilityScope, RegionVisibilityState> = {
  root: { leftVisible: true, rightVisible: true, footerVisible: true },
  workspace: { leftVisible: true, rightVisible: true, footerVisible: true },
};

function regionToKey(region: ShellRegion): keyof RegionVisibilityState {
  if (region === "left") return "leftVisible";
  if (region === "right") return "rightVisible";
  return "footerVisible";
}

/**
 * Client-only shell preference store.
 *
 * This store persists layout preferences, not authorization data.
 * Server-side route guards and API handlers remain the authority.
 */
export const useAppShellStore = create<AppShellState>()(
  persist(
    (set) => ({
      visibility: defaultVisibility,
      density: "compact",

      setRegionVisible: (scope, region, visible) =>
        set((state) => {
          const key = regionToKey(region);
          return {
            visibility: {
              ...state.visibility,
              [scope]: {
                ...state.visibility[scope],
                [key]: visible,
              },
            },
          };
        }),

      toggleRegion: (scope, region) =>
        set((state) => {
          const key = regionToKey(region);
          return {
            visibility: {
              ...state.visibility,
              [scope]: {
                ...state.visibility[scope],
                [key]: !state.visibility[scope][key],
              },
            },
          };
        }),

      setDensity: (density) => set({ density }),

      resetScope: (scope) =>
        set((state) => ({
          visibility: {
            ...state.visibility,
            [scope]: defaultVisibility[scope],
          },
        })),
    }),
    {
      name: "enterprise-app-shell",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        visibility: state.visibility,
        density: state.density,
      }),
    },
  ),
);
```

---

## 19. Secure route protection

### 19.1 `proxy.ts`

Create `src/proxy.ts`.

Purpose:

1. Early redirect localized secure browser requests when no session cookie exists.
2. Preserve localized `returnTo`.
3. Avoid database calls.
4. Do not redirect API routes.
5. Combine locale routing concerns and secure browser-route redirect logic.

```tsx
import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { defaultLocale, isLocale } from "@/config/i18n-config";

function getLocaleFromPath(pathname: string) {
  const segment = pathname.split("/")[1];
  return isLocale(segment) ? segment : defaultLocale;
}

function isLocalizedSecurePath(pathname: string) {
  const [, locale, first] = pathname.split("/");
  return isLocale(locale) && first === "app";
}

/**
 * Next.js proxy for early browser redirects.
 *
 * This is not the final authorization boundary. It only checks for
 * a session cookie to avoid rendering secure pages to anonymous users.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isLocalizedSecurePath(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const locale = getLocaleFromPath(pathname);
    const url = new URL(`/${locale}/sign-in`, request.url);
    url.searchParams.set("returnTo", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
```

### 19.2 Secure layout

Create `src/app/[locale]/(secure)/layout.tsx`.

```tsx
import { requireSecureSession } from "@/lib/auth-guard";

/**
 * SecureLayout
 *
 * Server-side security boundary for localized secure routes.
 * Validates session, account status, and application access before
 * rendering the secure application shell.
 */
export default async function SecureLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireSecureSession(locale, `/${locale}/app/dashboard`);
  return children;
}
```

---

## 20. Safe returnTo handling

Create `src/lib/safe-return-to.ts`.

```tsx
import { defaultLocale, isLocale } from "@/config/i18n-config";

/**
 * Sanitizes returnTo values to prevent open redirects.
 *
 * Only localized same-origin browser paths are allowed.
 * API paths and auth/status pages are rejected.
 */
export function getSafeReturnTo(value: string | null | undefined, locale = defaultLocale) {
  const fallback = `/${locale}/app/dashboard`;

  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  if (value.startsWith("/api/")) return fallback;

  const [, maybeLocale, segment] = value.split("/");

  if (!isLocale(maybeLocale)) return fallback;
  if (["sign-in", "sign-up", "forgot-password", "blocked", "pending-approval"].includes(segment)) {
    return fallback;
  }

  return value;
}
```

---

## 21. Logout behavior

Local-only sign-out per subdomain is required.

Rules:

1. Sign-out calls Better Auth sign-out for current host only.
2. Do not revoke sessions on other subdomains.
3. Do not call remote logout endpoints.
4. After sign-out, redirect to localized `/logged-out`.
5. Logged-out page lives under `[locale]/(public)`.

Create `src/components/auth/sign-out-button.tsx`.

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export interface SignOutButtonProps {
  locale: string;
}

/**
 * SignOutButton
 *
 * Performs local-only sign-out for the current subdomain and then
 * redirects to the localized logged-out page.
 */
export function SignOutButton({ locale }: SignOutButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        await authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              window.location.href = `/${locale}/logged-out`;
            },
          },
        });
      }}
    >
      Sign out
    </Button>
  );
}
```

---

## 22. Cross-subdomain SSO JWT handoff

### 22.1 Launch requirements

`/api/sso/launch` generates a short-lived JWT handoff for target subdomains.

Rules:

1. Client link shape: `/api/sso/launch?applicationId=enterprise-admin&locale=en`.
2. Client never generates tokens.
3. Route validates Better Auth session.
4. Route validates account status and organization membership.
5. Route validates access to target app.
6. Route creates one-time `jti` nonce.
7. JWT max TTL is 60 seconds.
8. JWT audience equals target app audience.
9. Redirect response includes `Referrer-Policy: no-referrer`.
10. Failed attempts are audit-logged.
11. Target app consumes token immediately and redirects to clean localized URL without token.

### 22.2 Minimum JWT claims

```json
{
  "iss": "https://app.devresponse.com",
  "aud": "devresponse-app:analytics",
  "sub": "better-auth-user-id",
  "jti": "one-time-nonce-id",
  "email": "user@example.com",
  "organizationId": "organization-uuid",
  "appUserId": "app-user-uuid",
  "targetApplicationId": "analytics",
  "locale": "en",
  "roles": ["member"],
  "iat": 1710000000,
  "exp": 1710000060
}
```

### 22.3 SSO launch route

Create `src/app/api/sso/launch/route.ts`.

```tsx
import { NextRequest, NextResponse } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { createSsoHandoffRedirect } from "@/lib/sso.server";
import { getCurrentSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/sso/launch
 *
 * Starts cross-subdomain SSO by generating a one-time, short-lived JWT
 * handoff. This endpoint never returns the token in JSON and always audits
 * failed launches.
 */
export async function GET(request: NextRequest) {
  const applicationId = request.nextUrl.searchParams.get("applicationId");

  if (!applicationId) {
    await auditEvent({ eventType: "sso.launch", outcome: "failure", reason: "missing_application_id" });
    return NextResponse.json({ error: "Missing applicationId" }, { status: 400 });
  }

  const session = await getCurrentSession();

  if (!session) {
    await auditEvent({ eventType: "sso.launch", outcome: "failure", reason: "unauthenticated" });
    return NextResponse.redirect(new URL("/en/sign-in", request.url));
  }

  try {
    const redirectUrl = await createSsoHandoffRedirect({
      applicationId,
      betterAuthUserId: session.user.id,
      request,
    });

    await auditEvent({
      eventType: "sso.launch",
      outcome: "success",
      actorBetterAuthUserId: session.user.id,
      targetApplicationId: applicationId,
    });

    const response = NextResponse.redirect(redirectUrl);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    await auditEvent({
      eventType: "sso.launch",
      outcome: "failure",
      actorBetterAuthUserId: session.user.id,
      targetApplicationId: applicationId,
      reason: error instanceof Error ? error.message : "unknown_error",
    });

    return NextResponse.json({ error: "SSO launch failed" }, { status: 403 });
  }
}
```

### 22.4 SSO server helper

Create `src/lib/sso.server.ts`.

```tsx
import { SignJWT } from "jose";
import type { NextRequest } from "next/server";
import { db } from "@/db/database";

export interface CreateSsoHandoffRedirectInput {
  applicationId: string;
  betterAuthUserId: string;
  request: NextRequest;
}

/**
 * Creates a short-lived JWT handoff redirect.
 *
 * The JWT is one-time-use and should be consumed immediately by the target app.
 * Access to the target application must be validated before signing.
 */
export async function createSsoHandoffRedirect(input: CreateSsoHandoffRedirectInput) {
  const targetApp = await db
    .selectFrom("app_enterprise_applications")
    .selectAll()
    .where("id", "=", input.applicationId)
    .where("status", "=", "available")
    .executeTakeFirstOrThrow();

  const context = await loadSsoAccessContext(input.betterAuthUserId, input.applicationId);
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 60_000);

  await db
    .insertInto("app_sso_handoff_nonces")
    .values({
      jti,
      app_user_id: context.appUserId,
      target_application_id: input.applicationId,
      expires_at: expiresAt,
    })
    .execute();

  const secret = new TextEncoder().encode(process.env.SSO_HANDOFF_JWT_SECRET!);

  const token = await new SignJWT({
    email: context.email,
    organizationId: context.organizationId,
    appUserId: context.appUserId,
    targetApplicationId: input.applicationId,
    locale: context.locale,
    roles: context.roles,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(process.env.SSO_HANDOFF_ISSUER!)
    .setAudience(targetApp.sso_audience)
    .setSubject(input.betterAuthUserId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(secret);

  const redirectUrl = new URL("/api/sso/consume", targetApp.origin);
  redirectUrl.searchParams.set("token", token);

  return redirectUrl;
}

async function loadSsoAccessContext(_betterAuthUserId: string, _applicationId: string) {
  // Implement with Kysely joins across app_users, memberships, roles,
  // role permissions, and enterprise applications.
  throw new Error("Not implemented");
}
```

---

## 23. Navigation menu APIs

All menus must load through Next.js Route Handlers under `/api/navigation/*`.

UI navigation components must not import runtime menu arrays directly.

Required routes:

```text
GET /api/navigation/applications?locale=en
GET /api/navigation/nested-apps?applicationId=enterprise-core&locale=en
GET /api/navigation/shell-menu?scope=primary-sidebar&locale=en
```

Rules:

1. Return `401` for unauthenticated API calls.
2. Return `403` for authenticated but unauthorized/blocked users.
3. Never redirect.
4. Filter server-side by organization, role, app, account status, and locale.
5. Return skeleton-compatible response envelopes.
6. Never return tokens.

Response envelope:

```ts
export interface NavigationMenuResponse<TItem> {
  menuId: string;
  kind: string;
  locale: string;
  generatedAt: string;
  items: TItem[];
}
```

Enterprise application item:

```ts
export interface EnterpriseApplicationMenuItem {
  id: string;
  label: string;
  description?: string;
  environment: "production" | "staging" | "development";
  subdomain: string;
  origin: string;
  ssoLaunchUrl: string;
  status: "available" | "degraded" | "offline";
  active?: boolean;
}
```

`GET /api/navigation/applications` is MENU #1 for the top application switcher.

`GET /api/navigation/nested-apps` is MENU #2 for nested application/workspace selection.

---

## 24. Application switcher sheet

`TopShellBar` hosts `ApplicationSwitcherSheet` using shadcn `Sheet`.

Requirements:

1. Trigger button is visible in `TopShellBar`.
2. Sheet loads `/api/navigation/applications?locale={locale}`.
3. Loading state uses `AppSwitcherSkeleton`.
4. Failure state shows retry UI.
5. Each item uses `href={item.ssoLaunchUrl}`.
6. Launch URL points to `/api/sso/launch?applicationId=...&locale=...`.
7. Client never receives long-lived tokens.
8. Sheet is keyboard accessible.
9. Labels are translated.
10. Compact mode reduces spacing but preserves focus rings and labels.

---

## 25. Skeleton placeholders

Every API-loaded navigation or content region must render a skeleton placeholder.

Create `src/components/app-shell/navigation-menu-skeleton.tsx`.

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export interface NavigationMenuSkeletonProps {
  rows?: number;
  compact?: boolean;
}

/**
 * NavigationMenuSkeleton
 *
 * Stable loading placeholder for API-driven menus.
 * It approximates final row heights to avoid layout shift.
 */
export function NavigationMenuSkeleton({ rows = 5, compact = false }: NavigationMenuSkeletonProps) {
  return (
    <div className="space-y-2" aria-label="Loading navigation" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-md p-2 density-list-item">
          <Skeleton className="size-4 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            {!compact ? <Skeleton className="h-3 w-1/2" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AppSwitcherSkeleton() {
  return <NavigationMenuSkeleton rows={6} />;
}

export function SidebarMenuSkeleton() {
  return <NavigationMenuSkeleton rows={8} compact />;
}

export function NavbarMenuSkeleton() {
  return <NavigationMenuSkeleton rows={3} compact />;
}
```

Rules:

1. No blank menu panels.
2. No spinner-only loading states for primary regions.
3. Skeletons must be close to final dimensions.
4. Route-level `loading.tsx` must exist for content-heavy secure routes.

---

## 26. Audit logging

### 26.1 Required events

```text
auth.sign_in.email.success
auth.sign_in.email.failure
auth.sign_in.social.success
auth.sign_in.social.failure
auth.sign_up.email.success
auth.sign_up.email.failure
auth.account.linked
auth.account.pending_approval
auth.account.auto_activated
auth.account.invitation_accepted
auth.account.blocked_access
auth.sign_out.local
sso.launch.success
sso.launch.failure
sso.consume.success
sso.consume.failure
admin.user.approved
admin.user.blocked
admin.user.suspended
admin.user.reactivated
admin.organization.invitation_created
admin.organization.invitation_revoked
admin.organization.invitation_resent
navigation.menu.denied
i18n.locale.changed
```

### 26.2 Audit helper

Create `src/lib/audit.server.ts`.

```tsx
import type { NextRequest } from "next/server";
import { db } from "@/db/database";

export interface AuditEventInput {
  eventType: string;
  outcome: "success" | "failure" | "denied";
  actorBetterAuthUserId?: string;
  appUserId?: string;
  organizationId?: string;
  targetApplicationId?: string;
  provider?: string;
  email?: string;
  reason?: string;
  request?: NextRequest;
  metadata?: Record<string, unknown>;
}

/**
 * Writes a structured audit event.
 *
 * Audit logging is required for auth failures, SSO failures, status changes,
 * and denied navigation. Do not include secrets or tokens in metadata.
 */
export async function auditEvent(input: AuditEventInput) {
  await db
    .insertInto("app_audit_events")
    .values({
      event_type: input.eventType,
      outcome: input.outcome,
      actor_better_auth_user_id: input.actorBetterAuthUserId,
      app_user_id: input.appUserId,
      organization_id: input.organizationId,
      target_application_id: input.targetApplicationId,
      provider: input.provider,
      email: input.email,
      ip_address: input.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      user_agent: input.request?.headers.get("user-agent"),
      reason: input.reason,
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .execute();
}
```

---

## 27. Seeds

Create `src/db/seeds/seed-local.ts`.

Seed data:

1. Organization: `default`, name `Default Organization`, `is_default = true`.
2. Organization: `devresponse`, name `DevResponse`.
3. Roles: `owner`, `admin`, `member`, `viewer`.
4. Permissions: the baseline `shell.view` / `audit.view` keys plus the
   full **administrator permission catalog**, which is the single source
   of truth in `src/lib/admin/permissions.ts` (`ADMIN_PERMISSION_CATALOG`)
   and is currently **30 keys**: the `admin.users.*`, `admin.roles.*`,
   `admin.permissions.manage`, `admin.orgs.*`, `admin.apps.*`,
   `admin.audit.read`, `admin.email.read` / `admin.email.manage`, and the
   machine-credential keys `admin.apikeys.read` / `admin.apikeys.manage`
   / `admin.clients.read` / `admin.clients.manage`. All 30 are seeded by
   the single `0001-initial-schema.sql`. Do not hard-code a count
   elsewhere — derive it from `ADMIN_PERMISSION_CATALOG`.
5. Enterprise applications:
   - `enterprise-core`, origin `https://app.devresponse.com`, audience `devresponse-app:enterprise-core`
   - `enterprise-admin`, origin `https://admin.devresponse.com`, audience `devresponse-app:enterprise-admin`
   - `enterprise-analytics`, origin `https://analytics.devresponse.com`, audience `devresponse-app:enterprise-analytics`
6. Local dev equivalents can use `http://localhost:3000` path-based simulation.
7. Seed admin user from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.
8. Seed translation files for English, French, Spanish, Ukrainian, Portuguese, Simplified Chinese, Hindi, and Japanese.

Seed admin may be auto-approved. All other self-registered users start pending approval.

---

## 28. Route-region plan

### 28.1 Root layout

`src/app/[locale]/layout.tsx` is the root layout for every localized
route and must remain minimal. The bare `/` index (a redirect to the
default locale) has its own minimal root layout in `src/app/(root)/`.

Rules:

1. Sets HTML shell and fonts, including `<html lang>` from the locale
   segment (WCAG 3.1.1). The locale comes from `params` — never from a
   dynamic request API, which would force static public pages into
   dynamic rendering.
2. Does not load secure menus.
3. Does not fetch user-specific data.
4. Wraps the app with common providers only (theme + locale messages).

### 28.2 Localized public routes

```text
/en
/en/about
/en/docs
/en/logged-out
```

Rules:

1. May render lightweight public shell.
2. Must not call secure menu APIs.
3. Must not hydrate secure shell state.
4. Comfortable density.
5. Normal document scrolling allowed.

### 28.3 Localized auth routes

```text
/en/sign-in
/en/sign-up
/en/forgot-password
/en/reset-password
/en/pending-approval
/en/blocked
```

Rules:

1. No secure shell navigation.
2. shadcn-only UI.
3. Social buttons for all three providers.
4. Safe localized `returnTo`.
5. Translated labels.
6. Comfortable density.
7. `forgot-password` requests a reset email (rendered + recorded through
   the outbox); `reset-password` completes the flow with the emailed
   one-time token (§35).

### 28.4 Localized secure routes

```text
/en/app/dashboard
/en/app/account                 (self-service; user-level, self-scoped — §36)
/en/app/account/profile
/en/app/account/preferences
/en/app/account/security
/en/app/workspace
/en/app/administrator
/en/app/administrator/users
/en/app/administrator/audit
/en/app/administrator/email     (outbox + templates — §35)
/en/app/administrator/email/templates
```

The list above is **representative**, not exhaustive: the Administrator
workspace also includes `organizations`, `memberships`, `roles`,
`permissions`, and `enterprise-apps` sections (each with `new` / `[id]`
variants).

(The former `/en/app/admin/users` and `/en/app/admin/audit` placeholder
pages were removed — they lacked admin permission checks. The
Administrator workspace at `/app/administrator/*` is the only admin
surface; its layout re-validates `admin.*` permissions and renders 404
for non-admins. The Account app is user-level — it gates only on an
active secure session and never requires any `admin.*` permission.)

Rules:

1. Protected by `proxy.ts`.
2. Protected again by `[locale]/(secure)/layout.tsx`.
3. Secure shell loads only after access validation.
4. Compact density.
5. Bounded viewport layout.
6. API routes validate independently.

### 28.5 Machine API region (`/api/v1`)

The versioned machine API (§37) is a **distinct route region**, separate
from the browser-facing public / auth / secure regions:

- **Not localized** — no `[locale]` prefix (`/api/v1/...`).
- **Not session-cookie gated and NOT touched by `proxy.ts`.** It is
  authenticated by bearer machine credentials — an API key
  (`Authorization: Bearer drk_…`) or an Ed25519 JWT access token —
  resolved by `src/lib/api-auth/resolve-caller.server.ts` and gated per
  route by `src/lib/api-auth/v1-guard.server.ts`.
- Disabled by default (`API_KEYS_ENABLED` / `API_JWT_ENABLED`).
- Speaks `application/problem+json` (RFC 9457-style) for errors.

---

## 29. Testing and coverage requirements

Testing is a first-class deliverable. A feature is incomplete until its tests are implemented, deterministic, and passing.

### 29.1 Test suite categories

| Suite | Folder | Purpose | Tools |
|---|---|---|---|
| Static checks | root scripts | TypeScript, ESLint, formatting, import boundaries | `tsc`, `eslint`, Prettier |
| Unit | `tests/unit` | Pure helpers, guards, resolvers, schema validation, i18n utilities | Vitest |
| Component | `tests/component` | React components, forms, skeletons, shadcn composition, visibility toggles | Vitest + Testing Library |
| Route integration | `tests/integration` | Route Handlers, Better Auth flows, menu APIs, SSO, database flows | Vitest + test DB |
| Security | `tests/security` | Open redirects, token leakage, verified-email linking, authorization failures | Vitest |
| E2E | `tests/e2e` | Browser auth, secure shell, app switcher, responsive behavior, admin flows, account self-service round trips, email outbox + password-reset round trip | Playwright |
| Accessibility | `tests/accessibility` | Keyboard, landmarks, sheet focus, axe checks across public, auth, administrator, and account pages | Playwright + axe |

**CI** (`.github/workflows/ci.yml`) runs two jobs against a Postgres
service: a **quality** job (typecheck, lint, format check, vitest with
the coverage ratchet) and a **browser** job that builds, migrates
(the single application schema via `db:app:migrate`), seeds, runs
`next start`, then executes the `test:e2e` and `test:a11y` suites against
the production server. The
browser job sets `AUTH_RATE_LIMIT_DISABLED=1` (a validated, test-only
env escape hatch) because the suites sign in faster than Better Auth's
production rate limit allows.

### 29.2 Coverage gates

The long-term coverage **target** is 90% lines/statements/functions and
82% branches. The CI gate is implemented as a **ratchet**: thresholds are
pinned just below the current measured coverage and only ever move up, so
new code cannot regress the suite while the codebase grows toward the
target. The enforced values live in `vitest.config.ts` (currently 38 /
38 / 34 / 36 for lines / statements / functions / branches) — raise them
whenever coverage climbs, never lower them.

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "html", "lcov"],
  // Ratchet — pinned just below current coverage; target is 90/90/90/82.
  thresholds: {
    lines: 38,
    statements: 38,
    functions: 34,
    branches: 36,
  },
}
```

Additional gates:

1. Auth, account status, SSO, safe returnTo, provider organization assignment, and menu authorization helpers target 95% line coverage.
2. No file in `src/lib`, `src/db`, `src/i18n`, `src/stores`, `src/components/auth`, or `src/components/app-shell` may have zero direct tests unless it is a pure barrel export.
3. Generated shadcn/ui files do not need direct coverage.
4. Coverage exclusions must be explicit and justified in comments.
5. No blanket directory exclusions.

### 29.3 Test data and isolation

1. Use deterministic factories in `tests/helpers/test-data-factories.ts`.
2. Integration tests use a dedicated test database or isolated schema.
3. Each integration test cleans up data or runs inside rollback-capable transaction.
4. Test seeds are separate from local developer seeds unless intentionally shared.
5. Tests must not depend on execution order.
6. Do not call real Google, Microsoft, GitHub, or email services.
7. Use provider callback mocks and signed local fixtures.
8. SSO JWT tests verify signature, issuer, audience, expiration, one-time `jti`, and no long-lived token leakage.

### 29.4 Unit test requirements

Create tests for:

1. `safe-return-to.ts`.
2. `provider-organization-resolver.ts`.
3. `locale.ts` and i18n helpers.
4. `shell-helpers.ts`.
5. `jwt-handoff.server.ts` pure helpers.
6. `auth-status.ts` pure status mapping helpers.
7. `navigation.server.ts` menu filtering helpers.
8. `compact-density` helpers.

### 29.5 Component test requirements

Create tests for:

1. `ShellContainer`.
2. `ApplicationShell`.
3. `ShellGridContainer`.
4. `ShellVisibilityToggle`.
5. `ApplicationSwitcherSheet`.
6. `NavigationMenuSkeleton`.
7. `SignInForm`.
8. `SignUpForm`.
9. `EmailPasswordLoginForm`.
10. `SocialLoginButtons`.
11. `LocaleSwitcher`.
12. `CompactModeToggle`.

Component tests must verify:

1. Rendering.
2. Accessible names.
3. Loading state.
4. Error/retry state.
5. Visibility toggle behavior.
6. Compact mode class behavior.
7. Locale label rendering.

### 29.6 Route integration test requirements

Create tests for:

1. Email/password sign-up.
2. Email/password sign-in failure audit.
3. Social callback provisioning.
4. Account linking by verified email.
5. Microsoft tenant organization resolution.
6. GitHub login without organization restriction.
7. Pending approval secure access block.
8. Blocked/suspended/deactivated users.
9. Navigation menu APIs.
10. SSO launch.
11. Admin approval/block/suspend/reactivate APIs.
12. Locale preference API.
13. Audit event writing.

### 29.7 Security test requirements

Create tests for:

1. Open redirect prevention.
2. Protocol-relative URL rejection.
3. API route returnTo rejection.
4. Auth/status page returnTo rejection.
5. SSO JWT one-time-use `jti`.
6. SSO JWT 60-second expiration.
7. No tokens in menu API responses.
8. No tokens in Zustand persisted state.
9. Account linking only by verified email.
10. Unauthorized menu filtering.
11. Locale switching does not bypass secure route protection.

### 29.8 E2E test requirements

Create Playwright tests for:

1. Anonymous visit to `/en/app/dashboard` redirects to `/en/sign-in?returnTo=...`.
2. Sign-in page renders email/password and all three social buttons.
3. Pending user cannot access secure shell.
4. Active user can access secure shell.
5. App switcher opens from `TopShellBar`.
6. App switcher shows skeleton before data resolves.
7. Desktop layout shows left/main/right columns.
8. Mobile layout uses drawer behavior for sidebars.
9. Locale switcher changes `/en/...` to `/fr/...`.
10. Logout redirects to `/en/logged-out`.

### 29.9 Accessibility test requirements

Run axe-powered Playwright tests for:

1. Sign-in page.
2. Sign-up page.
3. Pending approval page.
4. Blocked page.
5. Secure shell.
6. Nested workspace shell.
7. Application switcher sheet.
8. Mobile drawer navigation.
9. Locale switcher.
10. Compact mode navigation.

Requirements:

1. No critical or serious axe violations.
2. Keyboard can open/close sheet.
3. Escape closes sheet.
4. Skip link works.
5. Landmarks are correct.
6. Focus rings are visible.
7. Translated labels still produce accessible names.

---

## 30. Work packages

Claude must execute in independent, verifiable work packages. Do not proceed if a package gate fails.

### Work package 0 — Repository foundation

Deliverables:

1. Create Next.js 16 App Router project.
2. Configure strict TypeScript.
3. Configure Tailwind CSS 4.
4. Configure shadcn/ui.
5. Configure `@/*` path alias.
6. Add ESLint and Prettier.
7. Add `.env.example`.
8. Add Docker Compose.

Gate:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

### Work package 1 — Database foundation

Deliverables:

1. PostgreSQL Docker Compose.
2. Kysely connection.
3. App migrations.
4. Better Auth migration/generation script.
5. Local seeds.
6. Kysely generated types.

Gate:

```bash
pnpm db:up
pnpm db:auth:generate
pnpm db:auth:migrate
pnpm db:app:migrate
pnpm db:seed
pnpm db:codegen
```

### Work package 2 — Better Auth core

Deliverables:

1. Better Auth instance.
2. Kysely adapter integration.
3. `/api/auth/[...all]`.
4. Auth client.
5. Email/password auth.
6. Google, Microsoft, GitHub providers.
7. Account linking by verified email.
8. Session duration/update configuration.

Gate:

```bash
pnpm typecheck
pnpm test:integration -- auth.email-password
```

### Work package 3 — Provisioning, roles, and account status

Deliverables:

1. Provider organization resolver.
2. User provisioning service.
3. Access status service.
4. Admin status APIs.
5. Pending/blocked pages.
6. Audit logging.

Gate:

```bash
pnpm test:integration -- account-status
pnpm test:security -- account-linking-verified-email
```

### Work package 4 — i18n foundation

Deliverables:

1. `next-intl` setup.
2. `[locale]` route segment.
3. Message files.
4. Locale switcher.
5. Locale-aware links.
6. Locale-aware auth pages.
7. Locale-safe `returnTo`.

Gate:

```bash
pnpm test:integration -- i18n-routing
pnpm test:unit -- locale
```

### Work package 5 — Shell foundation

Deliverables:

1. Shell components.
2. Short `sh-` classes.
3. CSS variables.
4. Full-height bounded scrolling.
5. Parent-controlled left/right/footer visibility.
6. Zustand shell preferences.
7. Compact density wrapper.

Gate:

```bash
pnpm typecheck
pnpm test:component -- shell
pnpm build
```

### Work package 6 — API-driven navigation and skeletons

Deliverables:

1. `/api/navigation/applications`.
2. `/api/navigation/nested-apps`.
3. `/api/navigation/shell-menu`.
4. Skeleton components.
5. Client navigation API helper.
6. No runtime menu imports in UI components.

Gate:

```bash
pnpm test:integration -- navigation-api
pnpm test:component -- navigation-skeletons
```

### Work package 7 — SSO application switcher

Deliverables:

1. `ApplicationSwitcherSheet`.
2. SSO launch route.
3. JWT handoff helper.
4. One-time nonce usage.
5. Audit success/failure.
6. Clean target redirect behavior.

Gate:

```bash
pnpm test:integration -- sso-launch
pnpm test:security -- sso-jwt-handoff
```

### Work package 8 — Secure route assembly

Deliverables:

1. `proxy.ts`.
2. `[locale]/(secure)/layout.tsx`.
3. Secure app layout.
4. Nested workspace layout.
5. Public/auth route isolation.
6. Compact secure mode.

Gate:

```bash
pnpm test:integration -- auth.protected-routes
pnpm test:e2e -- secure-shell
pnpm build
```

### Work package 9 — Test coverage and source documentation hardening

Deliverables:

1. Unit tests.
2. Component tests.
3. Route integration tests.
4. Security tests.
5. E2E tests.
6. Accessibility tests.
7. JSDoc and inline comments in all required source files.
8. Coverage reports.

Gate:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm test:e2e
pnpm test:a11y
```

### Work package 10 — Final hardening

Deliverables:

1. Fix type errors.
2. Fix lint errors.
3. Fix formatting errors.
4. Verify all test suites.
5. Verify production build.
6. Verify no hydration warnings.
7. Verify no secure menu leakage.
8. Verify no layout regressions.
9. Verify comments are current.

Gate:

```bash
pnpm test:all
pnpm build
```

---

## 31. Definition of done

The implementation is complete only when all items are true:

1. Repo is created from scratch.
2. All source file names are lower-case hyphen-separated.
3. React component names are PascalCase.
4. TypeScript strict mode passes.
5. ESLint passes.
6. Prettier check passes.
7. Production build succeeds.
8. Tailwind CSS 4 compiles.
9. shadcn/ui components are installed and used as the UI primitive source.
10. App shell uses CSS Grid.
11. Shell uses canonical `sh-` classes.
12. Shell uses explicit CSS variables.
13. Shell regions stretch to assigned grid area.
14. Long content scrolls internally.
15. Scrollbar appearance does not shift layout.
16. `ShellLeft` visibility is parent-controlled and defaults visible.
17. `ShellRight` visibility is parent-controlled and defaults visible.
18. `ShellFooter` visibility is parent-controlled and defaults visible.
19. Root and nested shell share same layout core.
20. Nested shell does not render another `TopShellBar`.
21. Root and nested `mainId` values are unique.
22. Secure app defaults to compact density.
23. Public/auth routes use comfortable density.
24. Mobile secure navigation uses drawer access for sidebars.
25. Better Auth is configured.
26. Better Auth uses Kysely-compatible storage.
27. PostgreSQL works through Docker Compose.
28. Kysely application migrations run.
29. Local seeds run.
30. Email/password sign-up and sign-in work.
31. Google social login is configured.
32. Microsoft multi-tenant work/school login is configured.
33. GitHub login is configured without org/team restriction.
34. Accounts link only by verified email.
35. New non-seed users require admin approval.
36. Pending users cannot access secure routes.
37. Blocked/suspended/deactivated users cannot access secure routes.
38. Roles live in app tables.
39. API menu routes return `401` unauthenticated and do not redirect.
40. API menu routes return `403` authenticated unauthorized.
41. All navigation menus load through API routes.
42. API-loaded menus render skeletons.
43. Application switcher uses shadcn `Sheet`.
44. Application switcher uses MENU #1.
45. Nested app menus use MENU #2.
46. SSO launch creates short-lived one-time JWT handoff.
47. SSO launch audits failures.
48. Failed login attempts are audited.
49. Local-only sign-out redirects to localized logged-out page.
50. Locale routing works for `en`, `fr`, `es`, `uk`, `pt`, `zh`, `hi`, and `ja`.
51. Unknown locale returns not found.
52. Locale switcher preserves safe path and query.
53. Translated auth/shell/navigation labels exist.
54. Safe `returnTo` rejects unsafe URLs.
55. No tokens or secrets are persisted in Zustand.
56. No tokens are returned from menu APIs.
57. Unit tests pass.
58. Component tests pass.
59. Integration tests pass.
60. Security tests pass.
61. E2E tests pass.
62. Accessibility tests pass.
63. Coverage thresholds pass.
64. Required source-code comments and JSDoc are present.
65. No critical or serious accessibility violations.
66. No secure menu appears on public/auth routes.
67. No hydration warnings in the main flows.
68. `pnpm test:all` passes.

---

## 32. Common mistakes to avoid

1. Do not use Prisma.
2. Do not use Drizzle.
3. Do not pass a raw `pgPool` to Better Auth if the installed Better Auth version provides a Kysely adapter.
4. Do not put app roles inside Better Auth core tables.
5. Do not implement MFA.
6. Do not restrict Google to a Workspace domain.
7. Do not restrict Microsoft to one tenant.
8. Do not require GitHub org/team membership.
9. Do not link accounts by unverified email.
10. Do not allow pending users into secure routes.
11. Do not store tokens, sessions, SSO JWTs, roles-as-authority, or permission decisions in Zustand.
12. Do not redirect from API menu routes.
13. Do not make sign-out global across subdomains.
14. Do not create PascalCase source file names.
15. Do not directly import runtime menus into UI components.
16. Do not show blank loading states for API-loaded menus.
17. Do not allow long shell content to resize grid rows or columns.
18. Do not make the entire shell a Client Component just for toggles.
19. Do not use `position: fixed` for shell layout.
20. Do not render a second `TopShellBar` inside `ApplicationShell`.
21. Do not bypass localized routing for browser navigation.
22. Do not place long-lived tokens in URLs.
23. Do not skip accessibility tests for sheets, drawers, compact mode, or auth forms.
24. Do not create components without JSDoc.
25. Do not write comments that merely restate the code.
26. Do not use hard-coded English strings in translated UI.
27. Do not use spinner-only loaders for primary app regions.
28. Do not use body scrolling for secure app content.
29. Do not create duplicate `main-content` IDs.
30. Do not skip test coverage gates.

---

## 33. Future enhancements outside this version

These are not part of V9 but the architecture should not block them:

1. MFA and passkeys.
2. Global sign-out across subdomains.
3. Collapsible/resizable desktop rails.
4. Server-synced shell preferences.
5. Full design token package extraction.
6. Remote menu authoring.
7. Runtime layout registry.
8. Micro-frontend shell slots.
9. Tenant theme editor.
10. Command palette.
11. Advanced audit search UI.
12. Role management UI.
13. OIDC provider mode for external apps.
14. SAML handoff variant.
15. Full notification center.

---

## 34. Theme architecture and design tokens

The framework ships one themed token pipeline, structured exactly as
documented at https://ui.shadcn.com/docs/theming (see
`src/app/globals.css`):

1. Raw palette values live on `:root` (light) and `.dark` as plain CSS
   custom properties. The palette is the **shadcn/ui default theme
   (neutral base), verbatim** — re-theming means swapping the whole
   block (the format shadcn theme generators emit), never hand-tuning
   individual entries. `color-scheme` follows the theme.
2. `@theme inline` maps the palette into Tailwind utility tokens
   (`bg-background`, `border-border`, `bg-accent`, ...) as `var()`
   references, so toggling the `dark` class on `<html>` swaps every
   color. The documented `--radius` token and `radius-sm/md/lg/xl`
   scale are mapped the same way.
3. `next-themes` is mounted in the root layout
   (`attribute="class"`, system default, via
   `src/components/theme/theme-provider.tsx`); `ThemeToggle` in the
   secure top bar switches light/dark.
4. Custom tokens follow the documented extension pattern:
   `success`/`success-foreground`, `warning`/`warning-foreground`,
   `destructive-foreground` (used by button/badge variants; not part of
   the v4 default list), and `destructive-emphasis` — destructive TEXT
   on tinted/light surfaces, darker than `destructive` in light mode
   because the default red is below WCAG AA 4.5:1 at body sizes.
5. The legacy `shell-*` tokens are ALIASES of the semantic tokens
   (`shell-bg`=`background`, `shell-border`=`border`,
   `shell-muted`=`muted`, `shell-accent`=`primary`) consumed only by
   `app-shell.css` — one palette, two vocabularies. New code uses the
   semantic names.
6. Layout tokens are global: `--sidebar-width` (16rem),
   `--sidebar-width-icon` (3rem), `--sidebar-width-mobile` (18rem) are
   the single source for every sidebar and the shell grid columns.

Component rules:

1. Components MUST use semantic tokens — never raw palette classes
   (`text-red-600`, `bg-neutral-100`, ...). Errors use
   `text-destructive`, secondary text `text-muted-foreground`, success
   notes `text-success`, warning banners the `warning` pair.
2. A base-layer rule pins `border-color` to `var(--color-border)`, so
   bare `border-*` utilities are themed (Tailwind v4 preflight would
   otherwise leave them `currentColor`).
3. Enabled `button` / `[role="button"]` elements get `cursor: pointer`
   via a base-layer rule; menu primitives use `cursor-pointer` so
   button-based controls match link affordances.
4. Hover treatment is the `accent` pair everywhere interactive lists
   and menus are concerned (sidebar items, menubar triggers and items);
   neutral surfaces hover with `bg-muted`. Modal overlays intentionally
   keep `bg-black/80` in both themes.

---

## 35. Email subsystem

Outbound email is **outbox-first**: every email is rendered and recorded
in `app_outbox` BEFORE any delivery attempt, so the outbox is a complete,
inspectable record regardless of whether a third-party delivery provider
is configured. Delivery is delegated to a pluggable provider
(Resend / Mailgun) selected by environment configuration.

### 35.1 Data model

The consolidated initial schema `0001-initial-schema.sql` includes:

- `app_email_templates (key, locale, subject, body_html, body_text,
  description)` — editable templates, unique on `(key, locale)`. Seeded
  with the built-in defaults. The runtime falls back to the code-level
  defaults in `src/lib/email/templates.ts` when a row is missing, so
  deleting or breaking a row can never block a flow.
- `app_outbox (template_key, to_email, from_email, subject, body_html,
  body_text, variables, status, provider, provider_message_id, error,
  related_better_auth_user_id, created_at, sent_at)` — one row per
  outbound email. `status` lifecycle:
  - `pending` → `sent` | `failed` when a provider is configured;
  - `logged` when no provider is configured (recorded only — the right
    mode for local dev and CI).
- The `admin.email.read` / `admin.email.manage` permissions, granted to
  `superuser` alongside the rest of the catalog.

### 35.2 Modules

- `src/lib/email/templates.ts` — template catalog + `renderEmailTemplate`.
  Free of `server-only` so the seed and unit tests import it under plain
  Node. `{{variable}}` placeholders; in HTML mode every variable VALUE is
  entity-escaped so user-controlled values (names, emails) cannot inject
  markup. Unknown placeholders are left verbatim.
- `src/lib/email/providers.server.ts` — thin `fetch` wrappers around the
  vendor REST APIs (no SDK dependencies). `getConfiguredEmailProvider()`
  returns `null` when delivery is not configured.
- `src/lib/email/send.server.ts` — `sendAppEmail()`, the outbox-first
  sender. Resolves the recipient locale (input → app user → default),
  prefers the editable DB template over the code default, renders,
  inserts the outbox row, then attempts delivery. **Delivery failures
  are recorded, never thrown** — a password-reset request must not 500
  because a third-party API hiccuped; operators watch the outbox.

### 35.3 Flows

- Password reset is wired through Better Auth's `sendResetPassword`
  callback in `src/lib/auth.ts`, which calls `sendAppEmail` with the
  `password_reset` template. Public pages: `/[locale]/forgot-password`
  (request) and `/[locale]/reset-password` (complete, token in the
  emailed link). The administrator "send reset email" action
  (`/api/administrator/users/[id]/password`, mode `reset_email`) uses the
  same Better Auth flow.
- The administrator "send test email" action
  (`/api/administrator/email/test`) sends the `test_email` template
  through the full pipeline — the canonical way to verify provider
  configuration.

### 35.4 Administrator Email workspace

Under `/[locale]/app/administrator/email`:

- Outbox explorer (`admin.email.read`) — paginated grid over `app_outbox`
  with status/template filters and a per-row detail sheet. Bodies are
  rendered as TEXT, never `dangerouslySetInnerHTML`. A "send test email"
  toolbar action requires `admin.email.manage`.
- Templates list + standard edit page (`admin.email.manage`). `key` and
  `locale` are immutable — flows send against the key.

### 35.5 Configuration

| Variable | Purpose |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` \| `mailgun` \| unset (no delivery → `logged`) |
| `EMAIL_FROM` | From header, e.g. `App <no-reply@example.com>` |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend` |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` | Required when `EMAIL_PROVIDER=mailgun` |
| `MAILGUN_BASE_URL` | Override for the EU region (`https://api.eu.mailgun.net`) |

`env.ts` `superRefine` fails at boot if a provider is selected without
its credentials. With no provider set, every flow still works — emails
are rendered and recorded as `logged`. Adding a provider = implement
`EmailProvider`, wire the env, extend the `EMAIL_PROVIDER` enum. See
[docs/setup-email.md](docs/setup-email.md) for the full integration guide.

---

## 36. Account (self-service) app

A user-level workspace at `/[locale]/app/account` where a signed-in user
views and edits **their own** personal information. It is the
counterpart to the Administrator app: same nested-shell structure, but
**user-level** — it gates only on an active secure session (`shell.view`,
implied by an active membership) and never requires any `admin.*`
permission.

### 36.1 Security — strict self-scoping

The defining property is that the app can only ever read or write the
**caller's own** record:

1. Every query and mutation is scoped to the identity resolved from the
   session — `session.user.id` (Better Auth) and `access.appUserId`. No
   route accepts a user id, app-user id, or membership id from the
   client; there is no `[id]` segment and the request bodies use strict
   Zod schemas that reject unknown keys (so a smuggled `appUserId` is a
   400, not a target). This closes IDOR by construction.
2. The shared gate `requireAccountUser` (`src/lib/account/guard.server.ts`)
   enforces an active member, applies the trusted-origin CSRF check on
   unsafe methods, and returns the caller's own ids only.
3. Admin-controlled data — account `status`, roles, organization
   memberships, member-since — is **display-only**. Editable: app-side
   `display_name`, Better Auth `name`, locale + time-zone/date/number
   formatting, password, and the user's own active sessions.

### 36.2 Structure & extensibility

- A section **registry** (`account/_sections.ts`) is the single source
  for navigation; the sidebar and landing page render from it. Adding a
  future area (notifications, connected accounts, API tokens, data
  export, deactivate) is one descriptor + one route folder.
- Sections (v1): Overview (read-only summary), Profile, Preferences,
  Security (password via Better Auth's client + own-session
  list/revoke). Data access lives in `account/_data.server.ts`; the
  pages/components own display.
- API: `PATCH /api/account/profile`, `PUT /api/account/preferences` —
  self-scoped, audited (`account.profile.updated`,
  `account.preferences.updated`). Password and session management go
  through Better Auth's client (inherently self-scoped). The Account
  entry is registered in `DEFAULT_SHELL_MENU` (`requiredPermissions:
  ["shell.view"]`).

---

## 37. Machine API surface (`/api/v1`)

A versioned, non-localized REST API for machine clients (CLIs, scripts,
service integrations), authenticated by machine credentials instead of
session cookies. It ships **disabled by default** — the two paths are
gated by `API_KEYS_ENABLED` and `API_JWT_ENABLED` (§8) — and is fully
documented in [docs/api-and-cli-guide.md](docs/api-and-cli-guide.md) and
[docs/design-api-keys-and-tokens.md](docs/design-api-keys-and-tokens.md).

### 37.1 Credentials & auth

- **API keys**: `drk_<env>_<32 base62 chars>` (~190 bits entropy). Only a
  SHA-256 hash is stored (`app_api_keys.key_hash`); the plaintext is
  shown once at creation. A short display prefix (`drk_live_AbCd1234`,
  8 random chars) is stored for the UI.
- **JWT access tokens**: Ed25519 (EdDSA), minted at
  `POST /api/v1/auth/token` (OAuth2 `client_credentials` for OAuth
  clients, or an `api_key` grant). The public key is published at
  `GET /api/v1/jwks.json`. Tokens are stateless; early revocation uses
  the `app_revoked_tokens` (`jti`) list.
- **OAuth clients**: machine principals with `client_id` (`drkc_…`) and a
  hashed `client_secret` (`drkcsec_…`), in `app_oauth_clients`.
- Resolution order (api key → JWT → session cookie) and gating live in
  `src/lib/api-auth/resolve-caller.server.ts` and `v1-guard.server.ts`.

### 37.2 Authorization (scopes ∩ permissions)

A credential carries **scopes**, but its effective authority is the
**intersection** of its scopes with its owner's permissions
(`src/lib/api-auth/scopes.ts`) — a credential can never exceed its owner.
Scope strings are the 30 `admin.*` catalog keys plus four account scopes
(`account.read`, `account.profile.write`, `account.preferences.write`,
`account.apikeys.manage`).

### 37.3 Endpoints

| Route | Methods | Notes |
| --- | --- | --- |
| `POST /api/v1/auth/token` | POST | Exchange a credential for a JWT (public) |
| `GET /api/v1/jwks.json` | GET | Public JWKS (Ed25519) |
| `GET /api/v1/openapi.json` | GET | OpenAPI 3.1 document |
| `GET /api/v1/me` | GET | Caller identity + effective scopes |
| `GET,POST /api/v1/me/api-keys` | GET, POST | List / create the caller's own keys |
| `DELETE /api/v1/me/api-keys/{id}` | DELETE | Revoke own key |
| `POST /api/v1/me/api-keys/{id}/rotate` | POST | Rotate own key |
| `GET,POST /api/v1/users` | GET, POST | List / create users |
| `GET /api/v1/users/{id}` | GET | Read user (emits ETag) |
| `POST /api/v1/users/{id}/status` | POST | Status transition (`If-Match`/412) |
| `GET /api/v1/audit-events` | GET | Read audit log |
| `GET /api/v1/admin/api-keys` | GET | List all keys |
| `DELETE /api/v1/admin/api-keys/{id}` | DELETE | Revoke any key |
| `GET,POST /api/v1/admin/oauth-clients` | GET, POST | List / register clients |
| `GET,PATCH,DELETE /api/v1/admin/oauth-clients/{id}` | GET, PATCH, DELETE | Read / edit / revoke a client |
| `POST /api/v1/admin/oauth-clients/{id}/rotate-secret` | POST | Rotate a client secret |

Errors use `application/problem+json` (`type`, `title`, `status`, `code`,
optional `detail`, `requestId`) from `src/lib/api-auth/problem.ts`.

---

## 38. Source references for implementation alignment

Implementation must verify exact API names against installed package versions.

- Better Auth installation: https://www.better-auth.com/docs/installation
- Better Auth Next.js integration: https://better-auth.com/docs/integrations/next
- Better Auth database concepts: https://www.better-auth.com/docs/concepts/database
- Better Auth PostgreSQL adapter: https://better-auth.com/docs/adapters/postgresql
- Better Auth Kysely / relational database support: https://better-auth.com/docs/adapters/other-relational-databases
- Better Auth email/password: https://www.better-auth.com/docs/authentication/email-password
- Better Auth OAuth/social sign-in: https://better-auth.com/docs/concepts/oauth
- Better Auth Microsoft provider: https://better-auth.com/docs/authentication/microsoft
- Better Auth GitHub provider: https://www.better-auth.com/docs/authentication/github
- Better Auth users and account linking: https://better-auth.com/docs/concepts/users-accounts
- Better Auth session management: https://better-auth.com/docs/concepts/session-management
- Next.js App Router: https://nextjs.org/docs/app
- Next.js Route Handlers: https://nextjs.org/docs/app/getting-started/route-handlers
- Next.js Proxy: https://nextjs.org/docs/app/getting-started/proxy
- Next.js 16 upgrade guide: https://nextjs.org/docs/app/guides/upgrading/version-16
- Next.js internationalization: https://nextjs.org/docs/app/guides/internationalization
- next-intl App Router: https://next-intl.dev/docs/getting-started/app-router
- shadcn/ui: https://ui.shadcn.com
- shadcn/ui Theming: https://ui.shadcn.com/docs/theming
- shadcn/ui Sheet: https://ui.shadcn.com/docs/components/sheet
- shadcn/ui Skeleton: https://ui.shadcn.com/docs/components/skeleton
- Tailwind CSS theme variables: https://tailwindcss.com/docs/theme
- Zustand persist middleware: https://zustand.docs.pmnd.rs/integrations/persisting-store-data
- MDN Intl.DateTimeFormat: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
- Vitest coverage: https://vitest.dev/guide/coverage.html
- Testing Library React: https://testing-library.com/docs/react-testing-library/intro/
- Playwright: https://playwright.dev/docs/intro
- axe-core Playwright: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
- WCAG overview: https://www.w3.org/WAI/standards-guidelines/wcag/
- Better Auth password reset: https://www.better-auth.com/docs/authentication/email-password#forget-password
- Better Auth plugins (server-only endpoints): https://www.better-auth.com/docs/concepts/plugins
- Resend send email API: https://resend.com/docs/api-reference/emails/send-email
- Mailgun send API: https://documentation.mailgun.com/docs/mailgun/api-reference/send/
