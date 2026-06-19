# Troubleshooting

_Audience: all technical users. Common failures during setup, build, runtime, and deployment — with fixes and where to look._

---

## Where to look first

| Source | What it tells you |
| --- | --- |
| `pnpm dev` / `pnpm start` terminal | Server component & route-handler errors, boot validation failures. |
| `app_audit_events` table | Whether the app processed an action, and the outcome (filter by `request_id`). |
| `x-request-id` response header | Correlation id — grep audit rows (and Sentry, if enabled) for it. |
| `app_outbox` table | Email status (`pending` / `sent` / `failed` / `logged`). |
| Browser devtools console/network | Client errors, failed `/api/**` calls, the status code and error envelope. |
| Sentry (if enabled) | Stack traces with the same `x-request-id`. |
| CI logs (GitHub Actions) | Build/test failures with the failing step. |

---

## Setup & install

**`pnpm install` fails or uses the wrong pnpm.**
Enable Corepack so the pinned version is used: `corepack enable`, then `pnpm install`. The project pins `pnpm@10.33.2`.

**`pnpm install` integrity/lockfile errors.**
Use `pnpm install --frozen-lockfile` (as CI does). If the lockfile is genuinely out of date, update dependencies in a dedicated change.

**Node version errors.**
Use Node 22 (what CI runs). There is no `.nvmrc`/`engines` pin yet (`TODO:`), so set it via your version manager.

**Postgres won't start / port conflict.**
`pnpm db:up` maps host port **5444** (not 5432). If 5444 is taken, stop the conflicting service or change the mapping in `docker-compose.yml` and `DATABASE_URL` together.

**App can't connect to the database.**
- Is `pnpm db:up` running and healthy? (`docker compose ps`)
- Does `DATABASE_URL` point at port 5444 with the right credentials (`devresponse:devresponse`)?
- Did you run the migrations (`pnpm db:auth:migrate && pnpm db:app:migrate`)?

**`psql` shows no tables / "relation does not exist".**
All tables live in the **`auth`** schema (default; set by `DB_SCHEMA`), not `public`. A plain `psql` session defaults to `public` and sees nothing. List them with `\dt auth.*`, or run `SET search_path = auth, public;` first. The app itself sets this automatically via the connection `search_path` — don't add `?schema=…` to `DATABASE_URL` (it's ignored). If you use a transaction-pooling pooler, the session `search_path` can be dropped — set it as a role default (`ALTER ROLE <app> SET search_path = auth, public;`).

**Boot fails with a secret/JWK error.**
A required secret is missing or malformed:
- `BETTER_AUTH_SECRET` and `SSO_HANDOFF_JWT_SECRET` must be set (and distinct).
- If `API_JWT_ENABLED=1`, `API_JWT_PRIVATE_KEY` must be a valid Ed25519 JWK JSON.
- If `EMAIL_PROVIDER` is set, its credentials must be present.

**Seed does nothing / "already exists".**
Seeds are idempotent. To start clean locally: `pnpm db:reset:reload`.

**`pnpm db:reset` "didn't reset anything".**
By design, `pnpm db:reset` is a **dry run** (lists what it would drop). Use `pnpm db:reset:reload` (or `pnpm db:reset --yes`) to actually drop. It also refuses to run against non-local hosts without `--force`.

---

## Build errors

**Type errors during `pnpm build` / `pnpm typecheck`.**
Strict TypeScript with `noUncheckedIndexedAccess` — indexed access yields `T | undefined`. Guard or assert. Fix all errors; the build must be clean.

**`format:check` fails in CI but the code "looks fine".**
Run `pnpm format` to auto-fix, then commit. Note that bracketed glob paths (e.g. `src/app/[locale]/**`) can silently match nothing in some shells — prefer letting `prettier .` / `pnpm format` handle the whole tree.

**Build log looks truncated / build seems to hang.**
Don't pipe `pnpm build` through `head`/`Select -First` — truncating its stdout can break the run. Redirect to a file instead: `pnpm build > build.log 2>&1`.

**Sentry-related build differences.**
The Sentry plugin only engages when `NEXT_PUBLIC_SENTRY_DSN` is set; source-map upload also needs `SENTRY_AUTH_TOKEN`. A build without these is unchanged — if you expected source maps, set the build-time secrets.

---

## Runtime errors

**Redirected to sign-in unexpectedly.**
The edge proxy redirects when no session cookie is present. Confirm `BETTER_AUTH_URL` matches the origin you're browsing, and that the session cookie is being set (check devtools → Application → Cookies).

**Stuck on "pending approval".**
Self-registered users start `pending_approval`. An admin must approve them (Administrator → Users), or seed an already-active account.

**`403` / `404` on an admin action you expected to succeed.**
Tenant scoping: a non-super-admin only sees their own organization, and **out-of-scope resources return 404 by design** (not 403). Confirm the actor's tier and the resource's organization.

