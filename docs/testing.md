# Testing

_Audience: developers and QA. The test strategy, how to run each suite, the coverage ratchet, and a manual QA checklist._

---

## 1. Strategy

The suite is layered, with **security and tenant-isolation invariants treated as first-class tests**:

| Layer | Tool | Location | Focus |
| --- | --- | --- | --- |
| **Unit** | Vitest | `tests/unit` (~63 files) | Pure logic, guards, scope primitives, permission resolution, and **invariant tests** (route scope, rate-limit, locale parity, catalog count). |
| **Component** | Vitest + Testing Library (jsdom) | `tests/component` (~28 files) | Client React components (grids, forms, comboboxes) rendered against real primitives. |
| **Integration** | Vitest + mocked DB/auth | `tests/integration` (~34 files) | Route handlers end-to-end at the HTTP boundary (auth, validation, scoping, audit). |
| **Security** | Vitest | `tests/security` (~12 files) | Cross-tenant isolation, privilege-escalation guards, secret handling. |
| **E2E** | Playwright | `tests/e2e` (`.spec.ts`) | Full browser flows against a running, seeded app. |
| **Accessibility** | Playwright + axe-core | `tests/accessibility` (`.spec.ts`) | WCAG checks on key screens. |
| Shared helpers / setup | — | `tests/helpers`, `tests/setup` | Render harness, factories, jsdom polyfills. |

## 2. Frameworks

- **Vitest 4** — unit/component/integration/security; coverage via `@vitest/coverage-v8`.
- **Testing Library** (`@testing-library/react`, `user-event`, `jest-dom`) for component tests in **jsdom**.
- **Playwright 1.59** + **axe-core** for browser e2e and accessibility.
- **MSW** and **supertest** are available for HTTP mocking/assertions.

## 3. Running tests

```bash
# Vitest suites
pnpm test            # sharded runner (scripts/test-shards.mjs) — the canonical way
pnpm test:unit       # vitest run tests/unit
pnpm test:component  # vitest run tests/component
pnpm test:integration
pnpm test:security
pnpm test:coverage   # full run WITH the coverage ratchet (what CI gates on)
pnpm test:serial     # plain `vitest run` (no sharding) — for debugging only

# Browser suites (need browsers + a running, seeded app)
pnpm test:e2e        # Playwright e2e
pnpm test:a11y       # Playwright + axe-core

# Everything (the full local gate)
pnpm test:all        # typecheck + lint + format:check + coverage + e2e + a11y
```

Run a single file or test:

```bash
pnpm exec vitest run tests/integration/groups.test.ts
pnpm exec vitest run tests/unit/admin-permissions.test.ts -t "catalog"
```

### Why the sharded runner

`pnpm test` runs Vitest in **independent shard processes** (`scripts/test-shards.mjs`). Within a single Vitest process, the SSR module runner can race on the shared transform server under this dependency graph (Better Auth + Kysely + pg + next-intl), producing spurious `"… is not a function"` failures. Each shard gets its own isolated transform server, which removes the race.

- Shard count: `min(6, max(1, floor(cpuCount / 2)))`, overridable with `TEST_SHARDS=N`.
- Each shard runs single-worker; output is buffered and printed on completion; any failed shard fails the run.

> If you see odd "not a function" errors from a plain `vitest run`, use `pnpm test` (sharded) instead.

## 4. Coverage (the ratchet)

`pnpm test:coverage` enforces global thresholds in `vitest.config.ts`:

| Metric | Threshold |
| --- | --- |
| Lines | 52% |
| Statements | 51% |
| Functions | 46% |
| Branches | 48% |

These are a **ratchet**: pinned just below the current measured values and meant to be **raised over time, never lowered**. A change that adds untested code and drops coverage below a floor fails CI even if every test passes — add tests to compensate.

> The **sharded runner does not compute coverage.** Reproduce the CI coverage gate locally with `pnpm test:coverage`. Page/layout files, generated files, and shadcn primitives are excluded from the gate (see the `exclude` list in `vitest.config.ts`).

## 5. Notable invariant tests

These encode project rules and will fail the build if violated:

| Test | Enforces |
| --- | --- |
| `tests/unit/admin-route-scope-invariant.test.ts` | Every `/api/administrator/**` route references a tenant-scope primitive. |
| Admin rate-limit invariant | Every admin mutation calls `enforceRateLimit`. |
| Locale message parity | Every text key exists in **all four** locales (`en`/`fr`/`es`/`uk`). |
| Permission catalog count | The `ADMIN_PERMISSION_CATALOG` has the expected number of keys (currently **35**). |

When you add a route, permission, or string, expect to update the corresponding invariant.

## 6. Test data

- Vitest unit/component/integration tests **mock** the database and auth layers (table-aware proxies, session/access mocks) — they do **not** need a live database.
- The Playwright suites need a **running, seeded app**. CI does this by migrating and running `pnpm db:seed` against the Postgres service, then `pnpm start`. Locally, mirror that: `pnpm db:reset:reload` (or migrate + seed), `pnpm build && pnpm start`, then run `pnpm test:e2e`.
- CI sets `AUTH_RATE_LIMIT_DISABLED=1` for the browser job so the suites don't trip Better Auth's sign-in rate limiter. Never set this on a real deployment.

## 7. Manual QA checklist

When automated coverage isn't enough (e.g. a visual or flow change), walk these:

**Authentication**
- [ ] Sign up → land on pending-approval; admin approves → can sign in.
- [ ] Sign in / sign out; session persists across reload.
- [ ] Forgot password → reset link → new password works.
- [ ] Social login (if enabled) for each configured provider.

**Tenancy & access**
- [ ] Org admin sees only their organization; out-of-scope ids return 404.
- [ ] Super admin sees all organizations.
- [ ] Switching active organization recalculates visible permissions.

**Administration**
- [ ] Create org, user, role (assign permissions), group (bundle roles, add members).
- [ ] Bulk action on users (approve/block) behaves and is audited.
- [ ] CSV export downloads and respects the row cap.
- [ ] Each admin action appears in the audit log with a matching `x-request-id`.

**Platform**
- [ ] SSO launch→consume into a registered app.
- [ ] Mint an API key/token and call `/api/v1/me`.
- [ ] Switch UI language to `fr`/`es`/`uk`; no missing strings.
- [ ] Email: trigger a reset; confirm the outbox row (and delivery if a provider is set).

**Accessibility / responsiveness**
- [ ] Keyboard navigation through forms and the admin grid.
- [ ] Dark mode and small-viewport layouts render correctly.

---

_Next: [Troubleshooting](./troubleshooting.md)_