**`429 Too Many Requests`.**
The per-actor rate limiter tripped (admin mutations, bulk ops, or export). Respect the `Retry-After` header. The limiter is in-memory and resets on restart; across multiple instances it's best-effort.

**Locale parity test or a missing translation.**
Every text key must exist in all four locale files. Add the key to `en.json` first, then `fr`/`es`/`uk`.

**Email not being delivered.**
With no `EMAIL_PROVIDER`, messages are recorded as `logged` and never sent — expected in dev. Set a provider and its credentials to deliver; check `app_outbox` for `failed` rows and the recorded error.

**SSO handoff fails.**
- The token is single-use and valid ≤60s — a reused or expired token is rejected.
- `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_AUDIENCE_PREFIX`, and `SSO_HANDOFF_JWT_SECRET` must match between hub and receiver; the receiver's `SSO_HANDOFF_APPLICATION_ID` must match the audience.
- The destination origin must fall under `SSO_ALLOWED_ORIGIN_SUFFIXES`.

**Machine API returns 401/403.**
- Is the path enabled? `API_KEYS_ENABLED` / `API_JWT_ENABLED` are **off by default**.
- Is the credential's scope sufficient, and is it within the owner's permissions? A credential can't exceed its creator.
- For JWTs, is the token unexpired and verifiable against `/api/v1/jwks.json`?

---

## Test failures

**Spurious "… is not a function" from Vitest.**
Use the sharded runner `pnpm test`, not a single `vitest run` — see [Testing → sharded runner](./testing.md#why-the-sharded-runner).

**Coverage gate fails though all tests pass.**
New untested code dropped global coverage below the ratchet. Add tests; reproduce locally with `pnpm test:coverage` (the sharded `pnpm test` does **not** compute coverage).

**Playwright suites fail to start.**
They need a built, running, seeded app and installed browsers: `pnpm playwright install --with-deps`, migrate + seed, `pnpm build && pnpm start`, then `pnpm test:e2e`. CI also sets `AUTH_RATE_LIMIT_DISABLED=1`.

---

## Deployment issues

**App up but every DB call fails on a serverless host.**
Use a **pooled** Postgres endpoint in `DATABASE_URL`; a direct connection can exhaust connections under serverless concurrency.

**Migrations not applied / schema missing.**
Run `pnpm db:auth:migrate && pnpm db:app:migrate` against the target **before** routing traffic. The migrate step **creates the `auth` schema** (or whatever `DB_SCHEMA` is set to) automatically and provisions every table into it — you don't create the schema by hand. The migrations are idempotent and safe to re-run.

**HSTS/headers not present or mixed-content warnings.**
Terminate TLS upstream; HSTS is inert over plain HTTP. Confirm the proxy forwards the headers emitted by `next.config.mjs`.

**Wrong client IP in rate limiting / logs behind a CDN.**
Set `TRUSTED_PROXY_COUNT` to your actual proxy depth so the client IP is read correctly from `X-Forwarded-For`.

**Rate limits behave inconsistently across instances.**
The limiter is in-process per instance, so the **supported 1.0 topology is a single application instance** (see [Deployment → Supported topology](./deployment.md#4-hosting-model)). Multi-instance deployments still run, but the rate limit is best-effort per instance until a shared (Redis/Postgres) backend lands post-1.0.

---

## Known risks & missing information

- **Hosting target is not defined in the repo** — choose Vercel vs. Node/container and document it (no app `Dockerfile` is provided). See [Deployment → Hosting model](./deployment.md#4-hosting-model).
- **No Node version pin** (`.nvmrc`/`engines`) — only CI evidences Node 22.
- **In-memory rate limiting** — not shared across instances; the supported 1.0 topology is a single application instance (see [Deployment → Supported topology](./deployment.md#4-hosting-model)). A shared backend for horizontal scale is planned post-1.0.
- **CSP is enforcing** (nonce-based, minted per request in `src/proxy.ts`). `script-src` allows only `'self' 'nonce-…' 'strict-dynamic'` — an injected inline `<script>` is blocked, not just reported. `style-src` deliberately keeps `'unsafe-inline'` (a nonce can't cover React's inline `style` attributes). Violations report to `/api/security/csp-report`.
- **`pgvector`/`vector` extension** is enabled locally; confirm whether production actually needs it (`pg_trgm` definitely is required).
- Some API request/response shapes were summarized from structure — verify against handlers or `/api/v1/openapi.json` (see [API → Gaps](./api.md#10-gaps--todo)).

If a problem isn't covered here, capture the `x-request-id` from the failing response and correlate it across the server logs, the `app_audit_events` table, and Sentry.

---

_Back to the [documentation index](./README.md)._
